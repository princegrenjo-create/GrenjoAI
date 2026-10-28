/**
 * Image header probing and validation, with no image library.
 *
 * A provider request carries image bytes inline, so the main process has to know
 * three things before it sends anything: what the bytes actually are, how big the
 * picture is, and whether the file the user named matches its own contents. The
 * first two are read from the container header in a few dozen bytes; the third is
 * a comparison between the sniffed format and the declared MIME type. That is
 * enough to refuse a `.png` that is really a JPEG (or an HTML page), without
 * decoding or re-encoding a single pixel.
 */
import { ATTACHMENT_LIMITS } from '@shared/attachments';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageHeader {
  format: ImageFormat;
  mimeType: string;
  width: number;
  height: number;
}

export interface ImageValidationSuccess {
  ok: true;
  width: number;
  height: number;
  /** Sniffed MIME type — the authority, not the caller's claim. */
  mimeType: string;
  previewDataUrl: string | null;
}

export interface ImageValidationFailure {
  ok: false;
  reason: string;
}

export type ImageValidation = ImageValidationSuccess | ImageValidationFailure;

/** Safe byte read: out-of-range is `-1`, which matches no signature. */
function at(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1;
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (at(bytes, offset + index) !== text.charCodeAt(index)) return false;
  }
  return true;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (at(bytes, offset) << 8) | at(bytes, offset + 1);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return at(bytes, offset) | (at(bytes, offset + 1) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return at(bytes, offset) | (at(bytes, offset + 1) << 8) | (at(bytes, offset + 2) << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (at(bytes, offset) << 24) |
    (at(bytes, offset + 1) << 16) |
    (at(bytes, offset + 2) << 8) |
    at(bytes, offset + 3)
  ) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function probePng(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (at(bytes, index) !== PNG_SIGNATURE[index]) return null;
  }
  // The first chunk of a PNG is always IHDR, with a fixed 13-byte body.
  if (u32be(bytes, 8) !== 13 || !matchesAscii(bytes, 12, 'IHDR')) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { format: 'png', mimeType: 'image/png', width, height };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function probeJpeg(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || at(bytes, 0) !== 0xff || at(bytes, 1) !== 0xd8) return null;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (at(bytes, offset) !== 0xff) {
      // Not at a marker boundary: resynchronise byte by byte rather than fail.
      offset += 1;
      continue;
    }

    let marker = at(bytes, offset + 1);
    // Any number of 0xFF fill bytes may precede a marker.
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= bytes.length) return null;
      marker = at(bytes, offset + 1);
    }

    // Markers that carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // End of image, or the compressed scan, before any frame header was seen.
    if (marker === 0xd9 || marker === 0xda) return null;

    const segmentLength = u16be(bytes, offset + 2);
    if (segmentLength < 2) return null;

    if (isJpegStartOfFrame(marker)) {
      if (offset + 8 >= bytes.length) return null;
      // SOF: precision(1), height(2), width(2) after the length field.
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      if (width <= 0 || height <= 0) return null;
      return { format: 'jpeg', mimeType: 'image/jpeg', width, height };
    }

    offset += 2 + segmentLength;
  }
  return null;
}

function probeWebp(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 30) return null;
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return null;

  if (matchesAscii(bytes, 12, 'VP8 ')) {
    // Lossy: the frame tag is three bytes, then the 9D 01 2A start code.
    if (at(bytes, 23) !== 0x9d || at(bytes, 24) !== 0x01 || at(bytes, 25) !== 0x2a) return null;
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { format: 'webp', mimeType: 'image/webp', width, height };
  }

  if (matchesAscii(bytes, 12, 'VP8L')) {
    // Lossless: 0x2F signature, then 14 bits width-1 and 14 bits height-1.
    if (at(bytes, 20) !== 0x2f) return null;
    const packed =
      at(bytes, 21) | (at(bytes, 22) << 8) | (at(bytes, 23) << 16) | (at(bytes, 24) << 24);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    if (width <= 0 || height <= 0) return null;
    return { format: 'webp', mimeType: 'image/webp', width, height };
  }

  if (matchesAscii(bytes, 12, 'VP8X')) {
    // Extended: 24-bit little-endian canvas width-1 and height-1.
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    if (width <= 0 || height <= 0) return null;
    return { format: 'webp', mimeType: 'image/webp', width, height };
  }

  return null;
}

function probeGif(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 10) return null;
  if (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a')) return null;
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  if (width <= 0 || height <= 0) return null;
  return { format: 'gif', mimeType: 'image/gif', width, height };
}

/** Reads width/height from a PNG, JPEG, WebP or GIF header, or `null`. */
export function probeImage(bytes: Uint8Array): ImageHeader | null {
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeWebp(bytes) ?? probeGif(bytes);
}

/** Sniffed MIME type of supported image bytes, or `null` for anything else. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  return probeImage(bytes)?.mimeType ?? null;
}

/** Data URL for inline previews and provider image parts. */
export function imageDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function normaliseDeclaredMime(mimeType: string): string {
  const first = mimeType.split(';')[0] ?? '';
  const lowered = first.trim().toLowerCase();
  if (lowered === 'image/jpg') return 'image/jpeg';
  return lowered;
}

/**
 * Validates image bytes before they can become an attachment.
 *
 * The rule that matters: the declared MIME type must agree with what the bytes
 * actually are. A `.png` containing JPEG data is refused rather than sent, because
 * a provider would either reject the request or guess at the format.
 */
export function validateImage(input: { bytes: Uint8Array; mimeType: string }): ImageValidation {
  const { bytes } = input;
  if (bytes.length === 0) {
    return { ok: false, reason: 'This image file is empty.' };
  }
  if (bytes.length > ATTACHMENT_LIMITS.maxImageBytes) {
    return {
      ok: false,
      reason: `This image is larger than the ${Math.round(
        ATTACHMENT_LIMITS.maxImageBytes / (1024 * 1024),
      )} MB image limit and was not added.`,
    };
  }

  const header = probeImage(bytes);
  if (header === null) {
    return {
      ok: false,
      reason:
        'This file is not a valid PNG, JPEG, WebP or GIF image, so it was not attached.',
    };
  }

  const declared = normaliseDeclaredMime(input.mimeType);
  if (
    declared.length > 0 &&
    declared !== 'application/octet-stream' &&
    declared.startsWith('image/') &&
    declared !== header.mimeType
  ) {
    return {
      ok: false,
      reason: `This file was declared as ${declared} but its contents are ${header.mimeType}. It was not attached.`,
    };
  }

  const previewDataUrl =
    bytes.length <= ATTACHMENT_LIMITS.maxPreviewBytes ? imageDataUrl(bytes, header.mimeType) : null;

  return {
    ok: true,
    width: header.width,
    height: header.height,
    mimeType: header.mimeType,
    previewDataUrl,
  };
}
