/**
 * The job engine, driven by a fake adapter and a controllable clock.
 *
 * Every test here is about a promise the engine makes to the user: it does not
 * block, it does not retry a rejection, it does not exceed a provider's limit, it
 * does not report success before the bytes are saved, and it stops waiting when a
 * job outlives its deadline.
 */
import { describe, expect, it } from 'vitest';
import type { GenerationJob } from '@shared/media';
import type { MediaOutput } from '@shared/media-job';
import type { MediaJobAdapter, MediaJobOutcome, PollMediaInput, SubmitMediaInput } from '@shared/media-job';
import { JobEngine, mediaInputFor } from '@main/media/jobs';
import { createFakeDatabase } from '../../helpers/fake-database';

const PNG: MediaOutput = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  mime: 'image/png',
  width: 1024,
  height: 1024,
};

interface Harness {
  engine: JobEngine;
  db: ReturnType<typeof createFakeDatabase>;
  advance(ms: number): void;
  now(): Date;
  persisted: { jobId: string; relativePath: string; sha256: string }[];
  adapter: FakeAdapter;
  events: GenerationJob[];
}

class FakeAdapter implements MediaJobAdapter {
  readonly supportsCancel: boolean;
  readonly maxConcurrent: number | null;
  submitCalls = 0;
  pollCalls = 0;
  cancelCalls = 0;
  private readonly submitOutcome: () => MediaJobOutcome;
  private readonly pollOutcomes: MediaJobOutcome[];

  constructor(options: {
    submit?: () => MediaJobOutcome;
    poll?: MediaJobOutcome[];
    supportsCancel?: boolean;
    maxConcurrent?: number | null;
  } = {}) {
    this.supportsCancel = options.supportsCancel ?? false;
    this.maxConcurrent = options.maxConcurrent ?? null;
    this.submitOutcome =
      options.submit ?? (() => ({ kind: 'pending', remoteId: 'remote-1', pollUrl: null, progress: 10 }));
    this.pollOutcomes = options.poll ?? [];
  }

  async submit(_input: SubmitMediaInput): Promise<MediaJobOutcome> {
    this.submitCalls += 1;
    return this.submitOutcome();
  }

