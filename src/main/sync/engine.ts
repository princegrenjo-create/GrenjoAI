/**
 * Local-first sync engine.
 *
 * SQLite is authoritative. The engine only *reads* the durable outbox and *applies*
 * remote records through the frozen `SyncRepository` contract; it never writes SQL and
 * never blocks a local write on the network.
 *
 * One cycle:
 *   pull (providers, models, agents, conversations, messages, settings)
 *   -> push the same order from `db.sync.pending()`
 *   -> refresh counters and the status store.
 *
 * Failure semantics:
 *  - Offline: phase `offline`, rows stay pending, nothing throws.
 *  - Temporary (429 / 5xx / network): bounded in-cycle retries with exponential backoff
 *    (800 ms, x2, 5 min cap, jitter), then `markFailed` records the next attempt time.
 *  - Auth/config: phase `error` / `needs_config`, surfaced as the mapped AppErrorShape.
 *  - A newer remote row over a dirty local row is a conflict: the local row is never
 *    overwritten and it is not pushed until the user resolves the conflict, so a stale
 *    local edit cannot silently overwrite the newer remote row either.
 */
import type { RemoteEntity, SyncPendingRow, SyncRepository } from '@shared/repository-contract';
import type { AppErrorShape, SyncAuthInput, SyncConflict, SyncEntityKind, SyncStatus } from '@shared/types';
import { AppError, appError } from '@shared/errors';
import {
  parseRemoteRow,
  type SyncClientFactory,
  type SyncCloudClient,
  type SyncPullInput,
  type SyncRemoteRow,
  type SyncSession,
  type SyncTableApi,
} from './client';
import { isRetryableSyncError, mapSyncError, redactKnownSecrets } from './errors';
import {
  containsCredentialShapedValue,
  isPlainJsonObject,
  resolveRemoteDeletedAt,
  resolveRemoteUpdatedAt,
  sanitizeForSync,
} from './payload';
import { createInitialSyncStatus, createSyncStatusStore, type SyncStatusStore } from './status';
import { ENTITY_NOUN, SYNC_ENTITY_ORDER, SYNC_TABLE_BY_ENTITY } from './tables';
import {
  REQUEST_TIMEOUT_MS_DEFAULT,
  withTimeout,
  type SyncRequestOperation,
  type TimerScheduler,
} from './timeout';

/* ---------------------------------------------------------------- constants -- */

export const BACKOFF_BASE_MS = 800;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_MAX_MS = 300_000;
export const BACKOFF_JITTER_RATIO = 0.2;
export const MAX_PUSH_ATTEMPTS_DEFAULT = 3;
export const PUSH_BATCH_LIMIT_DEFAULT = 200;
export const PULL_PAGE_LIMIT_DEFAULT = 500;

const WATERMARK_PREFIX = 'sync.watermark.v1';
const WATERMARK_EPOCH = '1970-01-01T00:00:00.000Z';
/** The outbox page used to look up a local revision for a conflict (contract gap workaround). */
const LOCAL_REVISION_LOOKUP_LIMIT = 500;

/* ------------------------------------------------------------------- types -- */

/** Narrow view of `Database`: the engine only needs the sync repository. */
export interface SyncEngineDatabase {
  readonly sync: SyncRepository;
}

export interface SyncCredentials {
  url: string;
  anonKey: string;
}

export interface SyncEngineOptions {
  db: SyncEngineDatabase;
  clientFactory: SyncClientFactory;
  /** Reads the URL + publishable key from the OS credential store. */
  credentialProvider: () => Promise<SyncCredentials | null>;
  onStatus?: (status: SyncStatus) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Injected online probe (main process passes a real check; tests control it). */
  isOnline?: () => boolean;
  /** Whether the user has sync switched on in settings. */
  isEnabled?: () => boolean;
  pullLimit?: number;
  pushLimit?: number;
  maxPushAttempts?: number;
  /** Bounded timeout for every Supabase request. Default 30 000 ms. */
  requestTimeoutMs?: number;
  /** Test seam for the request timeout; production uses the real `setTimeout`. */
  setTimer?: TimerScheduler;
}

