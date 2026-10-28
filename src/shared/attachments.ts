/**
 * Attachment model, shared by the main process, the preload bridge and the
 * renderer.
 *
 * Three rules decide the whole design:
 *
 *  1. **Nothing is silently "attached".** Every attachment carries a
 *     `contentStatus`. `extracted` means the bytes were actually read into text
 *     (or inlined as an image); `metadata-only` means the file is known but its
 *     contents were not used; `failed` means extraction was attempted and did
 *     not succeed. The UI must show which one it is, so a model never appears to
 *     have read a file it never received.
 *  2. **Original files stay on this machine.** Document text is extracted
 *     locally and only the extracted text is sent. Image bytes are sent only to
 *     a provider the user configured, and only when that model accepts images.
 *  3. **No filesystem paths leave the main process.** The renderer sees opaque
 *     ids; paths live in the main-process registry.
 */

/** How the attachment's contents were handled. */
export const CONTENT_STATUSES = ['extracted', 'metadata-only', 'failed'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const ATTACHMENT_KINDS = ['text', 'image', 'audio', 'unsupported'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * Hard limits. These are enforced in the main process, not only in the UI:
 * a hostile or buggy renderer must not be able to hand the app a 2 GB file.
 */
export const ATTACHMENT_LIMITS = {
  /** Largest single file accepted from the picker or a drop. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Largest image that will be inlined into a provider request. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Largest recording accepted for transcription. */
  maxAudioBytes: 20 * 1024 * 1024,
  /** Recordings longer than this are refused rather than uploaded. */
  maxAudioSeconds: 300,
  /** Attachments per message. */
  maxPerMessage: 8,
  /** Extracted characters per document kept and sent. */
  maxExtractedChars: 60_000,
  /** Inline preview size; larger images get a placeholder chip instead. */
  maxPreviewBytes: 512 * 1024,
} as const;

/** Attachment as the renderer sees it. No path, no raw bytes. */
export interface AttachmentMeta {
  id: string;
  kind: AttachmentKind;
  /** Original filename, for display only. */
  name: string;
  /** Resolved MIME type. */
  mimeType: string;
  sizeBytes: number;
  contentStatus: ContentStatus;
  /** Human sentence explaining the status when it is not `extracted`. */
  contentNote: string | null;
  /** Characters of text actually extracted (documents only). */
  extractedChars: number | null;
  /** True when these bytes will be attached to the provider request. */
  sentToProvider: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  /** Data URL for a small image; null when the image is too large to preview inline. */
  previewDataUrl: string | null;
  /** Recording length, audio only. */
  durationMs: number | null;
  createdAt: string;
}

/**
 * Attachment as it is persisted on a message.
 *
 * The transient `previewDataUrl` is dropped: history must not grow by a
 * megabyte per image. Image bytes live in the profile's attachment folder and
 * are re-read on demand for previews.
 */
export interface MessageAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentStatus: ContentStatus;
  contentNote: string | null;
  extractedChars: number | null;
  sentToProvider: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  durationMs: number | null;
  createdAt: string;
}

export function toMessageAttachment(meta: AttachmentMeta): MessageAttachment {
  return {
    id: meta.id,
    kind: meta.kind,
    name: meta.name,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    contentStatus: meta.contentStatus,
    contentNote: meta.contentNote,
    extractedChars: meta.extractedChars,
    sentToProvider: meta.sentToProvider,
    imageWidth: meta.imageWidth,
    imageHeight: meta.imageHeight,
    durationMs: meta.durationMs,
    createdAt: meta.createdAt,
  };
}

/** Bytes held by the main process for one pending attachment. */
export interface AttachmentPayload {
  meta: AttachmentMeta;
  /** Extracted text for documents. Bounded by `maxExtractedChars`. */
  text: string | null;
  /** Image bytes, only for `kind: 'image'`. */
  image: { dataBase64: string; mimeType: string } | null;
  /** Absolute path on this machine. Never leaves the main process. */
  filePath: string | null;
}

/**
 * The narrow view of the attachment service the chat pipeline needs. Declared
 * here so the chat service can be tested with a trivial fake.
 */
export interface PendingAttachmentResolver {
  /** Throws `not_found` when an id is unknown (already sent, or removed). */
  resolve(ids: string[]): AttachmentPayload[];
  /** Called once a turn has been persisted; the pending entry is no longer needed. */
  release(ids: string[]): void;
}

/** Result of asking the main process to open the native file picker. */
export interface AttachmentPickResult {
  attachments: AttachmentMeta[];
  /** Files the user selected that were refused, with the reason. */
  rejected: Array<{ name: string; reason: string }>;
  /** True when the user cancelled the dialog — not an error. */
  cancelled: boolean;
}

/** Result of a transcription request. */
export interface TranscriptionResult {
  text: string;
  /** Provider that produced the transcript, for the UI to name it. */
  providerId: string;
  modelId: string;
  durationMs: number | null;
}

/** Human-readable byte size, used by the attachment chips. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
