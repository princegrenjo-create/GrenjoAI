/**
 * Attachment service behaviour.
 *
 * The service is the trust boundary between the renderer and the filesystem, so
 * these tests focus on the refusals: a per-file reason instead of a thrown
 * error, a size check before base64 is decoded, an image whose bytes do not
 * match its declared type, and a transcription request that never invents text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@shared/attachments';
import type { TranscriptionResult } from '@shared/attachments';
import type { TranscriptionStatus } from '@shared/api';
import { AppError, appError } from '@shared/errors';
import { createNullLogger } from '@main/logger';
import { classifyFile } from '@main/attachments/extract';
import {
  createAttachmentService,
  pickerDialogFilters,
  type DialogFileFilter,
  type TranscriptionGateway,
} from '@main/attachments/service';
import { createAttachmentStore } from '@main/attachments/store';
import { pngBytes } from './fixtures';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;

afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

function ensureScratch(): ScratchDir {
  if (scratch === null) scratch = scratchDir('attachments-service');
  return scratch;
}

function writeFixture(name: string, data: Buffer | string): string {
  const filePath = path.join(ensureScratch().path, name);
  fs.writeFileSync(filePath, data);
  return filePath;
}

interface FakeTranscription {
  gateway: TranscriptionGateway;
  state: {
    statusValue: TranscriptionStatus;
    statusError: Error | null;
    transcribeError: unknown;
    text: string;
    statusCalls: number;
    transcribeCalls: number;
    lastRequest: { dataBase64: string; mimeType: string; durationMs: number } | null;
  };
}

function createFakeTranscription(
  options: {
    status?: TranscriptionStatus;
    statusError?: Error;
    error?: unknown;
    text?: string;
  } = {},
): FakeTranscription {
  const state: FakeTranscription['state'] = {
    statusValue: options.status ?? { available: true, providerName: 'OpenAI', reason: null },
    statusError: options.statusError ?? null,
    transcribeError: options.error ?? null,
    text: options.text ?? 'transcribed words',
    statusCalls: 0,
    transcribeCalls: 0,
    lastRequest: null,
  };
  return {
    state,
    gateway: {
      status(): TranscriptionStatus {
        state.statusCalls += 1;
        if (state.statusError !== null) throw state.statusError;
        return state.statusValue;
      },
      async transcribe(input): Promise<TranscriptionResult> {
        state.transcribeCalls += 1;
        state.lastRequest = input;
        if (state.transcribeError !== null) throw state.transcribeError;
        return {
          text: state.text,
          providerId: 'provider-1',
          modelId: 'whisper-1',
          durationMs: input.durationMs,
        };
      },
    },
  };
}

function createHarness(options: { files?: string[]; canceled?: boolean; directory?: string | null } = {}) {
  const store = createAttachmentStore({
    directory: options.directory ?? null,
    logger: createNullLogger(),
  });
  const transcription = createFakeTranscription();
  /** Every filter list the "dialog" was opened with, in call order. */
  const pickerCalls: Array<readonly DialogFileFilter[] | undefined> = [];
  const service = createAttachmentService({
    dialogs: {
      pickFiles: async (filters) => {
        pickerCalls.push(filters);
        return {
          canceled: options.canceled ?? false,
          paths: options.files ?? [],
        };
      },
    },
    store,
    transcription: transcription.gateway,
    logger: createNullLogger(),
  });
  return { service, store, transcription, pickerCalls };
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
}