export interface SyncSummary {
  ok: boolean;
  pushed: number;
  pulled: number;
  failed: number;
  conflictsRecorded: number;
  skipped: number;
  pendingCount: number;
  conflictCount: number;
  phase: SyncStatus['phase'];
}

export interface SyncSignInOutcome {
  signedIn: boolean;
  needsEmailConfirmation: boolean;
  email: string | null;
  userId: string | null;
}

export interface SyncEngine {
  status(): SyncStatus;
  start(): Promise<void>;
  signIn(input: SyncAuthInput): Promise<SyncSignInOutcome>;
  signUp(input: SyncAuthInput): Promise<SyncSignInOutcome>;
  signOut(): Promise<void>;
  syncNow(): Promise<SyncSummary>;
  conflicts(): SyncConflict[];
  resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): void;
  dispose(): void;
}

interface SyncCounts {
  pushed: number;
  pulled: number;
  failed: number;
  conflictsRecorded: number;
  skipped: number;
}

/* --------------------------------------------------------------- backoff ----- */

/**
 * Exponential backoff with jitter. Never negative, never above the 5 minute cap — an
 * unbounded retry loop is how a sync client turns a server incident into a client one.
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponential = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, safeAttempt - 1);
  const capped = Math.min(exponential, BACKOFF_MAX_MS);
  const rawRandom = random();
  const unit = Number.isFinite(rawRandom) ? Math.min(Math.max(rawRandom, 0), 1) : 0;
  const jitter = Math.floor(capped * BACKOFF_JITTER_RATIO * unit);
  return Math.min(Math.max(0, capped + jitter), BACKOFF_MAX_MS);
}

/* ------------------------------------------------------------------ engine --- */

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const db = options.db;
  const clientFactory = options.clientFactory;
  const credentialProvider = options.credentialProvider;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? (() => Math.random());
  const isOnline = options.isOnline ?? (() => true);
  const isEnabled = options.isEnabled ?? (() => true);
  const pullLimit = Math.max(1, options.pullLimit ?? PULL_PAGE_LIMIT_DEFAULT);
  const pushLimit = Math.max(1, options.pushLimit ?? PUSH_BATCH_LIMIT_DEFAULT);
  const maxPushAttempts = Math.max(1, options.maxPushAttempts ?? MAX_PUSH_ATTEMPTS_DEFAULT);
  const requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs);

  const statusStore: SyncStatusStore = createSyncStatusStore(createInitialSyncStatus(), { now });
  if (options.onStatus) statusStore.subscribe(options.onStatus);

  let client: SyncCloudClient | null = null;
  let configuredUrl: string | null = null;
  let configuredAnonKey: string | null = null;
  let authUnsubscribe: (() => void) | null = null;
  let session: SyncSession | null = null;
  let inFlight: Promise<SyncSummary> | null = null;
  let started = false;
  let disposed = false;
  let lastSyncedAt: string | null = null;
  let lastError: AppErrorShape | null = null;

  /* ------------------------------------------------------------- utilities -- */

  function isoAt(milliseconds: number): string {
    const safe = Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 8.64e15)) : 0;
    return new Date(safe).toISOString();
  }

  function probeOnline(): boolean {
    try {
      return isOnline();
    } catch {
      // An online probe that throws is treated as offline: never send a request blind.
      return false;
    }
  }

  function safeCount(read: () => number, fallback: number): number {
    try {
      return read();
    } catch {
      // Counters are cosmetic; a storage hiccup must not break the status surface.
      return fallback;
    }
  }

  function mapError(error: unknown): AppErrorShape {
    return redactKnownSecrets(mapSyncError(error), [configuredAnonKey]);
  }

  /**
   * The single wrapper every cloud call goes through. A stalled socket rejects here with
   * `SyncTimeoutError`, which `mapSyncError` turns into the shared retryable `timeout`
   * error shape.
   */
  function request<T>(operation: SyncRequestOperation, task: Promise<T>): Promise<T> {
    return withTimeout(operation, task, {
      timeoutMs: requestTimeoutMs,
      setTimer: options.setTimer,
    });
  }

  function phaseForFailure(mapped: AppErrorShape): SyncStatus['phase'] {
    if (mapped.code === 'sync_config') return 'needs_config';
    if (mapped.code === 'offline' || !probeOnline()) return 'offline';
    return 'error';
  }

  /** Record a failed request on the status surface and return the throwable shape. */
  function publishRequestFailure(error: unknown): AppError {
    const mapped = mapError(error);
    lastError = mapped;
    publish({ phase: phaseForFailure(mapped) });
    return new AppError(mapped);
  }

  function offlineFailure(): AppError {
    const mapped = appError('offline', 'You are offline. Connect to the internet and try again.');
    lastError = mapped;
    publish({ phase: 'offline' });
    return new AppError(mapped);
  }

  /** A settled cycle must never leave the status stuck on `syncing`. */
  function settleSyncingPhase(): void {
    if (statusStore.get().phase !== 'syncing') return;
    const failure =
      lastError ??
      appError(
        'provider_error',
        'Cloud sync stopped without reporting a result. The next attempt will retry.',
        { retryable: true },
      );
    lastError = failure;
    publish({ phase: phaseForFailure(failure) });
  }

  function keyOf(entity: SyncEntityKind, entityId: string): string {
    return `${entity}:${entityId}`;
  }

  function publish(patch: Partial<SyncStatus>): SyncStatus {
    const current = statusStore.get();
    const next: Partial<SyncStatus> = {
      ...patch,
      enabled: !disposed && isEnabled() && configuredUrl !== null,
      online: probeOnline(),
      pendingCount: safeCount(() => db.sync.pendingCount(), current.pendingCount),
      conflictCount: safeCount(() => db.sync.conflictCount(), current.conflictCount),
      lastSyncedAt,
      lastError,
    };
    return statusStore.update(next);
  }

  function unresolvedConflictKeys(): Set<string> {
    const keys = new Set<string>();
    try {
      for (const conflict of db.sync.conflicts()) {
        if (conflict.resolution === 'unresolved') keys.add(keyOf(conflict.entity, conflict.entityId));
      }
    } catch {
      // Conflict state is advisory for the push gate; a read failure must not stop a push
      // pass. The pull pass would have thrown before this point on real storage errors.
      return keys;
    }
    return keys;
  }

  /**
   * The frozen contract reports `'conflict'` without the local revision, so the engine
   * looks the dirty row up in the outbox, which carries it. Returns 0 when the row is not
   * currently visible (for example it is inside its retry backoff window).
   */
  function localRevisionFor(entity: SyncEntityKind, entityId: string): number {
    try {
      const rows = db.sync.pending(LOCAL_REVISION_LOOKUP_LIMIT);
      const match = rows.find((row) => row.entity === entity && row.entityId === entityId);
      return match ? match.version : 0;
    } catch {
      return 0;
    }
  }

  /* ---------------------------------------------------------------- client -- */

  async function loadCredentials(): Promise<SyncCredentials | null> {
    try {
      return await credentialProvider();
    } catch {
      // The credential store itself failed. Its error text may contain OS paths, so it is
      // replaced by an actionable message rather than forwarded.
      const mapped = appError(
        'sync_config',
        'Cloud sync settings could not be read from the OS credential store. Re-enter the Supabase URL and key.',
        { retryable: false },
      );
      lastError = mapped;
      publish({ phase: 'needs_config', signedIn: false, email: null, userId: null });
      throw new AppError(mapped);
    }
  }

  function handleAuthChange(event: string, next: SyncSession | null): void {
    if (disposed) return;
    session = next;
    if (event === 'signed_out') {
      lastError = null;
      publish({ signedIn: false, email: null, userId: null, phase: 'idle' });
      return;
    }
    if (next !== null) {
      const currentPhase = statusStore.get().phase;
      publish({
        signedIn: true,
        email: next.email,
        userId: next.userId,
        phase: currentPhase === 'needs_config' ? 'idle' : currentPhase,
      });
      return;
    }
    publish({ signedIn: false, email: null, userId: null });
  }

  async function ensureClient(): Promise<SyncCloudClient> {
    if (disposed) {
      throw new AppError(appError('sync_config', 'Cloud sync is not available after it was disposed.'));
    }

    const credentials = await loadCredentials();
    if (
      credentials === null ||
      credentials.url.trim().length === 0 ||
      credentials.anonKey.trim().length === 0
    ) {
      client = null;
      configuredUrl = null;
      configuredAnonKey = null;
      session = null;
      const mapped = appError(
        'sync_config',
        'Cloud sync is not configured yet. Add your Supabase project URL and publishable key in Settings → Sync.',
        { retryable: false },
      );
      lastError = mapped;
      publish({ phase: 'needs_config', signedIn: false, email: null, userId: null });
      throw new AppError(mapped);
    }

    if (client === null || configuredUrl !== credentials.url || configuredAnonKey !== credentials.anonKey) {
      if (authUnsubscribe !== null) {
        authUnsubscribe();
        authUnsubscribe = null;
      }
      session = null;
      const created = clientFactory({ url: credentials.url, anonKey: credentials.anonKey });
      client = created;
      configuredUrl = credentials.url;
      configuredAnonKey = credentials.anonKey;
      authUnsubscribe = created.auth.onAuthStateChange((event, next) => {
        handleAuthChange(event, next);
      });
    }

    const active = client;
    const resolved = await request('session', active.auth.getSession());
    if (resolved.error !== null) {
      const mapped = mapError(resolved.error);
      lastError = mapped;
      throw new AppError(mapped);
    }
    session = resolved.session;
    return active;
  }

  /* ------------------------------------------------------------------ pull -- */

  async function pullEntity(
    cloud: SyncCloudClient,
    userId: string,
    entity: SyncEntityKind,
  ): Promise<{ applied: number; conflicts: number; skipped: number }> {
    const table = cloud.from(SYNC_TABLE_BY_ENTITY[entity]);
    const metaKey = watermarkKey(userId, entity);
    const stored = db.sync.meta.get(metaKey);
    const watermark = isIsoInstant(stored) ? stored : WATERMARK_EPOCH;
    const watermarkMs = Date.parse(watermark);

    const input: SyncPullInput = { userId, watermark, limit: pullLimit };
    let response;
    try {
      response = await request('pull', table.selectAfter(input));
    } catch (err) {
      throw new AppError(mapError(err));
    }
    if (!response.ok) throw new AppError(mapError(response.error));

    let applied = 0;
    let conflicts = 0;
    let skipped = 0;
    let newest = watermark;
    let newestMs = watermarkMs;
    const knownConflicts = unresolvedConflictKeys();

    for (const raw of response.data) {
      if (disposed) break;
      const row = parseRemoteRow(raw);
      if (row === null) {
        skipped += 1;
        continue;
      }
      // Defence in depth: RLS already scopes the query, but a row for another user must
      // never be applied locally even if a policy were misconfigured.
      if (row.user_id !== userId) {
        skipped += 1;
        continue;
      }

      const rowMs = Date.parse(row.updated_at);
      if (Number.isFinite(rowMs) && rowMs > newestMs) {
        newest = row.updated_at;
        newestMs = rowMs;
      }

      const remote: RemoteEntity = {
        id: row.id,
        version: row.version,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        payload: row.payload,
      };

      const result = db.sync.applyRemote(entity, remote);
      if (result === 'applied') {
        applied += 1;
        continue;
      }
      if (result !== 'conflict') continue;

      conflicts += 1;
      const key = keyOf(entity, row.id);
      if (knownConflicts.has(key)) continue;
      db.sync.recordConflict({
        entity,
        entityId: row.id,
        localRevision: localRevisionFor(entity, row.id),
        remoteRevision: row.version,
        summary: `The ${ENTITY_NOUN[entity]} was changed on another device while local edits were pending. Keep the local copy or take the remote one.`,
        remotePayload: row.payload,
      });
      knownConflicts.add(key);
      publish({});
    }

    if (newestMs > watermarkMs) db.sync.meta.set(metaKey, newest);
    return { applied, conflicts, skipped };
  }

  /* ------------------------------------------------------------------ push -- */

  function preparePushRow(row: SyncPendingRow, userId: string): SyncRemoteRow | null {
    if (row.entityId.length === 0 || row.entityId.length > 256) return null;
    if (!Number.isInteger(row.version) || row.version < 0 || row.version > 2147483647) return null;

    const sanitized = sanitizeForSync(row.entity, row.payload);
    if (sanitized.blocked) return null;
    // Defence in depth: even after stripping, nothing credential-shaped may be uploaded.
    if (containsCredentialShapedValue(sanitized.value)) return null;
    if (!isPlainJsonObject(sanitized.value)) return null;

    const nowIso = isoAt(now());
    const updatedAt = resolveRemoteUpdatedAt(sanitized.value, nowIso);
    const deletedAt = row.op === 'delete' ? updatedAt : resolveRemoteDeletedAt(sanitized.value);

    return {
      id: row.entityId,
      user_id: userId,
      version: row.version,
      updated_at: updatedAt,
      deleted_at: deletedAt,
      payload: sanitized.value,
    };
  }

  async function pushWithRetries(
    table: SyncTableApi,
    row: SyncRemoteRow,
  ): Promise<{ ok: true } | { ok: false; error: AppErrorShape }> {
    let lastMapped: AppErrorShape | null = null;
    for (let attempt = 1; attempt <= maxPushAttempts; attempt += 1) {
      let failure: unknown = null;
      try {
        const response = await request('push', table.upsert([row], { onConflict: 'id' }));
        if (response.ok) return { ok: true };
        failure = response.error;
      } catch (err) {
        failure = err;
      }

      lastMapped = mapError(failure);
      if (!isRetryableSyncError(lastMapped) || attempt >= maxPushAttempts) {
        return { ok: false, error: lastMapped };
      }
      await sleep(computeBackoffMs(attempt, random));
    }
    return {
      ok: false,
      error: lastMapped ?? appError('provider_error', 'The upload failed for an unknown reason.'),
    };
  }

  async function pushEntity(
    cloud: SyncCloudClient,
    userId: string,
    entity: SyncEntityKind,
    batch: readonly SyncPendingRow[],
    blockedKeys: ReadonlySet<string>,
    counts: SyncCounts,
  ): Promise<AppErrorShape | null> {
    const rows = batch.filter((row) => row.entity === entity);
    if (rows.length === 0) return null;

    const table = cloud.from(SYNC_TABLE_BY_ENTITY[entity]);
    let failure: AppErrorShape | null = null;

    for (const row of rows) {
      if (disposed) break;
      if (blockedKeys.has(keyOf(entity, row.entityId))) {
        // Never overwrite a newer remote row with a stale local edit; the user resolves it.
        counts.skipped += 1;
        continue;
      }

      const prepared = preparePushRow(row, userId);
      if (prepared === null) {
        const mapped = appError(
          'sync_config',
          'A record was not uploaded because it contains a credential-shaped value or an invalid payload. Remove the secret from the record and sync again.',
          { retryable: false },
        );
        db.sync.markFailed(entity, row.entityId, mapped.message, isoAt(now() + BACKOFF_MAX_MS));
        counts.failed += 1;
        failure = mapped;
        continue;
      }

      const outcome = await pushWithRetries(table, prepared);
      if (outcome.ok) {
        db.sync.markPushed(entity, row.entityId, row.version);
        counts.pushed += 1;
        continue;
      }

      db.sync.markFailed(
        entity,
        row.entityId,
        outcome.error.message,
        isoAt(now() + computeBackoffMs(maxPushAttempts, random)),
      );
      counts.failed += 1;
      failure = outcome.error;
    }

    return failure;
  }

  /* ----------------------------------------------------------------- cycle -- */

  function finish(ok: boolean, counts: SyncCounts, phase: SyncStatus['phase']): SyncSummary {
    return {
      ok: ok && counts.failed === 0,
      pushed: counts.pushed,
      pulled: counts.pulled,
      failed: counts.failed,
      conflictsRecorded: counts.conflictsRecorded,
      skipped: counts.skipped,
      pendingCount: safeCount(() => db.sync.pendingCount(), 0),
      conflictCount: safeCount(() => db.sync.conflictCount(), 0),
      phase,
    };
  }

  function zeroSummary(phase: SyncStatus['phase']): SyncSummary {
    return {
      ok: false,
      pushed: 0,
      pulled: 0,
      failed: 0,
      conflictsRecorded: 0,
      skipped: 0,
      pendingCount: 0,
      conflictCount: 0,
      phase,
    };
  }

  async function runSync(): Promise<SyncSummary> {
    const counts: SyncCounts = { pushed: 0, pulled: 0, failed: 0, conflictsRecorded: 0, skipped: 0 };

    if (!isEnabled()) {
      lastError = null;
      publish({ phase: 'idle' });
      return finish(false, counts, 'idle');
    }

    if (!probeOnline()) {
      lastError = null;
      publish({ phase: 'offline' });
      return finish(false, counts, 'offline');
    }

    let cloud: SyncCloudClient;
    try {
      cloud = await ensureClient();
    } catch (err) {
      const mapped = mapError(err);
      lastError = mapped;
      const phase =
        mapped.code === 'sync_config'
          ? 'needs_config'
          : mapped.code === 'offline'
            ? 'offline'
            : 'error';
      publish({ phase });
      return finish(false, counts, phase);
    }

    if (session === null) {
      const mapped = appError('sync_auth', 'Sign in to your sync account before syncing.', {
        retryable: false,
      });
      lastError = mapped;
      publish({ phase: 'error' });
      return finish(false, counts, 'error');
    }

    const userId = session.userId;
    lastError = null;
    publish({
      phase: 'syncing',
      signedIn: true,
      email: session.email,
      userId,
    });

    let fatal: AppErrorShape | null = null;
    let pushFailure: AppErrorShape | null = null;

    try {
      // Pull everything first so the push pass knows which local rows already conflict.
      for (const entity of SYNC_ENTITY_ORDER) {
        if (disposed) break;
        const pulled = await pullEntity(cloud, userId, entity);
        counts.pulled += pulled.applied;
        counts.conflictsRecorded += pulled.conflicts;
        counts.skipped += pulled.skipped;
      }

      if (!disposed) {
        const blockedKeys = unresolvedConflictKeys();
        const batch = db.sync.pending(pushLimit);
        for (const entity of SYNC_ENTITY_ORDER) {
          if (disposed) break;
          const failure = await pushEntity(cloud, userId, entity, batch, blockedKeys, counts);
          if (failure !== null) pushFailure = failure;
        }
      }
    } catch (err) {
      fatal = mapError(err);
    }

    if (fatal !== null) {
      lastError = fatal;
      const phase = phaseForFailure(fatal);
      publish({ phase });
      return finish(false, counts, phase);
    }

    lastError = pushFailure;
    if (pushFailure === null) lastSyncedAt = isoAt(now());
    const phase: SyncStatus['phase'] = pushFailure === null ? 'idle' : 'error';
    publish({ phase });
    return finish(true, counts, phase);
  }

  /* -------------------------------------------------------------------- API -- */

  async function start(): Promise<void> {
    if (started || disposed) return;
    started = true;
    try {
      await ensureClient();
      lastError = null;
      publish({
        phase: 'idle',
        signedIn: session !== null,
        email: session?.email ?? null,
        userId: session?.userId ?? null,
      });
    } catch (err) {
      const mapped = mapError(err);
      lastError = mapped;
      publish({ phase: phaseForFailure(mapped) });
    }
  }

  async function signIn(input: SyncAuthInput): Promise<SyncSignInOutcome> {
    if (!probeOnline()) throw offlineFailure();
    try {
      const cloud = await ensureClient();
      const result = await request(
        'sign-in',
        cloud.auth.signInWithPassword({ email: input.email, password: input.password }),
      );
      if (result.error !== null) throw new AppError(mapError(result.error));
      if (result.session === null) {
        throw new AppError(
          appError('sync_auth', 'Those email and password were not accepted.', {
            retryable: false,
          }),
        );
      }
      session = result.session;
      lastError = null;
      publish({
        phase: 'idle',
        signedIn: true,
        email: result.session.email,
        userId: result.session.userId,
      });
      return {
        signedIn: true,
        needsEmailConfirmation: false,
        email: result.session.email,
        userId: result.session.userId,
      };
    } catch (err) {
      throw publishRequestFailure(err);
    }
  }

  async function signUp(input: SyncAuthInput): Promise<SyncSignInOutcome> {
    if (!probeOnline()) throw offlineFailure();
    try {
      const cloud = await ensureClient();
      const result = await request(
        'sign-up',
        cloud.auth.signUp({ email: input.email, password: input.password }),
      );
      if (result.error !== null) throw new AppError(mapError(result.error));
      if (result.session === null) {
        lastError = null;
        publish({ phase: 'idle', signedIn: false, email: null, userId: null });
        return { signedIn: false, needsEmailConfirmation: true, email: null, userId: null };
      }
      session = result.session;
      lastError = null;
      publish({
        phase: 'idle',
        signedIn: true,
        email: result.session.email,
        userId: result.session.userId,
      });
      return {
        signedIn: true,
        needsEmailConfirmation: false,
        email: result.session.email,
        userId: result.session.userId,
      };
    } catch (err) {
      throw publishRequestFailure(err);
    }
  }

  async function signOut(): Promise<void> {
    let mapped: AppErrorShape | null = null;
    if (client !== null) {
      try {
        const result = await request('sign-out', client.auth.signOut());
        if (result.error !== null) mapped = mapError(result.error);
      } catch (err) {
        mapped = mapError(err);
      }
    }
    // Session only: local rows, conflicts and the outbox are untouched on purpose.
    session = null;
    lastError = mapped;
    const phase: SyncStatus['phase'] = mapped === null ? 'idle' : phaseForFailure(mapped);
    publish({ phase, signedIn: false, email: null, userId: null });
  }

  function syncNow(): Promise<SyncSummary> {
    if (disposed) return Promise.resolve(zeroSummary('error'));
    if (inFlight !== null) return inFlight;
    const run = runSync()
      .catch((err: unknown) => {
        // Defensive: `runSync` handles its own failures, but the latch must clear even if
        // a future edit lets an error escape before the cycle reports a phase.
        const mapped = mapError(err);
        lastError = mapped;
        const phase = phaseForFailure(mapped);
        publish({ phase });
        return finish(
          false,
          { pushed: 0, pulled: 0, failed: 0, conflictsRecorded: 0, skipped: 0 },
          phase,
        );
      })
      .finally(() => {
        // Release the latch before settling the status, so nothing can observe an
        // `inFlight` promise that is already finished.
        if (inFlight === run) inFlight = null;
        settleSyncingPhase();
      });
    inFlight = run;
    return run;
  }

  function resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): void {
    if (disposed) return;
    const conflict = db.sync.conflicts().find((item) => item.id === id);
    db.sync.resolveConflict(id, resolution);
    if (conflict !== undefined && resolution === 'kept_local') {
      // Kept-local means the local copy must win; make it due immediately instead of
      // waiting for a backoff window that was set when the conflict was detected.
      db.sync.retryNow(conflict.entity, conflict.entityId);
    }
    lastError = null;
    publish({});
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (authUnsubscribe !== null) {
      authUnsubscribe();
      authUnsubscribe = null;
    }
    client = null;
    configuredUrl = null;
    configuredAnonKey = null;
    session = null;
    // Teardown must not leave a stale 'syncing' on the status surface; a run that is
    // still draining publishes its own final phase after this.
    statusStore.update({ phase: 'idle', lastError: null });
    statusStore.dispose();
  }

  return {
    status: () => statusStore.get(),
    start,
    signIn,
    signUp,
    signOut,
    syncNow,
    conflicts: () => db.sync.conflicts(),
    resolveConflict,
    dispose,
  };
}

/* ---------------------------------------------------------------- helpers --- */

function watermarkKey(userId: string, entity: SyncEntityKind): string {
  return `${WATERMARK_PREFIX}:${userId}:${entity}`;
}

function isIsoInstant(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeRequestTimeout(value: number | undefined): number {
  if (value === undefined) return REQUEST_TIMEOUT_MS_DEFAULT;
  if (!Number.isFinite(value) || value <= 0) return REQUEST_TIMEOUT_MS_DEFAULT;
  return Math.floor(value);
}
