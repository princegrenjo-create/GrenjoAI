/**
 * Attachment service: the one place the main process turns a user selection into
 * validated, bounded attachment metadata.
 *
 * Everything that needs Electron is injected (`dialogs`), so this file can be
 * exercised by a plain Node test with no window. The service never trusts the
 * renderer: sizes are re-checked, base64 is validated before it is decoded, image
 * bytes must match their declared type, and a file that is refused comes back as
 * a per-file reason instead of failing the whole selection.
 *
 * The service is also the `PendingAttachmentResolver` the chat pipeline consumes:
 * `resolve` hands the chat layer the exact payloads it asked for, and `release`
 * drops them once the turn is persisted. A rejected send never releases, so the
 * composer keeps its attachments for the retry.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENT_LIMITS,
  formatBytes,
  type AttachmentKind,
  type AttachmentMeta,
  type AttachmentPayload,
  type AttachmentPickResult,
  type ContentStatus,
  type PendingAttachmentResolver,
  type TranscriptionResult,
} from '@shared/attachments';
import type {
  AttachmentBytesInput,
  AttachmentPickKind,
  AttachmentPickOptions,
  TranscriptionInput,
  TranscriptionStatus,
} from '@shared/api';
import { AppError, appError, toAppError } from '@shared/errors';
import type { Logger } from '../logger';
import {
  classifyFile,
  extensionsForKind,
  extractText,
  extractTextFromBytes,
  mimeTypeForFile,
  readBoundedFile,
} from './extract';
import { validateImage } from './images';
import type { AttachmentStore } from './store';

/**
 * One entry of the native dialog's file-type list.
 *
 * Structurally the same shape as Electron's `FileFilter`, declared here so this
 * module keeps its promise of importing no Electron API and so a test can assert
 * the exact list without a window.
 */
export interface DialogFileFilter {
  name: string;
  extensions: string[];
}

export interface AttachmentPickerDialogs {
  /**
   * Injected so the service imports no Electron API. `filters` is the dialog's
   * convenience list; `undefined` means "offer every file", which is what the
   * picker has always done.
   */
  pickFiles(
    filters?: readonly DialogFileFilter[],
  ): Promise<{ canceled: boolean; paths: string[] }>;
}

const PICK_FILTER_LABELS: Record<AttachmentPickKind, string> = {
  file: 'Documents',
  image: 'Images',
};

/**
 * The OS dialog's filter list for one pick kind.
 *
 * The extensions are read from the extractor's own format tables, so the dialog
 * can only offer a type the attachment service classifies as that kind. This is
 * a convenience for the person choosing a file, never an allowlist: whatever the
 * dialog lets through is still classified, size-checked and content-checked by
 * `ingestPath`.
 */
export function pickerDialogFilters(kind: AttachmentPickKind): DialogFileFilter[] {
  if (kind === 'image') {
    return [{ name: PICK_FILTER_LABELS.image, extensions: [...extensionsForKind('image')] }];
  }
  return [
    { name: PICK_FILTER_LABELS.file, extensions: [...extensionsForKind('text')] },
    // Without this, a file the extractor would read but whose extension is not
    // in the table above could not be chosen at all.
    { name: 'All files', extensions: ['*'] },
  ];
}

/**
 * Structural twin of the transcription service. Declared here so this module
 * depends on the shape, not on the implementation, and a test can pass a fake.
 */
export interface TranscriptionGateway {
  status(): TranscriptionStatus;
  transcribe(input: {
    dataBase64: string;
    mimeType: string;
    durationMs: number;
  }): Promise<TranscriptionResult>;
}

export interface AttachmentServiceDeps {
  dialogs: AttachmentPickerDialogs;
  store: AttachmentStore;
  transcription: TranscriptionGateway;
  logger: Logger;
}

export interface AttachmentService extends PendingAttachmentResolver {
  /** Opens the picker and ingests the chosen files. */
  pick(options?: AttachmentPickOptions): Promise<AttachmentPickResult>;
  /** Ingests bytes the renderer already has (drag-and-drop, paste). */
  ingestBytes(input: AttachmentBytesInput): Promise<AttachmentPickResult>;
  get(id: string): AttachmentMeta | null;
  remove(id: string): void;
  readImage(id: string): { dataUrl: string };
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
  transcriptionStatus(): Promise<TranscriptionStatus>;
  /** Drops pending payloads and their mirrors; pending work does not outlive the app. */
  dispose(): void;
}

interface RejectedFile {
  name: string;
  reason: string;
}

interface IngestOutcome {
  kind: 'ok' | 'rejected';
  meta: AttachmentMeta | null;
  rejected: RejectedFile | null;
}

function accepted(meta: AttachmentMeta): IngestOutcome {
  return { kind: 'ok', meta, rejected: null };
}