describe('attachment service: pick', () => {
  it('ingests supported files and reports a reason for each rejected one', async () => {
    const textPath = writeFixture('notes.txt', 'Hello attachment.');
    const imagePath = writeFixture('photo.png', pngBytes(7, 9));
    const badPath = writeFixture('setup.exe', Buffer.from('MZ binary'));
    const hugePath = path.join(ensureScratch().path, 'huge.txt');
    fs.writeFileSync(hugePath, Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1, 0x61));

    const h = createHarness({ files: [textPath, imagePath, badPath, hugePath] });
    const result = await h.service.pick();

    expect(result.cancelled).toBe(false);
    expect(result.attachments).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['setup.exe', 'huge.txt']),
    );
    expect(result.rejected.find((entry) => entry.name === 'setup.exe')?.reason).toMatch(
      /not supported/i,
    );
    expect(result.rejected.find((entry) => entry.name === 'huge.txt')?.reason).toMatch(/larger than/i);

    const text = result.attachments.find((entry) => entry.kind === 'text');
    expect(text?.contentStatus).toBe('extracted');
    expect(text?.sentToProvider).toBe(true);
    expect(text?.extractedChars).toBe('Hello attachment.'.length);
    expect(text?.contentNote).toBeNull();

    const image = result.attachments.find((entry) => entry.kind === 'image');
    expect(image?.imageWidth).toBe(7);
    expect(image?.imageHeight).toBe(9);
    expect(image?.sentToProvider).toBe(true);
    expect(image?.previewDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('treats a cancelled dialog as a normal outcome', async () => {
    const h = createHarness({ canceled: true });
    const result = await h.service.pick();
    expect(result).toEqual({ attachments: [], rejected: [], cancelled: true });
  });

  it('caps the selection at the per-message limit and explains the extras', async () => {
    const files = Array.from({ length: ATTACHMENT_LIMITS.maxPerMessage + 2 }, (_value, index) =>
      writeFixture(`file-${index}.txt`, `content ${index}`),
    );
    const h = createHarness({ files });
    const result = await h.service.pick();

    expect(result.attachments).toHaveLength(ATTACHMENT_LIMITS.maxPerMessage);
    expect(result.rejected).toHaveLength(2);
    for (const rejected of result.rejected) {
      expect(rejected.reason).toMatch(/at most/i);
    }
  });

  it('reports an unreadable path without throwing', async () => {
    const h = createHarness({
      files: [path.join(ensureScratch().path, 'missing.txt')],
    });
    const result = await h.service.pick();
    expect(result.attachments).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/could not be read/i);
  });

  it('marks a picked recording as metadata-only', async () => {
    const audioPath = writeFixture('recording.webm', Buffer.from('fake audio bytes'));
    const h = createHarness({ files: [audioPath] });
    const result = await h.service.pick();

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.kind).toBe('audio');
    expect(result.attachments[0]?.contentStatus).toBe('metadata-only');
    expect(result.attachments[0]?.sentToProvider).toBe(false);
  });
});

describe('attachment service: picker filters', () => {
  it('opens the dialog with no filter when the caller names no kind', async () => {
    const h = createHarness();
    await h.service.pick();
    await h.service.pick({});

    // `undefined` is the shape the Electron closure checks before it adds a
    // `filters` key, so this is exactly the pre-existing dialog.
    expect(h.pickerCalls).toEqual([undefined, undefined]);
  });

  it('offers only the image types the service accepts when the kind is image', async () => {
    const h = createHarness();
    await h.service.pick({ kinds: 'image' });

    expect(h.pickerCalls[0]).toEqual([
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    ]);
  });

  it('offers the extractor document types and an all-files escape hatch for the file kind', async () => {
    const h = createHarness();
    await h.service.pick({ kinds: 'file' });

    const filters = h.pickerCalls[0] ?? [];
    expect(filters.map((filter) => filter.name)).toEqual(['Documents', 'All files']);

    const documents = filters[0]?.extensions ?? [];
    expect(documents).toEqual(
      expect.arrayContaining(['txt', 'md', 'csv', 'json', 'pdf', 'docx']),
    );
    expect(documents).not.toContain('png');
    expect(documents).not.toContain('exe');
    // Without it a readable file whose extension is not in the table could not
    // be chosen at all.
    expect(filters[1]?.extensions).toEqual(['*']);
  });

  it('never offers a filter extension the attachment service would not classify as that kind', async () => {
    const kindForPicker: Record<'file' | 'image', ReturnType<typeof classifyFile>['kind']> = {
      file: 'text',
      image: 'image',
    };

    for (const pickKind of ['file', 'image'] as const) {
      const filters = pickerDialogFilters(pickKind);
      expect(filters.length).toBeGreaterThan(0);
      for (const filter of filters) {
        expect(filter.extensions.length).toBeGreaterThan(0);
        for (const extension of filter.extensions) {
          if (extension === '*') continue;
          const classification = classifyFile({
            name: `probe.${extension}`,
            mimeType: '',
            sizeBytes: 1,
          });
          // This is the drift guard: the dialog may only promise a file type the
          // service would accept as the kind the user asked for.
          expect(classification.kind).toBe(kindForPicker[pickKind]);
        }
      }
    }
  });
});

