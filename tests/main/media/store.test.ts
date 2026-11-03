/**
 * The media store is the boundary between "bytes we hold" and "a path someone
 * asked for". Every test here is about that boundary: it must write where it says,
 * find the same file twice, and refuse a path it did not create.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaPathError, MediaStore } from '@main/media/store';

let root: string;
let store: MediaStore;

beforeEach(() => {
  // The store must not scatter files outside the run sink.
  root = mkdtempSync(path.join(process.cwd(), '.work', 'test-runtime', 'media-store-'));
  store = new MediaStore({ rootDir: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('media store', () => {
  it('stores content-addressed bytes and reports their identity', () => {
    const stored = store.save(PNG, 'image/png', 'image');
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.relativePath).toBe(`${stored.sha256.slice(0, 2)}/${stored.sha256}.png`);
    expect(stored.bytes).toBe(PNG.byteLength);
    expect(store.read(stored.relativePath).equals(PNG)).toBe(true);
    expect(store.size(stored.relativePath)).toBe(PNG.byteLength);
    expect(store.totalBytes()).toBe(PNG.byteLength);
  });

  it('is idempotent: the same bytes are one file', () => {
    const first = store.save(PNG, 'image/png', 'image');
    const second = store.save(Buffer.from(PNG), 'image/png', 'image');
    expect(second.relativePath).toBe(first.relativePath);
    expect(store.totalBytes()).toBe(PNG.byteLength);
  });

  it('names the file from the MIME type, never from provider input', () => {
    const jpeg = store.save(Buffer.from('jpeg-bytes'), 'image/jpeg', 'image');
    expect(jpeg.relativePath.endsWith('.jpg')).toBe(true);
    const video = store.save(Buffer.from('mp4-bytes'), 'video/mp4', 'video');
    expect(video.relativePath.endsWith('.mp4')).toBe(true);
    const unknown = store.save(Buffer.from('other-bytes'), 'application/octet-stream', 'image');
    expect(unknown.relativePath.endsWith('.bin')).toBe(true);
  });

  it('refuses a path it did not write', () => {
    for (const candidate of [
      '../../../etc/passwd',
      '..\\..\\windows\\system32\\config',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      'ab/short.png',
      'ab/' + 'a'.repeat(64) + '.png/../../x',
      '',
    ]) {
      expect(() => store.resolve(candidate), candidate).toThrow(MediaPathError);
    }
  });

  it('accepts a path it wrote and rejects a traversal of the same shape', () => {
    const stored = store.save(PNG, 'image/png', 'image');
    expect(() => store.resolve(stored.relativePath)).not.toThrow();
    expect(() => store.resolve(`${stored.relativePath}/../../../etc/passwd`)).toThrow(MediaPathError);
  });

  it('refuses an empty file and one over the ceiling', () => {
    expect(() => store.save(Buffer.alloc(0), 'image/png', 'image')).toThrow(/empty/i);
    const tiny = new MediaStore({ rootDir: root, maxFileBytes: 8 });
    expect(() => tiny.save(Buffer.alloc(9), 'image/png', 'image')).toThrow(/larger than/i);
  });

  it('deletes exactly one file and reports an absent one honestly', () => {
    const first = store.save(PNG, 'image/png', 'image');
    const second = store.save(Buffer.from('a different image'), 'image/png', 'image');

    expect(store.remove(first.relativePath)).toBe(true);
    expect(store.exists(first.relativePath)).toBe(false);
    expect(store.exists(second.relativePath)).toBe(true);
    expect(store.totalBytes()).toBe(second.bytes);

    // A second delete of the same path is not a success: nothing was removed.
    expect(store.remove(first.relativePath)).toBe(false);
  });

  it('leaves no temp file behind, on success or on a refused write', () => {
    const stored = store.save(PNG, 'image/png', 'image');
    expect(store.exists(stored.relativePath)).toBe(true);

    // Force the write to fail at the directory step: the shard path a real save
    // would need is occupied by a file, so mkdir cannot create it.
    const bytes = Buffer.from('will-not-be-written');
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(root, digest.slice(0, 2)), 'not a directory');
    expect(() => store.save(bytes, 'image/png', 'image')).toThrow();

    const leftovers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tmp')) leftovers.push(full);
      }
    };
    walk(root);
    expect(leftovers).toEqual([]);
  });
});