  async poll(_input: PollMediaInput): Promise<MediaJobOutcome> {
    this.pollCalls += 1;
    return this.pollOutcomes.shift() ?? { kind: 'failed', error: { code: 'no_more', message: 'no more outcomes', retryable: false } };
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

function harness(options: {
  submit?: () => MediaJobOutcome;
  poll?: MediaJobOutcome[];
  supportsCancel?: boolean;
  maxConcurrent?: number | null;
  persistThrows?: boolean;
  maxAttempts?: number;
  maxJobAgeMs?: number;
} = {}): Harness {
  let current = new Date('2026-11-03T00:00:00.000Z');
  // The fake rows are stamped with the same clock the engine reads, so a test
  // never depends on wall-clock drift between the two.
  const db = createFakeDatabase({ now: () => current.toISOString() });
  const persisted: Harness['persisted'] = [];
  const events: GenerationJob[] = [];
  const adapter = new FakeAdapter(options);

  const engine = new JobEngine({
    jobs: db.generationJobs,
    adapterFor: () => adapter,
    persist: async (job, output) => {
      if (options.persistThrows) throw new Error('disk full');
      const relativePath = `${'ab'}/${'c'.repeat(64)}.png`;
      persisted.push({ jobId: job.id, relativePath, sha256: 'c'.repeat(64) });
      const row = db.media.insert(
        mediaInputFor(job, output, { relativePath, sha256: 'c'.repeat(64) }),
      );
      return row.id;
    },
    clock: () => current,
    maxAttempts: options.maxAttempts ?? 6,
    maxJobAgeMs: options.maxJobAgeMs,
    onChange: (job) => events.push(job),
  });

  return {
    engine,
    db,
    adapter,
    persisted,
    events,
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

const enqueue = (h: Harness) =>
  h.engine.enqueue({
    task: 'image',
    providerId: 'p-1',
    modelId: 'gpt-image-2',
    prompt: 'A heron at dawn',
    params: { size: '1024x1024' },
  });

describe('job engine — submission and polling', () => {
  it('submits a queued job and records the provider handle', async () => {
    const h = harness();
    const job = enqueue(h);

    const summary = await h.engine.tick();
    expect(summary.submitted).toBe(1);
    expect(h.adapter.submitCalls).toBe(1);

    const after = h.engine.get(job.id);
    expect(after?.status).toBe('running');
    expect(after?.remoteId).toBe('remote-1');
    expect(after?.attempts).toBe(1);
  });

  it('polls only after the backoff delay, and succeeds exactly once', async () => {
    const h = harness({
      poll: [{ kind: 'done', outputs: [PNG], providerJobId: 'provider-1' }],
    });
    const job = enqueue(h);
    await h.engine.tick();

    // Not due immediately: the engine scheduled a future poll.
    const notDue = await h.engine.tick();
    expect(notDue.polled).toBe(0);
    expect(notDue.skipped).toBe(1);
    expect(h.adapter.pollCalls).toBe(0);

    h.advance(60_000);
    const done = await h.engine.tick();
    expect(done.polled).toBe(1);
    expect(done.succeeded).toBe(1);

    const finished = h.engine.get(job.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.progress).toBe(100);
    expect(finished?.mediaId).toBeTruthy();

    // A second poll of a terminal job never happens.
    h.advance(60_000);
    const again = await h.engine.tick();
    expect(again.polled).toBe(0);
    expect(h.adapter.pollCalls).toBe(1);
  });

  it('persists bytes before calling the job successful', async () => {
    const h = harness({ poll: [{ kind: 'done', outputs: [PNG], providerJobId: null }] });
    const job = enqueue(h);
    await h.engine.tick();
    h.advance(60_000);
    await h.engine.tick();

    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.jobId).toBe(job.id);
    expect(h.db.media.list()).toHaveLength(1);
    expect(h.db.media.list()[0]?.sha256).toBe('c'.repeat(64));
  });

  it('fails the job when a result arrives but cannot be saved', async () => {
    const h = harness({
      poll: [{ kind: 'done', outputs: [PNG], providerJobId: null }],
      persistThrows: true,
    });
    const job = enqueue(h);
    await h.engine.tick();
    h.advance(60_000);
    const summary = await h.engine.tick();

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    const failed = h.engine.get(job.id);
    expect(failed?.status).toBe('failed');
    // The user is told the result existed but was not saved, and it is not retried
    // into an infinite loop of the same failure.
    expect(failed?.errorMessage).toMatch(/could not be saved/i);
    expect(failed?.retryable).toBe(false);
    expect(h.db.media.list()).toHaveLength(0);
  });

  it('handles a provider that answers synchronously', async () => {
    const h = harness({ submit: () => ({ kind: 'done', outputs: [PNG], providerJobId: 'sync-1' }) });
    const job = enqueue(h);
    const summary = await h.engine.tick();
    expect(summary.succeeded).toBe(1);
    expect(h.engine.get(job.id)?.status).toBe('succeeded');
  });

  it('records a provider failure with its retryability', async () => {
    const h = harness({
      submit: () => ({ kind: 'failed', error: { code: 'moderation_blocked', message: 'Blocked.', retryable: false } }),
    });
    const job = enqueue(h);
    const summary = await h.engine.tick();
    expect(summary.failed).toBe(1);
    const failed = h.engine.get(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('moderation_blocked');
    expect(failed?.retryable).toBe(false);
  });
});

describe('job engine — retry policy', () => {
  it('retries a retryable failure with backoff, then gives up at the budget', async () => {
    const h = harness({
      maxAttempts: 2,
      submit: () => ({ kind: 'failed', error: { code: 'rate_limited', message: '429', retryable: true } }),
    });
    const job = enqueue(h);

    const first = await h.engine.tick();
    expect(first.failed).toBe(0);
    expect(h.engine.get(job.id)?.status).toBe('running');
    expect(h.engine.get(job.id)?.retryable).toBe(true);

    h.advance(60_000);
    const second = await h.engine.tick();
    expect(second.failed).toBe(1);
    expect(h.engine.get(job.id)?.status).toBe('failed');
    expect(h.engine.get(job.id)?.retryable).toBe(false);
  });

  it('treats a thrown provider call as a transport failure, not a verdict', async () => {
    let attempts = 0;
    const h = harness();
    const db = h.db;
    let current = h.now();
    const engine = new JobEngine({
      jobs: db.generationJobs,
      adapterFor: () => ({
        supportsCancel: false,
        maxConcurrent: null,
        async submit() {
          attempts += 1;
          if (attempts === 1) throw new Error('socket hang up');
          return { kind: 'done', outputs: [PNG], providerJobId: null };
        },
        async poll() {
          throw new Error('not reached');
        },
      }) as MediaJobAdapter,
      persist: async (job, output) =>
        db.media.insert(
          mediaInputFor(job, output, { relativePath: `${'ab'}/${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64) }),
        ).id,
      clock: () => current,
      maxAttempts: 3,
    });

    const job = engine.enqueue({
      task: 'image',
      providerId: 'p-1',
      modelId: 'm',
      prompt: 'p',
      params: {},
    });

    const first = await engine.tick();
    expect(first.succeeded).toBe(0);
    expect(engine.get(job.id)?.status).toBe('running');
    expect(engine.get(job.id)?.errorCode).toBe('provider_error');

    current = new Date(current.getTime() + 60_000);
    const second = await engine.tick();
    expect(second.succeeded).toBe(1);
  });
});

describe('job engine — limits and cancellation', () => {
  it('respects a provider concurrency limit inside one tick', async () => {
    const h = harness({ maxConcurrent: 1 });
    enqueue(h);
    enqueue(h);
    enqueue(h);

    const summary = await h.engine.tick();
    expect(summary.submitted).toBe(1);
    expect(summary.throttled).toBe(2);
    expect(h.adapter.submitCalls).toBe(1);
  });

  it('cancels through the adapter only when the provider supports it', async () => {
    const h = harness({ supportsCancel: true });
    const job = enqueue(h);
    await h.engine.tick();
    expect(await h.engine.cancel(job.id)).toBe(true);
    expect(h.adapter.cancelCalls).toBe(1);
    expect(h.engine.get(job.id)?.status).toBe('canceled');
  });

  it('still cancels locally when the provider has no cancel operation', async () => {
    const h = harness({ supportsCancel: false });
    const job = enqueue(h);
    await h.engine.tick();
    expect(await h.engine.cancel(job.id)).toBe(true);
    expect(h.adapter.cancelCalls).toBe(0);
    expect(h.engine.get(job.id)?.status).toBe('canceled');
  });

  it('refuses to cancel a job that already finished', async () => {
    const h = harness({ submit: () => ({ kind: 'done', outputs: [PNG], providerJobId: null }) });
    const job = enqueue(h);
    await h.engine.tick();
    expect(await h.engine.cancel(job.id)).toBe(false);
    expect(h.engine.get(job.id)?.status).toBe('succeeded');
  });
});

describe('job engine — honesty about time and failure', () => {
  it('expires a job that outlives its deadline instead of polling forever', async () => {
    const h = harness({ maxJobAgeMs: 1_000 });
    const job = enqueue(h);
    await h.engine.tick();

    h.advance(5_000);
    const summary = await h.engine.tick();
    expect(summary.expired).toBe(1);
    const expired = h.engine.get(job.id);
    expect(expired?.status).toBe('expired');
    // Expired is not failed: the message says the provider may have finished it.
    expect(expired?.errorMessage).toMatch(/stopped waiting/i);
    expect(expired?.retryable).toBe(false);
  });

  it('fails a job whose provider is no longer configured, with a reason', async () => {
    const db = createFakeDatabase();
    const engine = new JobEngine({
      jobs: db.generationJobs,
      adapterFor: () => null,
      persist: async () => 'unused',
    });
    const job = engine.enqueue({ task: 'video', providerId: 'gone', modelId: 'm', prompt: 'p', params: {} });
    const summary = await engine.tick();
    expect(summary.failed).toBe(1);
    expect(engine.get(job.id)?.errorCode).toBe('provider_unavailable');
  });

  it('recovers an interrupted job on the next tick — the restart path', async () => {
    const h = harness({ poll: [{ kind: 'done', outputs: [PNG], providerJobId: null }] });
    const job = enqueue(h);
    await h.engine.tick();

    // Simulate a restart: a brand-new engine over the same database.
    const db = h.db;
    const restarted = new JobEngine({
      jobs: db.generationJobs,
      adapterFor: () => h.adapter,
      persist: async (j, output) =>
        db.media.insert(
          mediaInputFor(j, output, { relativePath: `${'ab'}/${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64) }),
        ).id,
      clock: () => new Date(new Date(h.engine.get(job.id)?.nextPollAt ?? Date.now()).getTime()),
    });

    const summary = await restarted.tick();
    expect(summary.polled).toBe(1);
    expect(summary.succeeded).toBe(1);
    // Exactly one media row: the resume did not duplicate the work.
    expect(db.media.list()).toHaveLength(1);
  });

  it('emits an event for every state change so the UI can show progress', async () => {
    const h = harness({ poll: [{ kind: 'done', outputs: [PNG], providerJobId: null }] });
    enqueue(h);
    await h.engine.tick();
    h.advance(60_000);
    await h.engine.tick();

    expect(h.events.length).toBeGreaterThanOrEqual(3);
    expect(h.events.map((job) => job.status)).toContain('running');
    expect(h.events.map((job) => job.status)).toContain('succeeded');
  });
});
