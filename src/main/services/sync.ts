/**
 * The sync controller is the surface the IPC layer talks to.
 *
 * It is deliberately thinner than the engine: the engine owns queueing, retries,
 * conflicts and Supabase calls, while this adapter owns the app-level truth —
 * is sync switched on, is a URL configured, where the URL and key are persisted,
 * and what the UI should show when sync is not available.
 *
 * The engine's own return types are richer than the IPC surface needs (it returns
 * an outcome object per call), so this adapter folds each result back into a
 * single `SyncStatus`, which is all the renderer renders.
 */
import type {
  SyncAuthInput,
  SyncConfigInput,
  SyncConflict,
  SyncStatus,
} from '@shared/types';
import type { SyncEngine } from '../sync/engine';

export interface SignUpOutcome {
  status: SyncStatus;
  needsConfirmation: boolean;
}

export interface SyncController {
  status(): Promise<SyncStatus>;
  configure(input: SyncConfigInput): Promise<SyncStatus>;
  signIn(input: SyncAuthInput): Promise<SyncStatus>;
  signUp(input: SyncAuthInput): Promise<SignUpOutcome>;
  signOut(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  conflicts(): Promise<SyncConflict[]>;
  resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): Promise<SyncStatus>;
  dispose(): void;
}

export interface SyncControllerOptions {
  /** Null when the engine could not be constructed (for example a bad URL). */
  engine: SyncEngine | null;
  isEnabled: () => boolean;
  isConfigured: () => boolean;
  isOnline: () => boolean;
  /**
   * Persists the configuration: the URL into local settings, the publishable key
   * into the OS credential store. Never into SQLite.
   */
  saveConfig: (input: SyncConfigInput) => Promise<void>;
}

function unavailableStatus(input: {
  enabled: boolean;
  configured: boolean;
  online: boolean;
}): SyncStatus {
  return {
    enabled: input.enabled,
    signedIn: false,
    email: null,
    userId: null,
    // `needs_config` is the honest phase: the feature exists, it is simply not
    // wired to a project yet. It is never reported as `idle` while enabled.
    phase: input.enabled ? 'needs_config' : 'idle',
    pendingCount: 0,
    conflictCount: 0,
    lastSyncedAt: null,
    lastError: input.enabled
      ? {
          code: 'sync_config',
          message: input.configured
            ? 'Cloud sync is enabled but the engine is not running. Restart the app and try again.'
            : 'Add your Supabase project URL and publishable key to turn cloud sync on.',
          retryable: false,
        }
      : null,
    online: input.online,
  };
}

export function createSyncController(options: SyncControllerOptions): SyncController {
  const { engine } = options;

  function fallback(): SyncStatus {
    return unavailableStatus({
      enabled: options.isEnabled(),
      configured: options.isConfigured(),
      online: options.isOnline(),
    });
  }

  function requireEngine(): SyncEngine {
    if (!engine) {
      throw new Error('Cloud sync is not configured. Add a Supabase URL and publishable key first.');
    }
    return engine;
  }

  return {
    async status() {
      return engine ? engine.status() : fallback();
    },

    async configure(input) {
      await options.saveConfig(input);
      if (!engine) return fallback();
      return engine.status();
    },

    async signIn(input) {
      await requireEngine().signIn(input);
      return requireEngine().status();
    },

    async signUp(input) {
      const outcome = await requireEngine().signUp(input);
      return {
        status: requireEngine().status(),
        needsConfirmation: outcome.needsEmailConfirmation,
      };
    },

    async signOut() {
      if (!engine) return fallback();
      await engine.signOut();
      return engine.status();
    },

    async syncNow() {
      if (!engine) return fallback();
      await engine.syncNow();
      return engine.status();
    },

    async conflicts() {
      return engine ? engine.conflicts() : [];
    },

    async resolveConflict(id, resolution) {
      const active = requireEngine();
      active.resolveConflict(id, resolution);
      return active.status();
    },

    dispose() {
      engine?.dispose();
    },
  };
}