function refused(name: string, reason: string): IngestOutcome {
  return { kind: 'rejected', meta: null, rejected: { name, reason } };
}

const UNSUPPORTED_REASON =
  'Files of this type are not supported. Attach a PDF, a Word document, a text or code file, or a PNG/JPEG/WebP/GIF image.';

const UNREADABLE_REASON =
  'This file could not be read. Check that it still exists and that you can open it.';

const INVALID_BASE64_REASON =
  'The file data was not valid base64 and could not be read. Try adding the file again.';

const TRANSCRIPTION_REASON =
  'Transcription needs a provider that offers a transcription endpoint. Add an OpenAI provider and key under Models & Providers, then record again.';

/** Decoded size of a strict base64 string, or `null` when it is not base64. */
function base64ByteLength(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  if (trimmed.endsWith('==')) return (trimmed.length / 4) * 3 - 2;
  if (trimmed.endsWith('=')) return (trimmed.length / 4) * 3 - 1;
  return (trimmed.length / 4) * 3;
}

function tooLargeReason(sizeBytes: number): string {
  return `${formatBytes(sizeBytes)} is larger than the ${Math.round(
    ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024),
  )} MB attachment limit.`;
}

function buildMeta(input: {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentStatus: ContentStatus;
  contentNote: string | null;
  extractedChars: number | null;
  sentToProvider: boolean;
  imageWidth?: number | null;
  imageHeight?: number | null;
  previewDataUrl?: string | null;
  durationMs?: number | null;
  createdAt: string;
}): AttachmentMeta {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    contentStatus: input.contentStatus,
    contentNote: input.contentNote,
    extractedChars: input.extractedChars,
    sentToProvider: input.sentToProvider,
    imageWidth: input.imageWidth ?? null,
    imageHeight: input.imageHeight ?? null,
    previewDataUrl: input.previewDataUrl ?? null,
    durationMs: input.durationMs ?? null,
    createdAt: input.createdAt,
  };
}

