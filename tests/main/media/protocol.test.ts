/**
 * The `media://` scheme and the adapter registry.
 *
 * The URL helpers are pure, so what is asserted here is the boundary: which URLs
 * this app is willing to produce, and which of them a caller is allowed to turn
 * back into a path. The Electron half (`protocol.handle`) is exercised only in the
 * packaged app; these tests cover the decisions it depends on.
 */
import { describe, expect, it } from 'vitest';
import { contentTypeFor, mediaUrlFor, relativePathFromMediaUrl } from '@main/media/protocol';
import { createMediaAdapterRegistry } from '@main/media/registry';
import type { MediaJobAdapter } from '@shared/media-job';

const SHA = 'a'.repeat(64);
const STORED = `${SHA.slice(0, 2)}/${SHA}.png`;

const adapter: MediaJobAdapter = {
  supportsCancel: false,
  maxConcurrent: null,
  async submit() {
    return { kind: 'pending', remoteId: 'r', pollUrl: null, progress: 0 };
  },
  async poll() {
    return { kind: 'pending', remoteId: 'r', pollUrl: null, progress: 0 };
  },
};

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

describe('adapter registry', () => {
  it('reports absence rather than throwing when a provider has no adapter', () => {
    const registry = createMediaAdapterRegistry();
    expect(registry.get('p-1')).toBeNull();
    expect(registry.ids()).toEqual([]);
  });

  it('keeps adapters separate per provider, so two of one kind do not share state', () => {
    const registry = createMediaAdapterRegistry();
    registry.set('p-1', adapter);
    registry.set('p-2', adapter);
    expect(registry.get('p-1')).toBe(adapter);
    expect(registry.get('p-2')).toBe(adapter);
    expect(registry.ids().sort()).toEqual(['p-1', 'p-2']);

    registry.remove('p-1');
    expect(registry.get('p-1')).toBeNull();
    expect(registry.get('p-2')).toBe(adapter);
  });
});
