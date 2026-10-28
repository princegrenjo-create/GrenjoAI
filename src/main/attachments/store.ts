/**
 * Pending attachment registry.
 *
 * The renderer never sees a path or a byte: it holds opaque ids, and the bytes
 * live here, in the main process. A payload is *pending* — it exists between the
 * moment the user adds a file and the moment the turn is persisted (or the user
 * removes the chip), and `release`/`remove` drop it again.
 *
 * Image bytes are optionally mirrored to a directory the caller names (the
 * profile's `attachments` folder in production). The mirror makes the write
 * durable across a crash between ingest and send, and the filename is derived
 * from the id — never from the user's filename — so a crafted name such as
 * `..\\..\\evil.png` cannot choose where the bytes land.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentPayload } from '@shared/attachments';
import type { Logger } from '../logger';
import { imageDataUrl, sniffImageMime } from './images';

export interface AttachmentStoreOptions {
  /**
   * Absolute directory for the image mirror, or `null` to keep everything in
   * memory (tests, and any caller that opted out of disk usage).
   */
  directory: string | null;
  logger?: Logger;
}

export interface AttachmentStore {
  /** Registers a payload, mirroring image bytes to disk when configured. */
  add(payload: AttachmentPayload): AttachmentPayload;
  get(id: string): AttachmentPayload | null;
  /** Drops the payload and deletes its mirrored bytes. */
  remove(id: string): void;
  /** Drops a payload once the turn is persisted; its bytes are no longer held. */
  release(id: string): void;
  /** Inline data URL for a held or mirrored image, or `null`. */
  readImageDataUrl(id: string): string | null;
  /** Clears the registry, deleting any mirrored bytes it still owns. */
  dispose(): void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Deterministic, content-addressed filename: the id never reaches the path. */
function mirrorFileName(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}.bin`;
}

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
  const { directory } = options;
  const log = options.logger?.child('attachments:store');
  const entries = new Map<string, AttachmentPayload>();

  function mirrorPath(id: string): string | null {
    if (directory === null) return null;
    const resolvedDirectory = path.resolve(directory);
    const target = path.resolve(resolvedDirectory, mirrorFileName(id));
    // Defence in depth: the filename is a hash, so this can only trip if the
    // directory itself is relative in an unexpected way.
    if (!target.startsWith(`${resolvedDirectory}${path.sep}`)) return null;
    return target;
  }

  /** Write-then-rename, so a reader never observes a half-written image. */
  function writeAtomic(target: string, bytes: Uint8Array): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = fs.openSync(temporary, 'wx');
    try {
      fs.writeSync(handle, bytes);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
  }

  function deleteMirror(id: string): void {
    const target = mirrorPath(id);
    if (target === null) return;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    } catch (error) {
      // A mirror that cannot be deleted must not fail the user's removal; the
      // registry entry is gone either way, so the file is at worst orphaned.
      log?.warn('Attachment mirror could not be removed', { errorName: errorName(error) });
    }
  }

  return {
    add(payload: AttachmentPayload): AttachmentPayload {
      entries.set(payload.meta.id, payload);
      const target = mirrorPath(payload.meta.id);
      if (target !== null && payload.image !== null) {
        try {
          writeAtomic(target, Buffer.from(payload.image.dataBase64, 'base64'));
        } catch (error) {
          // The payload is still usable from memory; only the crash-durable
          // copy is missing, so this degrades rather than failing the ingest.
          log?.warn('Attachment mirror could not be written', { errorName: errorName(error) });
        }
      }
      return payload;
    },

    get(id: string): AttachmentPayload | null {
      return entries.get(id) ?? null;
    },

    remove(id: string): void {
      entries.delete(id);
      deleteMirror(id);
    },

    release(id: string): void {
      entries.delete(id);
      deleteMirror(id);
    },

    readImageDataUrl(id: string): string | null {
      const payload = entries.get(id);
      if (payload !== undefined && payload.image !== null) {
        return imageDataUrl(
          Buffer.from(payload.image.dataBase64, 'base64'),
          payload.image.mimeType,
        );
      }
      const target = mirrorPath(id);
      if (target === null || !fs.existsSync(target)) return null;
      try {
        const bytes = fs.readFileSync(target);
        const mimeType = sniffImageMime(bytes);
        if (mimeType === null) return null;
        return imageDataUrl(bytes, mimeType);
      } catch (error) {
        log?.warn('Attachment mirror could not be read', { errorName: errorName(error) });
        return null;
      }
    },

    dispose(): void {
      for (const id of entries.keys()) deleteMirror(id);
      entries.clear();
    },
  };
}
