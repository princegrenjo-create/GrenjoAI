/**
 * Pending attachment registry.
 *
 * Covers the two properties that matter for privacy and hygiene: the bytes are
 * reachable only through an opaque id, and a filename the user controls can
 * never decide a path on disk. Every file lives under the run sink and is
 * removed with it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentPayload } from '@shared/attachments';
import { createNullLogger } from '@main/logger';
import { createAttachmentStore } from '@main/attachments/store';
import { pngBytes } from './fixtures';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;

afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

function ensureScratch(): ScratchDir {
  if (scratch === null) scratch = scratchDir('attachments-store');
  return scratch;
}

function makePayload(
  id: string,
  options: { name?: string; image?: Buffer | null } = {},
): AttachmentPayload {
  const imageBytes = options.image ?? null;
  const name = options.name ?? 'photo.png';
  return {
    meta: {
      id,
      kind: imageBytes === null ? 'text' : 'image',
      name,
      mimeType: imageBytes === null ? 'text/plain' : 'image/png',
      sizeBytes: imageBytes?.length ?? 5,
      contentStatus: 'extracted',
      contentNote: null,
      extractedChars: imageBytes === null ? 5 : null,
      sentToProvider: true,
      imageWidth: imageBytes === null ? null : 1,
      imageHeight: imageBytes === null ? null : 1,
      previewDataUrl: null,
      durationMs: null,
      createdAt: '2026-10-29T00:00:00.000Z',
    },
    text: imageBytes === null ? 'hello' : null,
    image:
      imageBytes === null
        ? null
        : { dataBase64: Buffer.from(imageBytes).toString('base64'), mimeType: 'image/png' },
    filePath: null,
  };
}

function mirrorFile(directory: string, id: string): string {
  return path.join(directory, `${createHash('sha256').update(id).digest('hex')}.bin`);
}

describe('attachment store', () => {
  it('keeps payloads in memory when no directory is configured', () => {
    const store = createAttachmentStore({ directory: null, logger: createNullLogger() });
    const payload = makePayload('memory-id', { image: pngBytes(2, 3) });
    store.add(payload);

    expect(store.get('memory-id')?.meta.id).toBe('memory-id');
    expect(store.readImageDataUrl('memory-id')).toBe(
      `data:image/png;base64,${Buffer.from(pngBytes(2, 3)).toString('base64')}`,
    );
  });

  it('mirrors image bytes under a hashed filename and deletes them on remove', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    const id = 'mirrored-id';
    store.add(makePayload(id, { image: pngBytes(4, 5) }));

    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(fs.existsSync(mirrorFile(directory, id))).toBe(true);

    store.remove(id);

    expect(store.get(id)).toBeNull();
    expect(fs.existsSync(mirrorFile(directory, id))).toBe(false);
    expect(fs.readdirSync(directory)).toHaveLength(0);
  });

  it('deletes the mirror on release, so an unsent file does not outlive the turn', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    const id = 'released-id';
    store.add(makePayload(id, { image: pngBytes(4, 5) }));
    expect(store.get(id)).not.toBeNull();

    store.release(id);

    expect(store.get(id)).toBeNull();
    expect(fs.readdirSync(directory)).toHaveLength(0);
  });

  it('never uses the user-supplied filename for a path', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    const id = '../../escape';
    store.add(makePayload(id, { name: '../../evil.png', image: pngBytes(1, 1) }));

    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('evil');
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(fs.existsSync(path.join(directory, '..', 'evil.png'))).toBe(false);
    expect(store.readImageDataUrl(id)?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('does not mirror a document payload', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    store.add(makePayload('doc-id'));
    expect(fs.readdirSync(directory)).toHaveLength(0);
    expect(store.readImageDataUrl('doc-id')).toBeNull();
  });

  it('still serves an image that only exists as a mirror on disk', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    const id = 'disk-only-id';
    fs.writeFileSync(mirrorFile(directory, id), pngBytes(6, 7));

    const dataUrl = store.readImageDataUrl(id);
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(pngBytes(6, 7)).toString('base64')}`);
  });

  it('clears the registry and its mirrors on dispose', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    store.add(makePayload('dispose-id', { image: pngBytes(1, 1) }));
    store.add(makePayload('dispose-doc'));

    store.dispose();

    expect(store.get('dispose-id')).toBeNull();
    expect(store.get('dispose-doc')).toBeNull();
    expect(fs.readdirSync(directory)).toHaveLength(0);
  });

  it('tolerates removing an id it never held', () => {
    const directory = ensureScratch().path;
    const store = createAttachmentStore({ directory, logger: createNullLogger() });
    expect(() => store.remove('never-added')).not.toThrow();
    expect(store.readImageDataUrl('never-added')).toBeNull();
  });
});
