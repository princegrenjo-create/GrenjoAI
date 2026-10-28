/**
 * Renderer-side attachment helpers.
 *
 * The renderer never sees a filesystem path and never reads a file for the main
 * process to use: it either asks `attachments.pick()` for the native picker, or
 * turns a dropped `File` into bytes itself and hands them over through
 * `attachments.ingestBytes`. Electron 32 gives a `File` no `.path`, so the bytes
 * are the only reliable way across contexts — `file.arrayBuffer()` is the API.
 */
import {
  ATTACHMENT_LIMITS,
  formatBytes,
  type AttachmentMeta,
  type MessageAttachment,
} from '@shared/attachments';

/** An attachment as either the composer holds it or a message persisted it. */
export type AttachmentLike = AttachmentMeta | MessageAttachment;

/** A file the user offered that the app will not attach, with the reason. */
export interface RejectedFile {
  name: string;
  reason: string;
}

/** Chunk size for the base64 conversion: small enough for `String.fromCharCode`. */
const BASE64_CHUNK = 0x8000;

/**
 * Base64-encode the bytes of a file the user dropped.
 *
 * `btoa` takes a binary string, and spreading a large `Uint8Array` into
 * `String.fromCharCode` blows the argument limit, so the bytes go through in
 * chunks. An empty file encodes to an empty string, which the main process
 * refuses with a normal `rejected` entry rather than a crash.
 */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** Short type label for an attachment chip. Colour is never the only signal. */
export function attachmentTypeLabel(attachment: AttachmentLike): string {
  switch (attachment.kind) {
    case 'image':
      return 'Image';
    case 'audio':
      return 'Recording';
    case 'text':
      return 'Document';
    case 'unsupported':
      return 'Unsupported file';
    default:
      return 'File';
  }
}

/** The inline preview the composer already has, or null when there is none. */
export function previewOf(attachment: AttachmentLike): string | null {
  return 'previewDataUrl' in attachment ? attachment.previewDataUrl : null;
}

/** File extension for a recording's MIME type, used only to name the file. */
export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * Why this attachment cannot join a message that already holds
 * `existingCount` files, or null when it can.
 *
 * The same limits are enforced again in the main process; this copy exists so
 * the composer can explain a refusal before spending the time to read the file,
 * and so a dropped file is never silently ignored.
 */
export function limitRejection(
  existingCount: number,
  attachment: Pick<AttachmentLike, 'name' | 'kind' | 'sizeBytes'>,
): string | null {
  if (attachment.kind === 'image' && attachment.sizeBytes > ATTACHMENT_LIMITS.maxImageBytes) {
    return `Images must be ${formatBytes(ATTACHMENT_LIMITS.maxImageBytes)} or smaller to be sent to a model.`;
  }
  if (attachment.sizeBytes > ATTACHMENT_LIMITS.maxFileBytes) {
    return `Files must be ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)} or smaller.`;
  }
  if (existingCount >= ATTACHMENT_LIMITS.maxPerMessage) {
    return `A message can carry ${ATTACHMENT_LIMITS.maxPerMessage} files at most.`;
  }
  return null;
}

export interface SplitIncoming {
  accepted: AttachmentMeta[];
  rejected: RejectedFile[];
}

/** Split what the attachment service returned into chips and explained refusals. */
export function splitIncoming(
  existing: ReadonlyArray<AttachmentMeta>,
  incoming: ReadonlyArray<AttachmentMeta>,
): SplitIncoming {
  const accepted: AttachmentMeta[] = [];
  const rejected: RejectedFile[] = [];
  for (const attachment of incoming) {
    const reason = limitRejection(existing.length + accepted.length, attachment);
    if (reason) rejected.push({ name: attachment.name, reason });
    else accepted.push(attachment);
  }
  return { accepted, rejected };
}

/** Why a dropped file's declared size means it will not be read at all. */
export function dropRejection(
  existingCount: number,
  file: File,
): RejectedFile | null {
  const isImage = file.type.startsWith('image/');
  const kind = isImage ? 'image' : 'text';
  const reason = limitRejection(existingCount, {
    name: file.name,
    kind,
    sizeBytes: file.size,
  });
  return reason ? { name: file.name, reason } : null;
}