export function createAttachmentService(deps: AttachmentServiceDeps): AttachmentService {
  const { dialogs, store, transcription } = deps;
  const log = deps.logger.child('attachments');

  function nowIso(): string {
    return new Date().toISOString();
  }

  async function ingestPath(filePath: string): Promise<IngestOutcome> {
    const name = path.basename(filePath);
    let fileSize: number;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return refused(name, 'Folders cannot be attached. Choose a file.');
      fileSize = stat.size;
    } catch {
      return refused(name, UNREADABLE_REASON);
    }
    if (fileSize > ATTACHMENT_LIMITS.maxFileBytes) {
      return refused(name, tooLargeReason(fileSize));
    }

    const classified = classifyFile({
      name,
      mimeType: mimeTypeForFile(name),
      sizeBytes: fileSize,
    });
    if (classified.kind === 'unsupported') return refused(name, UNSUPPORTED_REASON);

    const id = randomUUID();
    const createdAt = nowIso();

    if (classified.kind === 'image') {
      const read = readBoundedFile(filePath, ATTACHMENT_LIMITS.maxFileBytes);
      if (!read.ok) {
        return refused(name, read.reason === 'too-large' ? tooLargeReason(fileSize) : UNREADABLE_REASON);
      }
      const bytes = read.bytes;
      const validation = validateImage({ bytes, mimeType: classified.mimeType });
      if (!validation.ok) return refused(name, validation.reason);
      const meta = buildMeta({
        id,
        kind: 'image',
        name,
        mimeType: validation.mimeType,
        sizeBytes: bytes.length,
        contentStatus: 'extracted',
        contentNote: null,
        extractedChars: null,
        sentToProvider: true,
        imageWidth: validation.width,
        imageHeight: validation.height,
        previewDataUrl: validation.previewDataUrl,
        createdAt,
      });
      const payload: AttachmentPayload = {
        meta,
        text: null,
        image: {
          dataBase64: Buffer.from(bytes).toString('base64'),
          mimeType: validation.mimeType,
        },
        filePath,
      };
      return accepted(store.add(payload).meta);
    }

    if (classified.kind === 'audio') {
      const meta = buildMeta({
        id,
        kind: 'audio',
        name,
        mimeType: classified.mimeType,
        sizeBytes: fileSize,
        contentStatus: 'metadata-only',
        contentNote:
          'Recordings are transcribed before they are sent. Record from the microphone button to transcribe.',
        extractedChars: null,
        sentToProvider: false,
        createdAt,
      });
      const payload: AttachmentPayload = { meta, text: null, image: null, filePath };
      return accepted(store.add(payload).meta);
    }

    const extracted = await extractText({
      filePath,
      name,
      mimeType: classified.mimeType,
      sizeBytes: fileSize,
    });
    const meta = buildMeta({
      id,
      kind: 'text',
      name,
      mimeType: classified.mimeType,
      sizeBytes: fileSize,
      contentStatus: extracted.contentStatus,
      contentNote: extracted.note,
      extractedChars: extracted.text === null ? null : extracted.text.length,
      sentToProvider: extracted.contentStatus === 'extracted' && extracted.text !== null,
      createdAt,
    });
    const payload: AttachmentPayload = { meta, text: extracted.text, image: null, filePath };
    return accepted(store.add(payload).meta);
  }

  async function readTranscriptionStatus(): Promise<TranscriptionStatus> {
    try {
      const status = await transcription.status();
      if (!status.available && status.reason === null) {
        return { ...status, reason: TRANSCRIPTION_REASON };
      }
      return status;
    } catch (error) {
      log.warn('Transcription availability could not be read', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return {
        available: false,
        providerName: null,
        reason: TRANSCRIPTION_REASON,
      };
    }
  }

  function singleResult(outcome: IngestOutcome): AttachmentPickResult {
    if (outcome.kind === 'ok' && outcome.meta !== null) {
      return { attachments: [outcome.meta], rejected: [], cancelled: false };
    }
    return {
      attachments: [],
      rejected: outcome.rejected !== null ? [outcome.rejected] : [],
      cancelled: false,
    };
  }

  return {
    async pick(options?: AttachmentPickOptions): Promise<AttachmentPickResult> {
      // `undefined` kinds keeps the dialog exactly as it was before the argument
      // existed: no filter, every file selectable.
      const filters =
        options?.kinds === undefined ? undefined : pickerDialogFilters(options.kinds);
      let selection: { canceled: boolean; paths: string[] };
      try {
        selection = await dialogs.pickFiles(filters);
      } catch {
        throw new AppError(
          appError(
            'unknown',
            'The file picker could not be opened. Try dragging the file into the composer instead.',
          ),
        );
      }
      if (selection.canceled) return { attachments: [], rejected: [], cancelled: true };

      const attachments: AttachmentMeta[] = [];
      const rejected: RejectedFile[] = [];

      const paths = selection.paths.filter((candidate) => candidate.trim().length > 0);
      for (const extra of paths.slice(ATTACHMENT_LIMITS.maxPerMessage)) {
        rejected.push({
          name: path.basename(extra),
          reason: `You can attach at most ${ATTACHMENT_LIMITS.maxPerMessage} files to one message.`,
        });
      }

      for (const filePath of paths.slice(0, ATTACHMENT_LIMITS.maxPerMessage)) {
        const outcome = await ingestPath(filePath);
        if (outcome.kind === 'ok' && outcome.meta !== null) attachments.push(outcome.meta);
        else if (outcome.rejected !== null) rejected.push(outcome.rejected);
      }

      log.info('Files picked', { accepted: attachments.length, rejected: rejected.length });
      return { attachments, rejected, cancelled: false };
    },

    async ingestBytes(input: AttachmentBytesInput): Promise<AttachmentPickResult> {
      const name = input.name.trim().length > 0 ? input.name.trim() : 'attachment';
      const declaredBytes = base64ByteLength(input.dataBase64);
      if (declaredBytes === null) return singleResult(refused(name, INVALID_BASE64_REASON));
      if (declaredBytes > ATTACHMENT_LIMITS.maxFileBytes) {
        return singleResult(refused(name, tooLargeReason(declaredBytes)));
      }

      const bytes = Buffer.from(input.dataBase64.trim(), 'base64');
      const mimeType =
        input.mimeType.trim().length > 0 ? input.mimeType.trim() : mimeTypeForFile(name);
      const classified = classifyFile({ name, mimeType, sizeBytes: bytes.length });
      if (input.kindHint === 'image' && classified.kind !== 'image') {
        return singleResult(
          refused(name, 'This file was dropped as an image but is not one of the supported image types.'),
        );
      }
      if (classified.kind === 'unsupported') {
        return singleResult(refused(name, UNSUPPORTED_REASON));
      }

      const id = randomUUID();
      const createdAt = nowIso();

      if (classified.kind === 'image') {
        // The caller's declared type is the one to check against the bytes: a
        // `.png` name does not excuse a request that declares JPEG and ships PNG.
        const validation = validateImage({
          bytes,
          mimeType: mimeType.length > 0 ? mimeType : classified.mimeType,
        });
        if (!validation.ok) return singleResult(refused(name, validation.reason));
        const meta = buildMeta({
          id,
          kind: 'image',
          name,
          mimeType: validation.mimeType,
          sizeBytes: bytes.length,
          contentStatus: 'extracted',
          contentNote: null,
          extractedChars: null,
          sentToProvider: true,
          imageWidth: validation.width,
          imageHeight: validation.height,
          previewDataUrl: validation.previewDataUrl,
          createdAt,
        });
        const payload: AttachmentPayload = {
          meta,
          text: null,
          image: {
            dataBase64: Buffer.from(bytes).toString('base64'),
            mimeType: validation.mimeType,
          },
          filePath: null,
        };
        return singleResult(accepted(store.add(payload).meta));
      }

      if (classified.kind === 'audio') {
        const meta = buildMeta({
          id,
          kind: 'audio',
          name,
          mimeType: classified.mimeType,
          sizeBytes: bytes.length,
          contentStatus: 'metadata-only',
          contentNote:
            'Recordings are transcribed before they are sent. Record from the microphone button to transcribe.',
          extractedChars: null,
          sentToProvider: false,
          createdAt,
        });
        const payload: AttachmentPayload = { meta, text: null, image: null, filePath: null };
        return singleResult(accepted(store.add(payload).meta));
      }

      const extracted = await extractTextFromBytes({
        bytes,
        name,
        mimeType: classified.mimeType,
      });
      const meta = buildMeta({
        id,
        kind: 'text',
        name,
        mimeType: classified.mimeType,
        sizeBytes: bytes.length,
        contentStatus: extracted.contentStatus,
        contentNote: extracted.note,
        extractedChars: extracted.text === null ? null : extracted.text.length,
        sentToProvider: extracted.contentStatus === 'extracted' && extracted.text !== null,
        createdAt,
      });
      const payload: AttachmentPayload = { meta, text: extracted.text, image: null, filePath: null };
      return singleResult(accepted(store.add(payload).meta));
    },

    get(id: string): AttachmentMeta | null {
      return store.get(id)?.meta ?? null;
    },

    remove(id: string): void {
      store.remove(id);
    },

    readImage(id: string): { dataUrl: string } {
      const dataUrl = store.readImageDataUrl(id);
      if (dataUrl === null) {
        throw new AppError(
          appError(
            'not_found',
            'That image is no longer available to preview. Attach it again to see it.',
          ),
        );
      }
      return { dataUrl };
    },

    resolve(ids: string[]): AttachmentPayload[] {
      const payloads: AttachmentPayload[] = [];
      for (const id of ids) {
        const payload = store.get(id);
        if (payload === null) {
          throw new AppError(
            appError(
              'not_found',
              'One of the attachments is no longer available. Add it again and resend.',
            ),
          );
        }
        payloads.push(payload);
      }
      return payloads;
    },

    release(ids: string[]): void {
      for (const id of ids) store.release(id);
      log.debug('Attachment payloads released', { count: ids.length });
    },

    async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
      if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
        throw new AppError(
          appError('bad_request', 'The recording length was not usable. Record again.'),
        );
      }
      if (input.durationMs > ATTACHMENT_LIMITS.maxAudioSeconds * 1000) {
        throw new AppError(
          appError(
            'bad_request',
            `The recording is longer than ${Math.round(ATTACHMENT_LIMITS.maxAudioSeconds / 60)} minutes. Record a shorter clip and try again.`,
          ),
        );
      }

      const declaredBytes = base64ByteLength(input.dataBase64);
      if (declaredBytes === null) {
        throw new AppError(appError('bad_request', 'The recording data was not valid base64.'));
      }
      if (declaredBytes > ATTACHMENT_LIMITS.maxAudioBytes) {
        throw new AppError(
          appError(
            'bad_request',
            `The recording is larger than ${Math.round(
              ATTACHMENT_LIMITS.maxAudioBytes / (1024 * 1024),
            )} MB and was not uploaded.`,
          ),
        );
      }
      if (declaredBytes === 0) {
        throw new AppError(appError('bad_request', 'The recording is empty — nothing was captured.'));
      }

      const status = await readTranscriptionStatus();
      if (!status.available) {
        throw new AppError(appError('missing_key', status.reason ?? TRANSCRIPTION_REASON));
      }

      try {
        const result = await transcription.transcribe({
          dataBase64: input.dataBase64.trim(),
          mimeType: input.mimeType,
          durationMs: input.durationMs,
        });
        if (result.text.trim().length === 0) {
          // Never invent text: an empty transcript is a provider failure the UI
          // must show, not a successful reply.
          throw new AppError(
            appError('provider_error', 'The transcription service returned no text. Try again.'),
          );
        }
        log.info('Transcription returned', {
          chars: result.text.length,
          durationMs: result.durationMs,
        });
        return result;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(toAppError(error, 'provider_error'));
      }
    },

    async transcriptionStatus(): Promise<TranscriptionStatus> {
      return readTranscriptionStatus();
    },

    dispose(): void {
      store.dispose();
    },
  };
}
