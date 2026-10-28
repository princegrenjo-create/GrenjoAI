/**
 * Attachment ingestion for mobile.
 *
 * Platform reality, stated up front: the desktop build parses PDF and DOCX with
 * `unpdf` and `mammoth`, which need Node APIs and are not available in React
 * Native. Mobile therefore extracts text from text-shaped files only (txt, md,
 * csv, json, yaml, xml, source code) and marks anything else as
 * `contentStatus: 'metadata-only'` with a note that the contents were not read.
 * Nothing pretends a PDF was analysed.
 *
 * Files are read locally; only extracted text and explicitly attached image bytes
 * are ever sent to a provider.
 */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentMeta,
  type MessageAttachment,
} from '@core/attachments';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c',
  'h', 'cpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'ini', 'toml', 'conf', 'log',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

export function classifyName(name: string, mimeType: string): { kind: AttachmentKind; mimeType: string } {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith('image/')) {
    const resolved = ext === 'jpg' ? 'jpeg' : ext;
    return { kind: 'image', mimeType: mimeType || `image/${resolved}` };
  }
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/') || mimeType === 'application/json') {
    return { kind: 'text', mimeType: mimeType || 'text/plain' };
  }
  return { kind: 'unsupported', mimeType: mimeType || 'application/octet-stream' };
}

let counter = 0;
function newAttachmentId(): string {
  counter += 1;
  return `att_${Date.now().toString(36)}_${counter}`;
}

export interface IngestedAttachment {
  meta: AttachmentMeta;
  /** Extracted text, when the format allowed it. */
  text: string | null;
  /** Image bytes as base64, when it is an image. */
  image: { dataBase64: string; mimeType: string } | null;
  /** Local uri, kept for transcription only (audio). */
  uri: string;
}

export interface RejectedFile {
  name: string;
  reason: string;
}

export interface IngestResult {
  attachments: IngestedAttachment[];
  rejected: RejectedFile[];
}

function emptyMeta(): AttachmentMeta {
  return {
    id: '',
    kind: 'unsupported',
    name: '',
    mimeType: '',
    sizeBytes: 0,
    contentStatus: 'failed',
    contentNote: null,
    extractedChars: null,
    sentToProvider: false,
    imageWidth: null,
    imageHeight: null,
    previewDataUrl: null,
    durationMs: null,
    createdAt: new Date().toISOString(),
  };
}

