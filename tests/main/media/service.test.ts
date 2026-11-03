/**
 * The media service: eligibility, storage, export and the restart path.
 *
 * These tests are about the rules a user feels: a chat model cannot be handed an
 * image job, a resolved job writes exactly one row and one file, an export asks
 * where to save, and a job interrupted by a restart is picked up rather than
 * orphaned.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCapabilities } from '@shared/capabilities';
import type { AppSettings } from '@shared/types';
import type { MediaJobAdapter, MediaJobOutcome } from '@shared/media-job';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { MediaStore } from '@main/media/store';
import { MediaServiceError, createMediaService, type MediaService } from '@main/media/service';
import { createFakeDatabase } from '../../helpers/fake-database';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(process.cwd(), '.work', 'test-runtime', 'media-service-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  service: MediaService;
  db: ReturnType<typeof createFakeDatabase>;
  store: MediaStore;
  adapter: {
    supportsCancel: boolean;
    maxConcurrent: number | null;
    submit(): Promise<MediaJobOutcome>;
    poll(): Promise<MediaJobOutcome>;
    cancel?(): Promise<void>;
  };
  exported: string | null;
  revealed: string[];
  saved: string[];
}

function harness(
  options: {
    outcome?: MediaJobOutcome;
    adapterPresent?: boolean;
    settings?: AppSettings;
    seedModels?: boolean;
  } = {},
): Harness {
  const db = createFakeDatabase({ now: () => '2026-11-03T00:00:00.000Z' });
  const store = new MediaStore({ rootDir: root });

  const provider = db.providers.create({
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });

  if (options.seedModels) {
    db.models.upsert({
      providerId: provider.id,
      modelId: 'chat-only',
      displayName: 'Chat only',
      capabilities: makeCapabilities({ chat: true, streaming: true }),
    });
  }

  const settings: AppSettings = options.settings ?? DEFAULT_SETTINGS;
  const saved: string[] = [];
  const revealed: string[] = [];
  let exported: string | null = null;

  const outcome: MediaJobOutcome = options.outcome ?? {
    kind: 'done',
    outputs: [{ bytes: PNG, mime: 'image/png', width: 1024, height: 1024 }],
    providerJobId: 'provider-1',
  };

  const adapter = {
    supportsCancel: true,
    maxConcurrent: null,
    async submit() {
      return outcome;
    },
    async poll() {
      return outcome;
    },
    async cancel() {
      return;
    },
  } satisfies MediaJobAdapter;

  const service = createMediaService({
    db,
    store,
    adapterFor: () => (options.adapterPresent === false ? null : (adapter as MediaJobAdapter)),
    settings: () => settings,
    dialogs: {
      async chooseExportPath(suggested) {
        exported = path.join(root, 'exported', suggested);
        // A real save dialog only ever returns a path in an existing folder.
        mkdirSync(path.dirname(exported), { recursive: true });
        return exported;
      },
      revealInFolder(absolute) {
        revealed.push(absolute);
      },
    },
    logger: {
      info: (message) => void saved.push(message),
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => new Date('2026-11-03T00:00:00.000Z'),
    tickIntervalMs: 10_000,
  });

  return { service, db, store, adapter, exported, revealed, saved };
}

describe('media service — eligibility', () => {
  it('refuses a model that does not declare image generation', async () => {
    const h = harness({ seedModels: true });
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({
        task: 'image',
        prompt: 'A heron',
        providerId: provider?.id,
        modelId: 'chat-only',
      }),
    ).rejects.toBeInstanceOf(MediaServiceError);
  });

  it('refuses when nothing can run the task, with a sentence that says what to do', async () => {
    const h = harness();
    await expect(h.service.generate({ task: 'video', prompt: 'A river' })).rejects.toThrow(
      /No model is registered for video generation/i,
    );
  });

  it('resolves a built-in image model from the dated hint list', async () => {
    const h = harness();
    const provider = h.db.providers.list()[0];
    const { jobId } = await h.service.generate({
      task: 'image',
      prompt: 'A heron',
      providerId: provider?.id,
      modelId: 'gpt-image-2',
    });
    expect(jobId).toBeTruthy();
    expect(h.service.jobs()[0]?.modelId).toBe('gpt-image-2');
  });

  it('refuses a provider that has no adapter in this build', async () => {
    const h = harness({ adapterPresent: false });
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({ task: 'image', prompt: 'A heron', providerId: provider?.id, modelId: 'gpt-image-2' }),
    ).rejects.toThrow(/does not have a generation adapter/i);
  });

  it('refuses an empty prompt and one over the documented ceiling', async () => {
    const h = harness();
    await expect(h.service.generate({ task: 'image', prompt: '   ' })).rejects.toThrow(/prompt is required/i);
    await expect(h.service.generate({ task: 'image', prompt: 'x'.repeat(40_000) })).rejects.toThrow(
      /longer than/i,
    );
  });
});

describe('media service — storage', () => {
  it('writes one file and one row for a completed generation', async () => {
    const h = harness();
    const provider = h.db.providers.list()[0];
    const { jobId } = await h.service.generate({
      task: 'image',
      prompt: 'A heron at dawn',
      providerId: provider?.id,
      modelId: 'gpt-image-2',
    });

    // The enqueue kicks one tick; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const job = h.service.jobs().find((entry) => entry.id === jobId);
    expect(job?.status).toBe('succeeded');

    const media = h.service.list();
    expect(media).toHaveLength(1);
    expect(media[0]?.sha256).toBe(PNG_SHA);
    expect(media[0]?.prompt).toBe('A heron at dawn');
    expect(media[0]?.width).toBe(1024);

    const absolute = h.store.resolve(media[0]?.relativePath ?? '');
    expect(readFileSync(absolute).equals(Buffer.from(PNG))).toBe(true);
  });

  it('removes the file and the row together, and reports a missing one', () => {
    const h = harness();
    const row = h.db.media.insert({
      kind: 'image',
      providerId: 'p',
      modelId: 'm',
      prompt: 'p',
      params: {},
      bytes: PNG.byteLength,
      sha256: PNG_SHA,
      mime: 'image/png',
      relativePath: `${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`,
    });
    h.store.save(PNG, 'image/png', 'image');

    expect(h.service.remove(row.id)).toBe(true);
    expect(h.service.get(row.id)).toBeNull();
    expect(h.store.exists(row.relativePath)).toBe(false);
    expect(h.service.remove(row.id)).toBe(false);
  });
});

describe('media service — export and reveal', () => {
  it('exports through a chosen path and refuses an unknown id', async () => {
    const h = harness();
    const row = h.db.media.insert({
      kind: 'image',
      providerId: 'p',
      modelId: 'm',
      prompt: 'p',
      params: {},
      bytes: PNG.byteLength,
      sha256: PNG_SHA,
      mime: 'image/png',
      relativePath: `${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`,
    });
    const stored = h.store.save(PNG, 'image/png', 'image');
    expect(stored.relativePath).toBe(row.relativePath);

    const exportedPath = await h.service.exportTo(row.id);
    expect(exportedPath).toBeTruthy();
    expect(readFileSync(exportedPath ?? '').equals(Buffer.from(PNG))).toBe(true);

    await expect(h.service.exportTo('missing')).rejects.toBeInstanceOf(MediaServiceError);
  });

  it('reveals the resolved absolute path, never a relative one', () => {
    const h = harness();
    const row = h.db.media.insert({
      kind: 'image',
      providerId: 'p',
      modelId: 'm',
      prompt: 'p',
      params: {},
      bytes: PNG.byteLength,
      sha256: PNG_SHA,
      mime: 'image/png',
      relativePath: `${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`,
    });
    h.store.save(PNG, 'image/png', 'image');
    expect(h.service.reveal(row.id)).toBe(true);
    expect(h.revealed[0]).toBe(path.resolve(h.store.rootDir, row.relativePath));
  });
});

describe('media service — lifecycle', () => {
  it('does not submit the same job twice when ticks overlap', async () => {
    let submits = 0;
    const db = createFakeDatabase({ now: () => '2026-11-03T00:00:00.000Z' });
    const store = new MediaStore({ rootDir: root });
    const provider = db.providers.create({
      kind: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    const slow: MediaJobAdapter = {
      supportsCancel: false,
      maxConcurrent: null,
      async submit() {
        submits += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { kind: 'pending', remoteId: 'r-1', pollUrl: null, progress: 10 };
      },
      async poll() {
        return { kind: 'pending', remoteId: 'r-1', pollUrl: null, progress: 20 };
      },
    };
    const service = createMediaService({
      db,
      store,
      adapterFor: () => slow,
      settings: () => DEFAULT_SETTINGS,
      dialogs: { chooseExportPath: async () => null, revealInFolder: () => undefined },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date('2026-11-03T00:00:00.000Z'),
    });
    db.generationJobs.insert({
      task: 'image',
      providerId: provider.id,
      modelId: 'gpt-image-2',
      prompt: 'p',
      params: {},
    });

    // Two ticks started together must produce one submit, not two.
    await Promise.all([service.tick(), service.tick()]);
    expect(submits).toBe(1);
    service.dispose();
  });

  it('resumes an interrupted job and writes exactly one row', async () => {
    const h = harness({
      outcome: { kind: 'done', outputs: [{ bytes: PNG, mime: 'image/png' }], providerJobId: null },
    });
    const provider = h.db.providers.list()[0];
    // A job left running by a previous process, with its poll overdue.
    h.db.generationJobs.insert({
      task: 'image',
      providerId: provider?.id ?? 'p',
      modelId: 'gpt-image-2',
      prompt: 'interrupted',
      params: {},
    });
    const job = h.db.generationJobs.listRecent()[0];
    if (job) {
      h.db.generationJobs.update(job.id, {
        status: 'running',
        remoteId: 'remote-1',
        nextPollAt: '2026-11-02T00:00:00.000Z',
      });
    }

    const summary = await h.service.resume();
    expect(summary.polled + summary.succeeded).toBeGreaterThan(0);
    expect(h.service.list()).toHaveLength(1);
  });

  it('cancels a queued job and refuses a finished one', async () => {
    const h = harness({
      outcome: { kind: 'pending', remoteId: 'r-1', pollUrl: null, progress: 1 },
    });
    const provider = h.db.providers.list()[0];
    const { jobId } = await h.service.generate({
      task: 'image',
      prompt: 'slower please',
      providerId: provider?.id,
      modelId: 'gpt-image-2',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await h.service.cancel(jobId)).toBe(true);
    expect(await h.service.cancel(jobId)).toBe(false);
  });
});
