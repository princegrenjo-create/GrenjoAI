/**
 * File classification and local text extraction.
 *
 * Deliberately pure with respect to Electron and the IPC layer: the only I/O is
 * reading the user's own file, so this module can be tested without a window, a
 * database or a dialog. The document parsers are loaded lazily *inside* the
 * extraction call — a chat-only session never pays for pdf.js or the OOXML
 * reader, and a corrupt parser can never break app start-up.
 *
 * Two rules decide every branch below:
 *
 *  1. **Nothing is guessed.** A file that cannot be decoded comes back as
 *     `contentStatus: 'failed'` with a sentence a person can act on. It never
 *     comes back as empty text, which the UI would show as a successfully read
 *     file.
 *  2. **Nothing is unbounded.** Every read is capped by `ATTACHMENT_LIMITS`, so a
 *     hostile or accidental 2 GB file cannot exhaust memory.
 */
import fs from 'node:fs';
import { ATTACHMENT_LIMITS, type AttachmentKind, type ContentStatus } from '@shared/attachments';

export interface ClassifyFileInput {
  /** Original filename. Only the extension decides the format here. */
  name: string;
  /** MIME type claimed by the caller; used only when the extension is unknown. */
  mimeType: string;
  sizeBytes: number;
}

export interface Classification {
  kind: AttachmentKind;
  /** Resolved MIME type. The extension wins over the caller's claim. */
  mimeType: string;
}

export interface ExtractTextInput {
  filePath: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ExtractTextBytesInput {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
}

export interface ExtractTextResult {
  /** Extracted text, or `null` when there is none to send. */
  text: string | null;
  contentStatus: ContentStatus;
  /** User-facing sentence; `null` when the contents were extracted cleanly. */
  note: string | null;
}

/* ----------------------------------------------------------- format table -- */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Extensions whose contents are text in the broad sense — decoded plain text, or
 * a document format the extractor turns into text. PDF and DOCX live here
 * because their *result* is text; the `text` kind describes the outcome, not the
 * container.
 */
const TEXT_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['json', 'application/json'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['xml', 'application/xml'],
  ['html', 'text/html'],
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['ts', 'text/plain'],
  ['tsx', 'text/plain'],
  ['jsx', 'text/plain'],
  ['py', 'text/plain'],
  ['rb', 'text/plain'],
  ['go', 'text/plain'],
  ['rs', 'text/plain'],
  ['java', 'text/plain'],
  ['kt', 'text/plain'],
  ['c', 'text/plain'],
  ['cpp', 'text/plain'],
  ['h', 'text/plain'],
  ['cs', 'text/plain'],
  ['php', 'text/plain'],
  ['sh', 'text/plain'],
  ['ps1', 'text/plain'],
  ['sql', 'text/plain'],
  ['ini', 'text/plain'],
  ['toml', 'text/plain'],
  ['conf', 'text/plain'],
  ['log', 'text/plain'],
  ['pdf', 'application/pdf'],
  ['docx', DOCX_MIME],
]);

const IMAGE_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

const AUDIO_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['webm', 'audio/webm'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
]);

/**
 * The extensions this module classifies as `kind`, read from the tables above.
 *
 * Callers use this to build a native picker's filter, so the dialog can only
 * offer file types the attachment service already accepts. It is a selector over
 * the existing tables rather than a list of its own: adding a format above
 * updates the dialog and the ingest path together, and neither can drift from
 * the other.
 *
 * Audio has no arm here because no picker offers audio — recordings arrive
 * through the recorder — but the tables and `classifyFile` still accept them.
 */
export function extensionsForKind(kind: 'text' | 'image'): readonly string[] {
  return kind === 'image'
    ? [...IMAGE_MIME_BY_EXTENSION.keys()]
    : [...TEXT_MIME_BY_EXTENSION.keys()];
}

const KNOWN_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const KNOWN_AUDIO_MIMES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
]);

const TEXT_LIKE_APPLICATION_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
]);

const UNSUPPORTED_NOTE =
  'Files of this type are not supported. Attach a PDF, a Word document, a text or code file, or a PNG/JPEG/WebP/GIF image.';

const UNREADABLE_NOTE = 'This file could not be read. Check that it still exists and that you can open it.';

const TOO_LARGE_NOTE = `This file is larger than the ${Math.round(
  ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024),
)} MB attachment limit.`;

/* -------------------------------------------------------- classification --- */

