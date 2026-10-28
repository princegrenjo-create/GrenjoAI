/**
 * Image header probing and validation.
 *
 * These tests feed hand-built container headers, because the point is that the
 * probe reads dimensions out of PNG, JPEG, WebP and GIF bytes with no image
 * library — and refuses bytes whose declared type does not match their contents.
 */
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@shared/attachments';
import { probeImage, sniffImageMime, validateImage } from '@main/attachments/images';
import {
  gifBytes,
  jpegBytes,
  pngBytes,
  webpVp8Bytes,
  webpVp8lBytes,
  webpVp8xBytes,
} from './fixtures';

describe('probeImage', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(probeImage(pngBytes(640, 480))).toEqual({
      format: 'png',
      mimeType: 'image/png',
      width: 640,
      height: 480,
    });
  });

  it('reads JPEG dimensions from the SOF0 segment', () => {
    expect(probeImage(jpegBytes(800, 600))).toEqual({
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('reads WebP dimensions from VP8X, VP8L and VP8 headers', () => {
    expect(probeImage(webpVp8xBytes(1024, 768))).toMatchObject({ width: 1024, height: 768 });
    expect(probeImage(webpVp8lBytes(300, 200))).toMatchObject({ width: 300, height: 200 });
    expect(probeImage(webpVp8Bytes(320, 240))).toMatchObject({ width: 320, height: 240 });
  });

  it('reads GIF dimensions from the logical screen descriptor', () => {
    expect(probeImage(gifBytes(50, 40))).toMatchObject({ width: 50, height: 40 });
  });

  it('returns null for bytes that are not an image, or are truncated', () => {
    expect(probeImage(Buffer.from('just some text'))).toBeNull();
    expect(probeImage(Buffer.alloc(0))).toBeNull();
    expect(probeImage(pngBytes(10, 10).subarray(0, 10))).toBeNull();
    expect(probeImage(pngBytes(0, 10))).toBeNull();
  });

  it('sniffs the MIME type from the content', () => {
    expect(sniffImageMime(pngBytes(1, 1))).toBe('image/png');
    expect(sniffImageMime(Buffer.from('nope'))).toBeNull();
  });
});

describe('validateImage', () => {
  it('accepts a PNG and builds an inline preview', () => {
    const result = validateImage({ bytes: pngBytes(12, 34), mimeType: 'image/png' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(12);
    expect(result.height).toBe(34);
    expect(result.mimeType).toBe('image/png');
    expect(result.previewDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('treats image/jpg as image/jpeg', () => {
    const result = validateImage({ bytes: jpegBytes(4, 4), mimeType: 'image/jpg' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe('image/jpeg');
  });

  it('skips the inline preview for an image above the preview limit', () => {
    const bytes = Buffer.concat([pngBytes(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.maxPreviewBytes)]);
    const result = validateImage({ bytes, mimeType: 'image/png' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previewDataUrl).toBeNull();
      expect(result.width).toBe(1);
    }
  });

  it('refuses an image over the image byte limit', () => {
    const bytes = Buffer.concat([pngBytes(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.maxImageBytes)]);
    const result = validateImage({ bytes, mimeType: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/larger than/i);
  });

  it('refuses a MIME/extension mismatch', () => {
    const result = validateImage({ bytes: pngBytes(8, 8), mimeType: 'image/jpeg' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/declared as image\/jpeg/i);
  });

  it('refuses a .png whose contents are not a PNG', () => {
    const result = validateImage({ bytes: Buffer.from('<html>not an image</html>'), mimeType: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid/i);
  });

  it('refuses empty bytes', () => {
    const result = validateImage({ bytes: Buffer.alloc(0), mimeType: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });
});