describe('attachment service: ingestBytes', () => {
  it('ingests text bytes the renderer already holds', async () => {
    const h = createHarness();
    const result = await h.service.ingestBytes({
      name: 'pasted.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('pasted content').toString('base64'),
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.attachments[0]?.contentStatus).toBe('extracted');
    expect(result.attachments[0]?.extractedChars).toBe('pasted content'.length);
  });

  it('rejects invalid base64 with a readable reason', async () => {
    const h = createHarness();
    const result = await h.service.ingestBytes({
      name: 'broken.txt',
      mimeType: 'text/plain',
      dataBase64: 'this is not base64!!!',
    });
    expect(result.attachments).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/base64/i);
  });

  it('checks the base64 length against the limit before decoding', async () => {
    const h = createHarness();
    const oversizeChars = Math.ceil((ATTACHMENT_LIMITS.maxFileBytes + 1) / 3) * 4;
    const dataBase64 = 'A'.repeat(oversizeChars);

    const result = await h.service.ingestBytes({
      name: 'huge.bin',
      mimeType: 'application/octet-stream',
      dataBase64,
    });

    expect(result.attachments).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/larger than/i);
  });

  it('refuses an image whose bytes do not match its declared type', async () => {
    const h = createHarness();
    const result = await h.service.ingestBytes({
      name: 'photo.png',
      mimeType: 'image/jpeg',
      dataBase64: pngBytes(3, 3).toString('base64'),
      kindHint: 'image',
    });
    expect(result.attachments).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/declared as image\/jpeg/i);
  });

  it('refuses a dropped file that claims to be an image but is not', async () => {
    const h = createHarness();
    const result = await h.service.ingestBytes({
      name: 'notes.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('plain text').toString('base64'),
      kindHint: 'image',
    });
    expect(result.attachments).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/dropped as an image/i);
  });

  it('ingests an image and exposes its preview', async () => {
    const h = createHarness();
    const result = await h.service.ingestBytes({
      name: 'drop.png',
      mimeType: 'image/png',
      dataBase64: pngBytes(11, 13).toString('base64'),
      kindHint: 'image',
    });

    expect(result.attachments).toHaveLength(1);
    const meta = result.attachments[0];
    expect(meta?.imageWidth).toBe(11);
    expect(meta?.imageHeight).toBe(13);
    expect(h.service.get(meta?.id ?? '')?.previewDataUrl).not.toBeNull();
  });
});

describe('attachment service: lifecycle', () => {
  it('gets, previews and removes a pending attachment', async () => {
    const imagePath = writeFixture('lifecycle.png', pngBytes(2, 2));
    const h = createHarness({ files: [imagePath] });
    const picked = await h.service.pick();
    const id = picked.attachments[0]?.id ?? '';

    expect(h.service.get(id)?.id).toBe(id);
    expect(h.service.readImage(id).dataUrl.startsWith('data:image/png;base64,')).toBe(true);

    h.service.remove(id);

    expect(h.service.get(id)).toBeNull();
    await expectAppError(Promise.resolve().then(() => h.service.readImage(id)));
  });

  it('resolves exactly the requested payloads, in order, and throws for an unknown id', async () => {
    const first = writeFixture('first.txt', 'first content');
    const second = writeFixture('second.txt', 'second content');
    const h = createHarness({ files: [first, second] });
    const picked = await h.service.pick();
    const ids = picked.attachments.map((attachment) => attachment.id);

    const resolved = h.service.resolve([ids[1] ?? '', ids[0] ?? '']);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.meta.id).toBe(ids[1]);
    expect(resolved[1]?.text).toBe('first content');

    const error = await expectAppError(
      Promise.resolve().then(() => h.service.resolve(['not-a-real-id'])),
    );
    expect(error.code).toBe('not_found');
  });

  it('releases payloads after a turn so unsent bytes are not held', async () => {
    const textPath = writeFixture('released.txt', 'released content');
    const h = createHarness({ files: [textPath] });
    const picked = await h.service.pick();
    const id = picked.attachments[0]?.id ?? '';

    h.service.release([id]);

    expect(h.service.get(id)).toBeNull();
    const error = await expectAppError(Promise.resolve().then(() => h.service.resolve([id])));
    expect(error.code).toBe('not_found');
  });

  it('disposes pending payloads on shutdown', async () => {
    const textPath = writeFixture('shutdown.txt', 'shutdown content');
    const h = createHarness({ files: [textPath] });
    const picked = await h.service.pick();

    h.service.dispose();

    expect(h.service.get(picked.attachments[0]?.id ?? '')).toBeNull();
  });
});