function extensionOf(name: string): string {
  const base = name.trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

function normaliseMime(mimeType: string): string {
  const first = mimeType.split(';')[0] ?? '';
  const lowered = first.trim().toLowerCase();
  if (lowered === 'image/jpg') return 'image/jpeg';
  return lowered;
}

/** MIME type implied by the filename alone, or the fallback for unknown types. */
export function mimeTypeForFile(name: string, mimeType = ''): string {
  const extension = extensionOf(name);
  const fromExtension =
    TEXT_MIME_BY_EXTENSION.get(extension) ??
    IMAGE_MIME_BY_EXTENSION.get(extension) ??
    AUDIO_MIME_BY_EXTENSION.get(extension);
  if (fromExtension !== undefined) return fromExtension;
  const declared = normaliseMime(mimeType);
  return declared.length > 0 ? declared : 'application/octet-stream';
}

/**
 * Classifies a file by extension, falling back to the declared MIME type only
 * when the extension says nothing. Content is verified later, by extraction and
 * by the image header probe: a `.png` that is not a PNG is rejected there, not
 * trusted here.
 */
export function classifyFile(input: ClassifyFileInput): Classification {
  const extension = extensionOf(input.name);
  const textMime = TEXT_MIME_BY_EXTENSION.get(extension);
  if (textMime !== undefined) return { kind: 'text', mimeType: textMime };

  const imageMime = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (imageMime !== undefined) return { kind: 'image', mimeType: imageMime };

  const audioMime = AUDIO_MIME_BY_EXTENSION.get(extension);
  if (audioMime !== undefined) return { kind: 'audio', mimeType: audioMime };

  const declared = normaliseMime(input.mimeType);
  if (declared.startsWith('text/')) return { kind: 'text', mimeType: declared };
  if (TEXT_LIKE_APPLICATION_MIMES.has(declared)) return { kind: 'text', mimeType: declared };
  if (KNOWN_IMAGE_MIMES.has(declared)) return { kind: 'image', mimeType: declared };
  if (KNOWN_AUDIO_MIMES.has(declared)) return { kind: 'audio', mimeType: declared };

  const fallback = declared.length > 0 ? declared : 'application/octet-stream';
  return { kind: 'unsupported', mimeType: fallback };
}

/* ------------------------------------------------------------ extraction --- */

function result(text: string | null, contentStatus: ContentStatus, note: string | null): ExtractTextResult {
  return { text, contentStatus, note };
}

function failed(note: string): ExtractTextResult {
  return result(null, 'failed', note);
}

/** Append a visible marker when the text is clamped, never silently shorten. */
function clampExtractedText(text: string): ExtractTextResult {
  const max = ATTACHMENT_LIMITS.maxExtractedChars;
  if (text.length <= max) return result(text, 'extracted', null);
  return result(`${text.slice(0, max)}\n\n[truncated]`, 'extracted', null);
}

function countNullBytes(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, 64 * 1024);
  let nulls = 0;
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) nulls += 1;
  }
  return nulls;
}

function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

function extractPlainText(bytes: Uint8Array, name: string): ExtractTextResult {
  if (bytes.length === 0) {
    return failed('This file is empty — there is no text to send.');
  }

  // A binary renamed to `.txt` would decode to replacement characters and be
  // sent as if it were readable prose. The NUL ratio is the cheapest reliable
  // signal that this is not text.
  if (countNullBytes(bytes) > Math.min(bytes.length, 64 * 1024) * 0.1) {
    return failed(
      'This file looks like a binary file, not text, even though its name suggests otherwise. Its contents were not read.',
    );
  }

  const body = stripUtf8Bom(bytes);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(body);
  } catch {
    return failed(`The text inside ${name} could not be decoded as UTF-8.`);
  }
  if (decoded.trim().length === 0) {
    return failed('This file contains no readable text.');
  }
  return clampExtractedText(decoded);
}

/**
 * An encrypted PDF often announces itself in the trailer. pdf.js also throws a
 * `PasswordException`, which the catch below maps to the same answer; this
 * pre-scan makes the common case deterministic and names the cause instead of
 * reporting a generic "could not be read".
 */
function looksEncryptedPdf(bytes: Uint8Array): boolean {
  const tailSize = Math.min(bytes.length, 4096);
  const start = bytes.length - tailSize;
  let tail = '';
  for (let index = start; index < bytes.length; index += 1) {
    tail += String.fromCharCode(bytes[index] ?? 0);
  }
  return /\/Encrypt[\s\d<[/(]/.test(tail);
}

function isPasswordError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  if (name === 'PasswordException') return true;
  const message = error instanceof Error ? error.message : '';
  return /password/i.test(message);
}

function pdfFailure(error: unknown): ExtractTextResult {
  if (isPasswordError(error)) {
    return failed(
      'This PDF is password-protected. Remove the password (or export an unprotected copy) and attach it again.',
    );
  }
  return failed(
    'This PDF could not be read. It may be corrupt, or not really a PDF file. Try exporting it again.',
  );
}

async function extractPdfText(bytes: Uint8Array): Promise<ExtractTextResult> {
  if (looksEncryptedPdf(bytes)) {
    return failed(
      'This PDF is password-protected. Remove the password (or export an unprotected copy) and attach it again.',
    );
  }
  try {
    // Lazily loaded: pdf.js is several megabytes and a chat-only session must
    // never pay for it. `unpdf` is ESM-only, so this is a real dynamic import.
    const unpdf = await import('unpdf');
    const document = await unpdf.getDocumentProxy(new Uint8Array(bytes));
    const extracted = await unpdf.extractText(document, { mergePages: true });
    const text = extracted.text.trim();
    if (text.length === 0) {
      return result(
        null,
        'metadata-only',
        'This PDF contains no extractable text — it may be a scanned image. Its contents were not sent.',
      );
    }
    return clampExtractedText(text);
  } catch (error) {
    return pdfFailure(error);
  }
}

interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

/** `mammoth` is CommonJS; the namespace wrapper differs between loaders. */
function asMammothModule(value: unknown): MammothModule | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { extractRawText?: unknown };
  if (typeof candidate.extractRawText === 'function') return candidate as MammothModule;
  const nested = (value as { default?: unknown }).default;
  if (typeof nested === 'object' && nested !== null) {
    const nestedCandidate = nested as { extractRawText?: unknown };
    if (typeof nestedCandidate.extractRawText === 'function') return nestedCandidate as MammothModule;
  }
  return null;
}

