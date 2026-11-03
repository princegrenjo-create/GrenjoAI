/**
 * Reference images and conversation links — the two things that make a generated
 * image belong somewhere and make image editing possible.
 *
 * The interesting failure is not "it works"; it is what happens when a reference
 * has been deleted, when a video is offered as a reference, or when a result
 * completes after a restart: the row must still know which conversation asked for
 * it, and the adapter must receive bytes that came from the store rather than from
 * whatever the renderer claimed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCapabilities } from '@shared/capabilities';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import type { MediaJobAdapter, MediaJobOutcome, SubmitMediaInput } from '@shared/media-job';
import { MediaStore } from '@main/media/store';
import { createMediaService, type MediaService } from '@main/media/service';
import { createFakeDatabase } from '../../helpers/fake-database';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const DERIVED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02, 0x03]);

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(process.cwd(), '.work', 'test-runtime', 'media-refs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  service: MediaService;
  db: ReturnType<typeof createFakeDatabase>;
  store: MediaStore;
  submitted: SubmitMediaInput[];
}

function harness(): Harness {
  const db = createFakeDatabase({ now: () => '2026-11-03T00:00:00.000Z' });
  const store = new MediaStore({ rootDir: root });
  const submitted: SubmitMediaInput[] = [];

  const provider = db.providers.create({
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });
  db.models.upsert({
    providerId: provider.id,
    modelId: 'image-editor',
    displayName: 'Image editor',
    capabilities: makeCapabilities({ imageOutput: true, imageEditing: true }),
  });

  const adapter: MediaJobAdapter = {
    supportsCancel: false,
    maxConcurrent: null,
    async submit(input) {
      submitted.push(input);
      const outcome: MediaJobOutcome = {
        kind: 'done',
        outputs: [{ bytes: DERIVED, mime: 'image/png', width: 512, height: 512 }],
        providerJobId: null,
      };
      return outcome;
    },
    async poll() {
      return { kind: 'failed', error: { code: 'x', message: 'not polled', retryable: false } };
    },
  };

  const service = createMediaService({
    db,
    store,
    adapterFor: () => adapter,
    settings: () => DEFAULT_SETTINGS,
    dialogs: { chooseExportPath: async () => null, revealInFolder: () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date('2026-11-03T00:00:00.000Z'),
  });

  return { service, db, store, submitted };
}

/** A media row plus the file it points at, exactly as the store writes them. */
function seedImage(h: Harness, kind: 'image' | 'video' = 'image') {
  const mime = kind === 'image' ? 'image/png' : 'video/mp4';
  const stored = h.store.save(PNG, mime, kind);
  return h.db.media.insert({
    kind,
    providerId: 'p-1',
    modelId: 'seed',
    prompt: 'seed',
    params: {},
    bytes: PNG.byteLength,
    sha256: stored.sha256,
    mime,
    relativePath: stored.relativePath,
  });
}

describe('references', () => {
  it('passes reference bytes from the store to the adapter', async () => {
    const h = harness();
    const reference = seedImage(h);
    const provider = h.db.providers.list()[0];

    await h.service.generate({
      task: 'image',
      prompt: 'Make it snow',
      providerId: provider?.id,
      modelId: 'image-editor',
      referenceMediaIds: [reference.id],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(h.submitted).toHaveLength(1);
    const sent = h.submitted[0];
    expect(sent?.references).toHaveLength(1);
    // The bytes are the file the store holds, not something the caller supplied.
    expect(Buffer.from(sent?.references?.[0]?.bytes ?? []).equals(Buffer.from(PNG))).toBe(true);
    expect(sent?.references?.[0]?.mime).toBe('image/png');
  });

  it('refuses a reference that no longer exists', async () => {
    const h = harness();
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({
        task: 'image',
        prompt: 'x',
        providerId: provider?.id,
        modelId: 'image-editor',
        referenceMediaIds: ['deleted-id'],
      }),
    ).rejects.toThrow(/no longer exists/i);
    expect(h.submitted).toHaveLength(0);
  });

  it('refuses a video as a reference', async () => {
    const h = harness();
    const video = seedImage(h, 'video');
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({
        task: 'image',
        prompt: 'x',
        providerId: provider?.id,
        modelId: 'image-editor',
        referenceMediaIds: [video.id],
      }),
    ).rejects.toThrow(/Only images/i);
  });

  it('refuses a mask without a reference to apply it to', async () => {
    const h = harness();
    const mask = seedImage(h);
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({
        task: 'image',
        prompt: 'x',
        providerId: provider?.id,
        modelId: 'image-editor',
        maskMediaId: mask.id,
      }),
    ).rejects.toThrow(/mask needs at least one reference/i);
  });

  it('caps the references at the documented limit', async () => {
    const h = harness();
    const provider = h.db.providers.list()[0];
    await expect(
      h.service.generate({
        task: 'image',
        prompt: 'x',
        providerId: provider?.id,
        modelId: 'image-editor',
        referenceMediaIds: Array.from({ length: 17 }, (_, index) => `id-${index}`),
      }),
    ).rejects.toThrow(/At most 16 reference images/i);
  });
});

describe('conversation links', () => {
  it('records the conversation on the job and on the media row', async () => {
    const h = harness();
    const conversation = h.db.conversations.create({ title: 'Art direction' });
    const provider = h.db.providers.list()[0];

    const { jobId } = await h.service.generate({
      task: 'image',
      prompt: 'A heron at dawn',
      providerId: provider?.id,
      modelId: 'image-editor',
      conversationId: conversation.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The job remembers where the result belongs, which is what makes a restart
    // able to finish the job into the right conversation.
    expect(h.service.jobs().find((job) => job.id === jobId)?.conversationId).toBe(conversation.id);

    const media = h.service.list({ conversationId: conversation.id });
    expect(media).toHaveLength(1);
    expect(media[0]?.prompt).toBe('A heron at dawn');
    expect(media[0]?.jobId).toBe(jobId);
  });

  it('leaves an unassociated generation unlinked', async () => {
    const h = harness();
    const provider = h.db.providers.list()[0];
    await h.service.generate({
      task: 'image',
      prompt: 'library image',
      providerId: provider?.id,
      modelId: 'image-editor',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(h.service.list()).toHaveLength(1);
    expect(h.service.list()[0]?.conversationId).toBeNull();
    expect(h.service.list({ conversationId: 'other' })).toHaveLength(0);
  });
});
