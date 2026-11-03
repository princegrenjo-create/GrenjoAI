/**
 * The composer's attachment state: what is attached, what was refused and why,
 * and the two ways a file arrives (the native picker, or a drop the renderer
 * reads itself).
 *
 * The list is kept in a ref beside the state so a sequential ingest loop always
 * appends to the true current list rather than to a stale render's copy.
 */
import { useCallback, useRef, useState } from 'react';
import type { AttachmentPickOptions } from '@shared/api';
import type { AttachmentMeta, AttachmentPickResult } from '@shared/attachments';
import { toAppError } from '@shared/errors';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { dropRejection, splitIncoming, toBase64, type RejectedFile } from './attachments';

export interface ComposerAttachments {
  attachments: AttachmentMeta[];
  rejections: RejectedFile[];
  /** True while a picker dialog is open or a drop is being read. */
  busy: boolean;
  /** True while files are over the composer, so the drop zone can show itself. */
  dragging: boolean;
  /**
   * Opens the native picker and ingests what the user chose. `options.kinds`
   * only narrows which files the dialog offers; the main process still decides
   * what is accepted.
   */
  pick(options?: AttachmentPickOptions): Promise<void>;
  /** Reads dropped files in the renderer and hands their bytes to the service. */
  addFiles(files: ReadonlyArray<File>): Promise<void>;
  /** Adds a recording the voice recorder produced. */
  addAttachment(attachment: AttachmentMeta): void;
  /** Removes one attachment, here and in the main process. */
  remove(id: string): Promise<void>;
  /** Drops every chip without deleting anything — used after a successful send. */
  clear(): void;
  dismissRejections(): void;
  setDragging(dragging: boolean): void;
}

export function useComposerAttachments(): ComposerAttachments {
  const [attachments, setAttachmentsState] = useState<AttachmentMeta[]>([]);
  const [rejections, setRejections] = useState<RejectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const attachmentsRef = useRef<AttachmentMeta[]>([]);

  const commit = useCallback((next: AttachmentMeta[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  }, []);

  const reject = useCallback((items: RejectedFile[]) => {
    if (items.length === 0) return;
    setRejections((current) => [...current, ...items]);
  }, []);

  const applyResult = useCallback(
    (result: AttachmentPickResult) => {
      if (result.cancelled) return;
      const { accepted, rejected } = splitIncoming(attachmentsRef.current, result.attachments);
      if (accepted.length > 0) commit([...attachmentsRef.current, ...accepted]);
      reject([...result.rejected, ...rejected]);
    },
    [commit, reject],
  );

  const pick = useCallback(async (options?: AttachmentPickOptions) => {
    setBusy(true);
    try {
      applyResult(await getApi().attachments.pick(options));
    } catch (error) {
      reject([
        { name: 'The file picker', reason: errorSummary(toAppError(error)) },
      ]);
    } finally {
      setBusy(false);
    }
  }, [applyResult, reject]);

  const addFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      setDragging(false);
      setBusy(true);
      try {
        for (const file of files) {
          // Size and count are decided from the declared metadata, before any
          // bytes are read: a 2 GB drop must not be read to learn it is too big.
          const refusal = dropRejection(attachmentsRef.current.length, file);
          if (refusal) {
            reject([refusal]);
            continue;
          }
          try {
            const dataBase64 = toBase64(await file.arrayBuffer());
            const result = await getApi().attachments.ingestBytes({
              name: file.name || 'dropped-file',
              mimeType: file.type || 'application/octet-stream',
              dataBase64,
              kindHint: file.type.startsWith('image/') ? 'image' : 'file',
            });
            applyResult(result);
          } catch (error) {
            reject([{ name: file.name, reason: errorSummary(toAppError(error)) }]);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [applyResult, reject],
  );

  const addAttachment = useCallback(
    (attachment: AttachmentMeta) => {
      const { accepted, rejected } = splitIncoming(attachmentsRef.current, [attachment]);
      if (accepted.length > 0) commit([...attachmentsRef.current, ...accepted]);
      reject(rejected);
    },
    [commit, reject],
  );

  const remove = useCallback(
    async (id: string) => {
      const index = attachmentsRef.current.findIndex((item) => item.id === id);
      const target = attachmentsRef.current[index];
      if (!target) return;
      commit(attachmentsRef.current.filter((item) => item.id !== id));
      try {
        await getApi().attachments.remove(id);
      } catch (error) {
        // Put the chip back where it was: the bytes are still on this machine,
        // and a chip that vanished while the file was kept would be a lie about
        // what is attached to the message.
        const restored = [...attachmentsRef.current];
        restored.splice(Math.min(index, restored.length), 0, target);
        commit(restored);
        reject([
          { name: target.name, reason: `It could not be removed. ${errorSummary(toAppError(error))}` },
        ]);
      }
    },
    [commit, reject],
  );

  const clear = useCallback(() => {
    commit([]);
  }, [commit]);

  const dismissRejections = useCallback(() => {
    setRejections([]);
  }, []);

  return {
    attachments,
    rejections,
    busy,
    dragging,
    pick,
    addFiles,
    addAttachment,
    remove,
    clear,
    dismissRejections,
    setDragging,
  };
}