async function extractDocxText(bytes: Uint8Array): Promise<ExtractTextResult> {
  try {
    // Lazily loaded: the OOXML reader is never touched for a chat-only session.
    const loaded: unknown = await import('mammoth');
    const mammoth = asMammothModule(loaded);
    if (mammoth === null) {
      return failed('The Word document reader is not available in this build.');
    }
    const extracted = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = extracted.value.trim();
    if (text.length === 0) {
      return result(
        null,
        'metadata-only',
        'This Word document contains no extractable text. Its contents were not sent.',
      );
    }
    return clampExtractedText(text);
  } catch {
    return failed(
      'This Word document could not be read. It may be corrupt, or not really a .docx file. Try saving it again from Word.',
    );
  }
}

function isPdf(name: string, mimeType: string): boolean {
  return extensionOf(name) === 'pdf' || normaliseMime(mimeType) === 'application/pdf';
}

function isDocx(name: string, mimeType: string): boolean {
  return extensionOf(name) === 'docx' || normaliseMime(mimeType) === DOCX_MIME;
}

/**
 * Extracts text from bytes that are already in memory (drag-and-drop and paste
 * arrive this way). Shares every branch with the file-path entry point so the
 * two can never diverge.
 */
export async function extractTextFromBytes(input: ExtractTextBytesInput): Promise<ExtractTextResult> {
  const classification = classifyFile({
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
  });

  if (classification.kind === 'unsupported') return failed(UNSUPPORTED_NOTE);
  if (classification.kind === 'image') {
    return result(
      null,
      'metadata-only',
      'Images are sent as image data, not as extracted text.',
    );
  }
  if (classification.kind === 'audio') {
    return result(
      null,
      'metadata-only',
      'Recordings are transcribed before they are sent; the file itself is not read as text.',
    );
  }

  if (input.bytes.length > ATTACHMENT_LIMITS.maxFileBytes) return failed(TOO_LARGE_NOTE);

  if (isPdf(input.name, classification.mimeType)) return extractPdfText(input.bytes);
  if (isDocx(input.name, classification.mimeType)) return extractDocxText(input.bytes);
  return extractPlainText(input.bytes, input.name);
}

export type BoundedRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'unreadable' | 'too-large' };

/**
 * Reads at most `maxBytes` from a file.
 *
 * A plain `readFileSync` trusts the `stat` that preceded it; a file that grows
 * between the two calls (or a path swapped for a device) could still be read in
 * full. Reading through a bounded buffer makes the cap a property of the read
 * rather than of the earlier check.
 */
export function readBoundedFile(filePath: string, maxBytes: number): BoundedRead {
  let handle: number;
  try {
    handle = fs.openSync(filePath, 'r');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(handle, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, bytes: buffer.subarray(0, offset) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Reads a file from disk and extracts its text. Never throws: every failure is
 * an `ExtractTextResult` with `contentStatus: 'failed'` and a sentence the UI
 * can show as-is.
 */
export async function extractText(input: ExtractTextInput): Promise<ExtractTextResult> {
  const classification = classifyFile(input);

  if (classification.kind === 'unsupported') return failed(UNSUPPORTED_NOTE);
  if (classification.kind === 'image') {
    return result(null, 'metadata-only', 'Images are sent as image data, not as extracted text.');
  }
  if (classification.kind === 'audio') {
    return result(
      null,
      'metadata-only',
      'Recordings are transcribed before they are sent; the file itself is not read as text.',
    );
  }

  let sizeBytes: number;
  try {
    const stat = fs.statSync(input.filePath);
    if (!stat.isFile()) return failed('Only files can be attached, not folders.');
    sizeBytes = stat.size;
  } catch {
    return failed(UNREADABLE_NOTE);
  }
  if (sizeBytes > ATTACHMENT_LIMITS.maxFileBytes) return failed(TOO_LARGE_NOTE);

  const read = readBoundedFile(input.filePath, ATTACHMENT_LIMITS.maxFileBytes);
  if (!read.ok) {
    // `too-large` means it grew past the limit between stat and read.
    return failed(read.reason === 'too-large' ? TOO_LARGE_NOTE : UNREADABLE_NOTE);
  }

  return extractTextFromBytes({
    bytes: read.bytes,
    name: input.name,
    mimeType: classification.mimeType,
  });
}