/** Read a text file and truncate to the shared limit, marking the truncation. */
async function readText(uri: string): Promise<{ text: string; truncated: boolean }> {
  const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  const limit = ATTACHMENT_LIMITS.maxExtractedChars;
  if (raw.length <= limit) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, limit)}\n\n[truncated]`, truncated: true };
}

async function ingestOne(input: {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  asImage?: boolean;
}): Promise<IngestedAttachment | RejectedFile> {
  const size = input.sizeBytes ?? 0;
  if (size > ATTACHMENT_LIMITS.maxFileBytes) {
    return {
      name: input.name,
      reason: `Files must be ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MB or smaller.`,
    };
  }

  const classified = input.asImage
    ? { kind: 'image' as const, mimeType: input.mimeType || 'image/jpeg' }
    : classifyName(input.name, input.mimeType);
  const meta: AttachmentMeta = {
    ...emptyMeta(),
    id: newAttachmentId(),
    kind: classified.kind,
    name: input.name,
    mimeType: classified.mimeType,
    sizeBytes: size,
  };

  if (classified.kind === 'image') {
    if (size > ATTACHMENT_LIMITS.maxImageBytes) {
      return {
        name: input.name,
        reason: `Images must be ${Math.round(ATTACHMENT_LIMITS.maxImageBytes / (1024 * 1024))} MB or smaller.`,
      };
    }
    const dataBase64 = await FileSystem.readAsStringAsync(input.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (dataBase64.length === 0) {
      return { name: input.name, reason: 'That image is empty.' };
    }
    return {
      meta: {
        ...meta,
        contentStatus: 'extracted',
        sentToProvider: true,
        previewDataUrl:
          dataBase64.length * 0.75 <= ATTACHMENT_LIMITS.maxPreviewBytes
            ? `data:${classified.mimeType};base64,${dataBase64}`
            : null,
      },
      text: null,
      image: { dataBase64, mimeType: classified.mimeType },
      uri: input.uri,
    };
  }

  if (classified.kind === 'text') {
    try {
      const { text, truncated } = await readText(input.uri);
      if (text.trim().length === 0) {
        return { name: input.name, reason: 'That file is empty — there is no text to send.' };
      }
      return {
        meta: {
          ...meta,
          contentStatus: 'extracted',
          extractedChars: text.length,
          contentNote: truncated
            ? `Only the first ${ATTACHMENT_LIMITS.maxExtractedChars.toLocaleString()} characters were sent.`
            : null,
        },
        text,
        image: null,
        uri: input.uri,
      };
    } catch {
      return { name: input.name, reason: 'That file could not be read.' };
    }
  }

  return {
    meta: {
      ...meta,
      contentStatus: 'metadata-only',
      contentNote:
        'This format cannot be read on mobile. Only the file name and size are available to the model — PDF and Word text extraction is desktop-only in this release.',
    },
    text: null,
    image: null,
    uri: input.uri,
  };
}

function isRejected(value: IngestedAttachment | RejectedFile): value is RejectedFile {
  return 'reason' in value;
}

export async function pickDocuments(): Promise<IngestResult> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    type: ['text/*', 'application/json', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  });
  if (result.canceled) return { attachments: [], rejected: [] };

  const outcomes = await Promise.all(
    result.assets
      .slice(0, ATTACHMENT_LIMITS.maxPerMessage)
      .map((asset) =>
        ingestOne({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? '',
          sizeBytes: asset.size ?? null,
        }),
      ),
  );
  return {
    attachments: outcomes.filter((outcome): outcome is IngestedAttachment => !isRejected(outcome)),
    rejected: outcomes.filter(isRejected),
  };
}

export async function pickImage(source: 'library' | 'camera'): Promise<IngestResult> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {
        attachments: [],
        rejected: [{ name: 'Camera', reason: 'Camera access was not granted, so nothing was taken.' }],
      };
    }
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    base64: true,
    quality: 0.8,
    allowsMultipleSelection: source === 'library',
    selectionLimit: ATTACHMENT_LIMITS.maxPerMessage,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return { attachments: [], rejected: [] };

  const attachments: IngestedAttachment[] = [];
  const rejected: RejectedFile[] = [];
  for (const asset of result.assets.slice(0, ATTACHMENT_LIMITS.maxPerMessage)) {
    const name = asset.fileName ?? `photo-${Date.now()}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    const mimeType = asset.mimeType ?? 'image/jpeg';
    if (!asset.base64) {
      rejected.push({ name, reason: 'The image could not be read from the picker.' });
      continue;
    }
    const sizeBytes = Math.round((asset.base64.length * 3) / 4);
    if (sizeBytes > ATTACHMENT_LIMITS.maxImageBytes) {
      rejected.push({
        name,
        reason: `Images must be ${Math.round(ATTACHMENT_LIMITS.maxImageBytes / (1024 * 1024))} MB or smaller.`,
      });
      continue;
    }
    attachments.push({
      meta: {
        ...emptyMeta(),
        id: newAttachmentId(),
        kind: 'image',
        name,
        mimeType,
        sizeBytes,
        contentStatus: 'extracted',
        sentToProvider: true,
        imageWidth: asset.width ?? null,
        imageHeight: asset.height ?? null,
        previewDataUrl:
          sizeBytes <= ATTACHMENT_LIMITS.maxPreviewBytes ? `data:${mimeType};base64,${asset.base64}` : null,
      },
      text: null,
      image: { dataBase64: asset.base64, mimeType },
      uri: asset.uri,
    });
  }
  return { attachments, rejected };
}

/**
 * Attach a finished recording. Audio is never sent to the chat model; it is
 * either transcribed first or attached as a file the model can see the name of.
 */
export function recordingAttachment(input: {
  uri: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number | null;
}): IngestedAttachment {
  return {
    meta: {
      ...emptyMeta(),
      id: newAttachmentId(),
      kind: 'audio',
      name: `voice-memo-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.m4a`,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes ?? 0,
      contentStatus: 'metadata-only',
      contentNote: 'Recordings are transcribed, not sent as audio to the chat model.',
      durationMs: input.durationMs,
    },
    text: null,
    image: null,
    uri: input.uri,
  };
}

export function toMessageAttachments(items: ReadonlyArray<IngestedAttachment>): MessageAttachment[] {
  return items.map((item) => ({
    id: item.meta.id,
    kind: item.meta.kind,
    name: item.meta.name,
    mimeType: item.meta.mimeType,
    sizeBytes: item.meta.sizeBytes,
    contentStatus: item.meta.contentStatus,
    contentNote: item.meta.contentNote,
    extractedChars: item.meta.extractedChars,
    sentToProvider: item.meta.sentToProvider,
    imageWidth: item.meta.imageWidth,
    imageHeight: item.meta.imageHeight,
    durationMs: item.meta.durationMs,
    createdAt: item.meta.createdAt,
  }));
}
