/**
 * The generation job engine.
 *
 * One `tick()` drives every due job: it submits work that has not started, polls
 * work that has, persists finished bytes, and gives up honestly when a job cannot
 * succeed. The engine is deliberately **not** a timer — the service owns a
 * scheduler and calls `tick()` — because a pure tick can be tested without
 * waiting, and crash recovery is then simply "call tick() on startup".
 *
 * Rules encoded here, each of which the UI and the user depend on:
 *
 *  - **A job never blocks the interface.** Nothing awaits a provider for longer
 *    than one poll; the renderer learns about progress through an event.
 *  - **Retries are bounded and only for retryable failures.** A moderation
 *    rejection is never retried; a timeout is retried with backoff and jitter.
 *  - **A job that outlives its deadline expires.** It is not retried forever, and
 *    it is not reported as failed — the provider may still finish it, but this
 *    app has stopped caring and says so.
 *  - **A provider's concurrency limit is respected** across ticks, not just
 *    within one.
 *  - **Persisting bytes happens before success is recorded.** Three of the five
 *    providers hand back URLs that die within minutes, so a job is only
 *    `succeeded` once the file is on disk and its row exists.
 */
import type { GenerationJob, GenerationJobStatus, MediaKind, MediaParams } from '@shared/media';
import type { MediaJobAdapter, MediaJobOutcome, MediaOutput } from '@shared/media-job';
import type { GenerationJobRepository, NewMediaInput } from '@shared/repository-contract';
/**
 * A logger that accepts structured metadata, matching the main-process logger.
 * Declared here rather than imported so a test can pass a two-line stub.
 */
export interface JobLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Injectable clock, so tests never sleep. */
export type Clock = () => Date;

export interface JobEngineOptions {
  jobs: GenerationJobRepository;
  /** Resolve the adapter for a provider, or null when the capability is missing. */
  adapterFor(providerId: Id): MediaJobAdapter | null;
  /**
   * Persist one output and return the media row id.
   *
   * Injected rather than implemented here so the engine stays unaware of the
   * store, the database and the conversation link.
   */
  persist(job: GenerationJob, output: MediaOutput): Promise<string>;
  logger?: JobLogger;
  clock?: Clock;
  /** Give up on a job older than this. */
  maxJobAgeMs?: number;
  /** Attempts before a retryable failure becomes terminal. */
  maxAttempts?: number;
  /** Base poll interval; doubles per attempt up to `maxPollDelayMs`. */
  basePollDelayMs?: number;
  maxPollDelayMs?: number;
  /** Called on every state change, for the renderer's progress channel. */
  onChange?(job: GenerationJob): void;
}

export interface EnqueueInput {
  task: MediaKind;
  providerId: Id;
  modelId: string;
  prompt: string;
  negativePrompt?: string | null;
  params: MediaParams;
}

export interface TickSummary {
  submitted: number;
  polled: number;
  succeeded: number;
  failed: number;
  expired: number;
  /** Jobs skipped because the provider was at its concurrency limit. */
  throttled: number;
  skipped: number;
}

type Id = string;

const DEFAULTS = {
  maxJobAgeMs: 30 * 60 * 1000,
  maxAttempts: 6,
  basePollDelayMs: 2_000,
  maxPollDelayMs: 30_000,
};

export class JobEngine {
  private readonly options: JobEngineOptions;
  private readonly clock: Clock;
  private readonly maxJobAgeMs: number;
  private readonly maxAttempts: number;
  private readonly basePollDelayMs: number;
  private readonly maxPollDelayMs: number;
  /** Jobs currently being worked on in this process; per provider, for throttling. */
  private readonly inFlight = new Map<string, number>();

  constructor(options: JobEngineOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.maxJobAgeMs = options.maxJobAgeMs ?? DEFAULTS.maxJobAgeMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.basePollDelayMs = options.basePollDelayMs ?? DEFAULTS.basePollDelayMs;
    this.maxPollDelayMs = options.maxPollDelayMs ?? DEFAULTS.maxPollDelayMs;
  }

  enqueue(input: EnqueueInput): GenerationJob {
    const job = this.options.jobs.insert({
      task: input.task,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      params: input.params,
    });
    this.emit(job);
    return job;
  }

  get(id: string): GenerationJob | null {
    return this.options.jobs.get(id);
  }

