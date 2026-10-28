/**
 * Sync state for the Cloud Sync screen.
 *
 * Two reads (status and conflicts) plus a live subscription: the engine pushes a
 * status on every state change, so the panel does not poll. A failure to read is
 * surfaced once, with the error code, rather than being rendered as an empty
 * healthy state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { asAppError } from '@shared/errors';
import type { AppErrorShape, SyncConflict, SyncStatus } from '@shared/types';
import { getApi } from '@renderer/lib/api';

export type SyncLoadStatus = 'loading' | 'ready' | 'error';

export interface SyncResource {
  status: SyncLoadStatus;
  sync: SyncStatus | null;
  conflicts: SyncConflict[];
  error: AppErrorShape | null;
  reload(): Promise<void>;
  reloadConflicts(): Promise<void>;
  applyStatus(next: SyncStatus): void;
}

export function useSyncState(): SyncResource {
  const [status, setStatus] = useState<SyncLoadStatus>('loading');
  const [sync, setSyncStatus] = useState<SyncStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [error, setError] = useState<AppErrorShape | null>(null);

  const alive = useRef(true);
  const ticket = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const current = ticket.current + 1;
    ticket.current = current;
    setStatus('loading');
    setError(null);
    try {
      const api = getApi();
      const [nextStatus, nextConflicts] = await Promise.all([
        api.sync.status(),
        api.sync.conflicts(),
      ]);
      if (!alive.current || ticket.current !== current) return;
      setSyncStatus(nextStatus);
      setConflicts(nextConflicts);
      setStatus('ready');
    } catch (thrown) {
      if (!alive.current || ticket.current !== current) return;
      setError(asAppError(thrown));
      setStatus('error');
    }
  }, []);

  const reloadConflicts = useCallback(async (): Promise<void> => {
    try {
      const list = await getApi().sync.conflicts();
      if (alive.current) setConflicts(list);
    } catch {
      // The status panel already reports any sync failure; a failed refresh of a
      // secondary list must not replace it with a second, different error.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = getApi().sync.onStatus((next) => {
        if (alive.current) setSyncStatus(next);
      });
    } catch {
      unsubscribe = null;
    }
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const conflictCount = sync?.conflictCount ?? 0;
  const loadedConflicts = conflicts.length;

  useEffect(() => {
    if (status !== 'ready') return;
    if (conflictCount > 0 && loadedConflicts !== conflictCount) void reloadConflicts();
  }, [status, conflictCount, loadedConflicts, reloadConflicts]);

  const applyStatus = useCallback((next: SyncStatus): void => {
    setSyncStatus(next);
  }, []);

  return { status, sync, conflicts, error, reload, reloadConflicts, applyStatus };
}
