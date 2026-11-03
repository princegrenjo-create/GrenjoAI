/**
 * The `media://` scheme.
 *
 * The URL helpers are pure, so what is asserted here is the boundary: which URLs
 * this app is willing to produce, and which of them a caller is allowed to turn
 * back into a path. The Electron half (`protocol.handle`) is exercised only in the
 * packaged app; these tests cover the decisions it depends on.
 */
import { describe, expect, it } from 'vitest';
import { contentTypeFor, mediaUrlFor, relativePathFromMediaUrl } from '@main/media/protocol';

const SHA = 'a'.repeat(64);
const STORED = `${SHA.slice(0, 2)}/${SHA}.png`;

describe('media url', () => {
  it('round-trips a stored path through a URL the renderer can use', () => {
    const url = mediaUrlFor(STORED);
    expect(url).toBe(`media://local/${STORED}`);
    expect(relativePathFromMediaUrl(url)).toBe(STORED);
  });

  it('never embeds an absolute path', () => {
    const url = mediaUrlFor(STORED);
    expect(url).not.toContain(':\\\\');
    expect(url.startsWith('media://local/')).toBe(true);
  });

  it('refuses a URL that is not this app’s media scheme', () => {
    for (const candidate of [
      'file:///C:/Windows/win.ini',
      'https://example.com/a.png',
      'media://elsewhere/ab/x.png',
      'media://local/',
      'not a url',
      '',
    ]) {
      expect(relativePathFromMediaUrl(candidate), candidate).toBeNull();
    }
  });

  it('decodes a percent-encoded path once', () => {
    const url = `media://local/ab/${'b'.repeat(64)}.png`;
    expect(relativePathFromMediaUrl(url)).toBe(`ab/${'b'.repeat(64)}.png`);
    // A traversal arrives encoded; decoding is what lets the store's own pattern
    // check reject it rather than the URL parser silently normalising it away.
    expect(relativePathFromMediaUrl('media://local/..%2F..%2Fetc%2Fpasswd')).toBe('../../etc/passwd');
  });

  it('serves a content type from the extension we chose', () => {
    expect(contentTypeFor('ab/x.png')).toBe('image/png');
    expect(contentTypeFor('ab/x.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('ab/x.mp4')).toBe('video/mp4');
    expect(contentTypeFor('ab/x.webm')).toBe('video/webm');
    expect(contentTypeFor('ab/x.bin')).toBe('application/octet-stream');
  });
});

describe('media:// parsing refuses what it cannot read', () => {
  it('returns null for a malformed percent escape instead of throwing', () => {
    /*
     * The documented contract is "the relative path, or null". A thrown URIError
     * would reject the protocol handler's promise — an unhandled rejection in the
     * main process — where the correct answer is a 404.
     */
    expect(() => relativePathFromMediaUrl('media://local/%E0%A4%A')).not.toThrow();
    expect(relativePathFromMediaUrl('media://local/%E0%A4%A')).toBeNull();
    expect(relativePathFromMediaUrl('media://local/ab%ZZ')).toBeNull();
  });
});