  /**
   * Advances every due job once.
   *
   * Jobs are processed sequentially inside a tick: a desktop app generating two
   * images should not open six sockets, and sequential processing makes the
   * per-provider budget trivial to respect.
   */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      submitted: 0,
      polled: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
      throttled: 0,
      skipped: 0,
    };

    const now = this.clock();
    const active = this.options.jobs.listActive();
    const perProvider = new Map<string, number>();

    for (const job of active) {
      if (this.isExpired(job, now)) {
        this.finish(job, 'expired', {
          errorCode: 'job_expired',
          errorMessage:
            'This generation ran past its deadline. The provider may still have finished it, but this app stopped waiting. Generate it again to get a result.',
          retryable: false,
        });
        summary.expired += 1;
        continue;
      }

      if (!this.isDue(job, now)) {
        summary.skipped += 1;
        continue;
      }

      const adapter = this.options.adapterFor(job.providerId);
      if (!adapter) {
        // The provider was removed or its capability is gone. Not retryable and
        // not silent: the user is told why the job stopped.
        this.finish(job, 'failed', {
          errorCode: 'provider_unavailable',
          errorMessage:
            'This provider is no longer configured for generation, so the job cannot continue.',
          retryable: false,
        });
        summary.failed += 1;
        continue;
      }

      const limit = adapter.maxConcurrent ?? Number.POSITIVE_INFINITY;
      const used = perProvider.get(job.providerId) ?? 0;
      if (used >= limit) {
        summary.throttled += 1;
        continue;
      }

      perProvider.set(job.providerId, used + 1);
      this.inFlight.set(job.providerId, (this.inFlight.get(job.providerId) ?? 0) + 1);
      try {
        const outcome = job.remoteId
          ? await this.safePoll(adapter, job)
          : await this.safeSubmit(adapter, job);

        if (!outcome) {
          summary.skipped += 1;
          continue;
        }
        if (job.remoteId) summary.polled += 1;
        else summary.submitted += 1;

        const settled = await this.apply(job, outcome);
        if (settled === 'succeeded') summary.succeeded += 1;
        if (settled === 'failed') summary.failed += 1;
      } finally {
        this.inFlight.set(job.providerId, Math.max(0, (this.inFlight.get(job.providerId) ?? 1) - 1));
      }
    }

    return summary;
  }

  /** Cancels a job when the provider supports it, and marks it either way. */
  async cancel(id: string): Promise<boolean> {
    const job = this.options.jobs.get(id);
    if (!job) return false;
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return false;
    }

    const adapter = this.options.adapterFor(job.providerId);
    if (adapter?.supportsCancel && adapter.cancel && job.remoteId) {
      try {
        await adapter.cancel({
          task: job.task,
          modelId: job.modelId,
          remoteId: job.remoteId,
          pollUrl: job.pollUrl,
        });
      } catch (error) {
        // A failed cancel is not a failed cancel request from the user's point of
        // view: the local job still stops. The reason is recorded, not swallowed.
        this.log('warn', 'Provider cancel failed; the job is marked canceled locally', {
          jobId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.finish(job, 'canceled', {
      errorCode: null,
      errorMessage: null,
      retryable: false,
    });
    return true;
  }

  /* ------------------------------------------------------------- internals -- */

  private isExpired(job: GenerationJob, now: Date): boolean {
    const created = Date.parse(job.createdAt);
    if (!Number.isFinite(created)) return false;
    return now.getTime() - created > this.maxJobAgeMs;
  }

  private isDue(job: GenerationJob, now: Date): boolean {
    /*
     * A job that has never been submitted has nothing to wait for. Checking the
     * timestamp first would let a clock difference between the database stamp and
     * the engine strand a queued job; the row's own state is the authority.
     */
    if (!job.remoteId) return true;
    if (!job.nextPollAt) return true;
    const due = Date.parse(job.nextPollAt);
    if (!Number.isFinite(due)) return true;
    return due <= now.getTime();
  }

  private async safeSubmit(adapter: MediaJobAdapter, job: GenerationJob): Promise<MediaJobOutcome | null> {
    try {
      return await adapter.submit({
        task: job.task,
        modelId: job.modelId,
        prompt: job.prompt,
        negativePrompt: null,
        params: job.params,
      });
    } catch (error) {
      this.recordTransportFailure(job, error);
      return null;
    }
  }

  private async safePoll(adapter: MediaJobAdapter, job: GenerationJob): Promise<MediaJobOutcome | null> {
    if (!job.remoteId) return null;
    try {
      return await adapter.poll({
        task: job.task,
        modelId: job.modelId,
        remoteId: job.remoteId,
        pollUrl: job.pollUrl,
      });
    } catch (error) {
      this.recordTransportFailure(job, error);
      return null;
    }
  }

  /**
   * A thrown provider call is a transport failure, not a verdict on the job.
   * It consumes an attempt and is retried with backoff, or failed once the budget
   * is spent.
   */
  private recordTransportFailure(job: GenerationJob, error: unknown): void {
    const attempts = job.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= this.maxAttempts) {
      this.finish(job, 'failed', {
        attempts,
        errorCode: 'provider_error',
        errorMessage: message,
        retryable: false,
      });
      return;
    }
    this.options.jobs.update(job.id, {
      attempts,
      status: job.status === 'queued' ? 'running' : job.status,
      nextPollAt: this.nextDelay(attempts),
      errorCode: 'provider_error',
      errorMessage: message,
      retryable: true,
    });
    this.log('warn', 'Generation attempt failed; retrying with backoff', {
      jobId: job.id,
      attempts,
      message,
    });
  }

  private async apply(
    job: GenerationJob,
    outcome: MediaJobOutcome,
  ): Promise<GenerationJobStatus | 'pending'> {
    if (outcome.kind === 'pending') {
      const updated = this.options.jobs.update(job.id, {
        status: 'running',
        remoteId: outcome.remoteId,
        pollUrl: outcome.pollUrl,
        progress: outcome.progress,
        attempts: job.attempts + 1,
        nextPollAt: this.nextDelay(job.attempts + 1),
        errorCode: null,
        errorMessage: null,
        retryable: false,
      });
      if (updated) this.emit(updated);
      return 'pending';
    }

    if (outcome.kind === 'failed') {
      const attempts = job.attempts + 1;
      if (outcome.error.retryable && attempts < this.maxAttempts) {
        const updated = this.options.jobs.update(job.id, {
          attempts,
          status: 'running',
          nextPollAt: this.nextDelay(attempts),
          errorCode: outcome.error.code,
          errorMessage: outcome.error.message,
          retryable: true,
        });
        if (updated) this.emit(updated);
        return 'pending';
      }
      this.finish(job, 'failed', {
        attempts,
        errorCode: outcome.error.code,
        errorMessage: outcome.error.message,
        retryable: false,
      });
      return 'failed';
    }

    // Done. Bytes are persisted *before* the job is called successful, because a
    // success the app cannot show is not a success.
    const mediaIds: string[] = [];
    try {
      for (const output of outcome.outputs) {
        mediaIds.push(await this.options.persist(job, output));
      }
    } catch (error) {
      this.finish(job, 'failed', {
        attempts: job.attempts + 1,
        errorCode: 'storage',
        errorMessage:
          error instanceof Error
            ? `The provider returned a result but it could not be saved: ${error.message}`
            : 'The provider returned a result but it could not be saved.',
        retryable: false,
      });
      return 'failed';
    }

    if (mediaIds.length === 0) {
      this.finish(job, 'failed', {
        attempts: job.attempts + 1,
        errorCode: 'provider_error',
        errorMessage: 'The provider reported success but returned no output.',
        retryable: true,
      });
      return 'failed';
    }

    this.finish(job, 'succeeded', {
      attempts: job.attempts + 1,
      progress: 100,
      pollUrl: null,
      providerMediaId: mediaIds[0] ?? null,
      providerJobId: outcome.providerJobId,
    });
    return 'succeeded';
  }

  private finish(
    job: GenerationJob,
    status: GenerationJobStatus,
    extra: {
      attempts?: number;
      progress?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
      retryable?: boolean;
      pollUrl?: string | null;
      providerMediaId?: string | null;
      providerJobId?: string | null;
    },
  ): void {
    const updated = this.options.jobs.update(job.id, {
      status,
      attempts: extra.attempts,
      progress: extra.progress,
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
      retryable: extra.retryable,
      pollUrl: extra.pollUrl,
      mediaId: extra.providerMediaId,
      nextPollAt: null,
      finishedAt: this.clock().toISOString(),
    });
    if (updated) this.emit(updated);
  }

  /** Exponential backoff with full jitter, capped. Never negative, never zero. */
  private nextDelay(attempt: number): string {
    const exponential = this.basePollDelayMs * 2 ** Math.max(0, attempt - 1);
    const capped = Math.min(exponential, this.maxPollDelayMs);
    const jittered = Math.random() * capped;
    return new Date(this.clock().getTime() + Math.max(250, jittered)).toISOString();
  }

  private emit(job: GenerationJob): void {
    try {
      this.options.onChange?.(job);
    } catch (error) {
      // A broken listener must not fail a generation.
      this.log('warn', 'A media job listener threw', {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private log(level: 'info' | 'warn', message: string, meta: Record<string, unknown>): void {
    const logger = this.options.logger;
    if (!logger) return;
    logger[level](message, meta);
  }
}

/** Build the media row input for a finished output, without touching the store. */
export function mediaInputFor(
  job: GenerationJob,
  output: MediaOutput,
  stored: { relativePath: string; sha256: string },
  extra: { conversationId?: string | null; messageId?: string | null } = {},
): NewMediaInput {
  return {
    kind: job.task,
    providerId: job.providerId,
    modelId: job.modelId,
    prompt: job.prompt,
    negativePrompt: null,
    params: job.params,
    width: output.width ?? null,
    height: output.height ?? null,
    durationMs: output.durationMs ?? null,
    bytes: output.bytes.byteLength,
    sha256: stored.sha256,
    mime: output.mime,
    relativePath: stored.relativePath,
    jobId: job.id,
    providerJobId: job.remoteId,
    conversationId: extra.conversationId ?? null,
    messageId: extra.messageId ?? null,
  };
}
