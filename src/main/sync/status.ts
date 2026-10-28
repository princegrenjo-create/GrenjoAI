/**
 * Observable sync status.
 *
 * The renderer must never be flooded by status updates: a pull applies rows one by one
 * and each apply can change the pending/conflict counters. Emissions are therefore
 * throttled to at most four per second (250 ms), with a trailing emit so the last state
 * is not lost. Time and scheduling are injected so the throttle can be tested without
 * waiting for a real timer.
 */
import type { SyncStatus } from '@shared/types';

/** Four emissions per second. */
export const STATUS_EMIT_MIN_INTERVAL_MS = 250;

export type StatusScheduler = (run: () => void, delayMs: number) => () => void;

export interface SyncStatusStore {
  get(): SyncStatus;
  update(patch: Partial<SyncStatus>): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Deliver the current status immediately, ignoring the throttle (final states). */
  flush(): void;
  dispose(): void;
}

export interface SyncStatusStoreOptions {
  now: () => number;
  schedule?: StatusScheduler;
  minIntervalMs?: number;
}

const defaultSchedule: StatusScheduler = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

export function createInitialSyncStatus(): SyncStatus {
  return {
    enabled: false,
    signedIn: false,
    email: null,
    userId: null,
    phase: 'idle',
    pendingCount: 0,
    conflictCount: 0,
    lastSyncedAt: null,
    lastError: null,
    online: true,
  };
}

export function createSyncStatusStore(
  initial: SyncStatus,
  options: SyncStatusStoreOptions,
): SyncStatusStore {
  const schedule = options.schedule ?? defaultSchedule;
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? STATUS_EMIT_MIN_INTERVAL_MS);
  const listeners = new Set<(status: SyncStatus) => void>();
  let current: SyncStatus = { ...initial };
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let cancelTrailing: (() => void) | null = null;
  let disposed = false;

  function deliver(): void {
    if (disposed) return;
    for (const listener of [...listeners]) listener(current);
  }

  function emitIfDue(): void {
    if (disposed || listeners.size === 0) return;
    const elapsed = options.now() - lastEmitAt;
    if (elapsed >= minIntervalMs) {
      if (cancelTrailing !== null) {
        cancelTrailing();
        cancelTrailing = null;
      }
      lastEmitAt = options.now();
      deliver();
      return;
    }
    if (cancelTrailing !== null) return;
    cancelTrailing = schedule(() => {
      cancelTrailing = null;
      if (disposed) return;
      lastEmitAt = options.now();
      deliver();
    }, minIntervalMs - elapsed);
  }

  return {
    get(): SyncStatus {
      return current;
    },

    update(patch: Partial<SyncStatus>): SyncStatus {
      current = { ...current, ...patch };
      emitIfDue();
      return current;
    },

    subscribe(listener: (status: SyncStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flush(): void {
      if (cancelTrailing !== null) {
        cancelTrailing();
        cancelTrailing = null;
      }
      lastEmitAt = options.now();
      deliver();
    },

    dispose(): void {
      disposed = true;
      if (cancelTrailing !== null) {
        cancelTrailing();
        cancelTrailing = null;
      }
      listeners.clear();
    },
  };
}