describe('attachment service: transcription', () => {
  const audio = Buffer.from('recorded audio bytes').toString('base64');

  it('returns the provider transcript with its ids and duration', async () => {
    const h = createHarness();
    const result = await h.service.transcribe({ dataBase64: audio, mimeType: 'audio/webm', durationMs: 1500 });

    expect(result.text).toBe('transcribed words');
    expect(result.providerId).toBe('provider-1');
    expect(result.modelId).toBe('whisper-1');
    expect(result.durationMs).toBe(1500);
    expect(h.transcription.state.transcribeCalls).toBe(1);
    expect(h.transcription.state.lastRequest?.durationMs).toBe(1500);
  });

  it('refuses with a configuration sentence when no provider can transcribe', async () => {
    const status: TranscriptionStatus = {
      available: false,
      providerName: null,
      reason: 'Transcription needs an OpenAI API key.',
    };
    const h = createHarness();
    const service = createAttachmentService({
      dialogs: { pickFiles: async () => ({ canceled: true, paths: [] }) },
      store: h.store,
      transcription: createFakeTranscription({ status }).gateway,
      logger: createNullLogger(),
    });

    const error = await expectAppError(
      service.transcribe({ dataBase64: audio, mimeType: 'audio/webm', durationMs: 1000 }),
    );
    expect(error.code).toBe('missing_key');
    expect(error.message).toMatch(/OpenAI API key/);
  });

  it('reports an unavailable status instead of throwing when the check fails', async () => {
    const h = createHarness();
    const service = createAttachmentService({
      dialogs: { pickFiles: async () => ({ canceled: true, paths: [] }) },
      store: h.store,
      transcription: createFakeTranscription({ statusError: new Error('provider store broke') }).gateway,
      logger: createNullLogger(),
    });

    const status = await service.transcriptionStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBeTruthy();
  });

  it('refuses a recording over the byte limit before decoding it', async () => {
    const h = createHarness();
    const oversizeChars = Math.ceil((ATTACHMENT_LIMITS.maxAudioBytes + 1) / 3) * 4;
    const error = await expectAppError(
      h.service.transcribe({
        dataBase64: 'A'.repeat(oversizeChars),
        mimeType: 'audio/webm',
        durationMs: 1000,
      }),
    );
    expect(error.code).toBe('bad_request');
    expect(error.message).toMatch(/larger than/i);
    expect(h.transcription.state.transcribeCalls).toBe(0);
  });

  it('refuses a recording longer than the duration limit', async () => {
    const h = createHarness();
    const error = await expectAppError(
      h.service.transcribe({
        dataBase64: audio,
        mimeType: 'audio/webm',
        durationMs: ATTACHMENT_LIMITS.maxAudioSeconds * 1000 + 1,
      }),
    );
    expect(error.code).toBe('bad_request');
    expect(error.message).toMatch(/longer than/i);
    expect(h.transcription.state.transcribeCalls).toBe(0);
  });

  it('refuses malformed base64', async () => {
    const h = createHarness();
    const error = await expectAppError(
      h.service.transcribe({ dataBase64: '%%%not-base64%%%', mimeType: 'audio/webm', durationMs: 100 }),
    );
    expect(error.code).toBe('bad_request');
  });

  it('propagates a provider AppError unchanged', async () => {
    const h = createHarness();
    const service = createAttachmentService({
      dialogs: { pickFiles: async () => ({ canceled: true, paths: [] }) },
      store: h.store,
      transcription: createFakeTranscription({
        error: new AppError(appError('rate_limited', 'Slow down and retry.')),
      }).gateway,
      logger: createNullLogger(),
    });

    const error = await expectAppError(
      service.transcribe({ dataBase64: audio, mimeType: 'audio/webm', durationMs: 100 }),
    );
    expect(error.code).toBe('rate_limited');
  });

  it('maps a transport failure to provider_error', async () => {
    const h = createHarness();
    const service = createAttachmentService({
      dialogs: { pickFiles: async () => ({ canceled: true, paths: [] }) },
      store: h.store,
      transcription: createFakeTranscription({ error: new Error('socket hang up') }).gateway,
      logger: createNullLogger(),
    });

    const error = await expectAppError(
      service.transcribe({ dataBase64: audio, mimeType: 'audio/webm', durationMs: 100 }),
    );
    expect(error.code).toBe('provider_error');
  });

  it('never returns an empty transcript as success', async () => {
    const h = createHarness();
    const service = createAttachmentService({
      dialogs: { pickFiles: async () => ({ canceled: true, paths: [] }) },
      store: h.store,
      transcription: createFakeTranscription({ text: '   ' }).gateway,
      logger: createNullLogger(),
    });

    const error = await expectAppError(
      service.transcribe({ dataBase64: audio, mimeType: 'audio/webm', durationMs: 100 }),
    );
    expect(error.code).toBe('provider_error');
    expect(error.message).toMatch(/no text/i);
  });
});
