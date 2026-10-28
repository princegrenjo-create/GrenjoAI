/**
 * In-memory fakes for the sync engine.
 *
 * No network and no real timers: `now` is a mutable clock, `sleep` records the delays
 * it was asked for, and the Supabase client is a plain object. The fake local database
 * implements the frozen `SyncRepository` semantics closely enough to exercise the
 * engine: `dirty` is the outbox, `applyRemote` compares versions, and a conflict is
 * recorded without overwriting the local row.
 */
import type { SyncConflict, SyncEntityKind, SyncOperation, SyncStatus } from '@shared/types';
import type { RemoteApplyResult, RemoteEntity, SyncPendingRow, SyncRepository } from '@shared/repository-contract';
import type {
  SyncAuthEvent,
  SyncClientFactory,
  SyncCloudClient,
  SyncCloudError,
  SyncCloudResult,
  SyncPullInput,
  SyncRemoteRow,
  SyncSession,
  SyncTableApi,
} from '@main/sync/client';
import type { SyncEngine, SyncEngineDatabase, SyncCredentials } from '@main/sync/engine';
import { createSyncEngine } from '@main/sync/engine';
import type { SyncTableName } from '@main/sync/tables';

export const TEST_USER_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_EMAIL = 'owner@example.com';
export const TEST_CLOCK_START = Date.parse('2026-10-29T03:00:00.000Z');

export interface FakeLocalRow {
  entity: SyncEntityKind;
  id: string;
  version: number;
  op: SyncOperation;
  payload: unknown;
  dirty: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StoredConflict extends SyncConflict {
  remotePayload: unknown;
}

export interface FakeDatabase {
  db: SyncEngineDatabase;
  rows: Map<string, FakeLocalRow>;
  conflictRecords: StoredConflict[];
  meta: Map<string, string>;
  failures: Array<{
    entity: SyncEntityKind;
    entityId: string;
    error: string;
    nextAttemptAt: string;
  }>;
  pushes: Array<{ entity: SyncEntityKind; entityId: string; version: number }>;
  retries: Array<{ entity: SyncEntityKind; entityId: string }>;
  put(row: Partial<FakeLocalRow> & { entity: SyncEntityKind; id: string; payload: unknown }): FakeLocalRow;
  pendingDue(): FakeLocalRow[];
}

export interface FakeDatabaseOptions {
  now: () => number;
  rows?: readonly FakeLocalRow[];
}

function rowKey(entity: SyncEntityKind, id: string): string {
  return `${entity}:${id}`;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function makeLocalRow(
  overrides: Partial<FakeLocalRow> & { entity: SyncEntityKind; id: string; payload: unknown },
): FakeLocalRow {
  return {
    entity: overrides.entity,
    id: overrides.id,
    version: overrides.version ?? 1,
    op: overrides.op ?? 'upsert',
    payload: overrides.payload,
    dirty: overrides.dirty ?? true,
    attempts: overrides.attempts ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-10-29T03:00:00.000Z',
    deletedAt: overrides.deletedAt ?? null,
  };
}

export function createFakeDatabase(options: FakeDatabaseOptions): FakeDatabase {
  const rows = new Map<string, FakeLocalRow>();
  for (const row of options.rows ?? []) rows.set(rowKey(row.entity, row.id), row);

  const conflictRecords: StoredConflict[] = [];
  const meta = new Map<string, string>();
  const failures: FakeDatabase['failures'] = [];
  const pushes: FakeDatabase['pushes'] = [];
  const retries: FakeDatabase['retries'] = [];
  let nextConflictId = 1;

  function isDue(row: FakeLocalRow): boolean {
    if (!row.dirty) return false;
    if (row.nextAttemptAt === null) return true;
    return Date.parse(row.nextAttemptAt) <= options.now();
  }

  const sync: SyncRepository = {
    pending(limit: number): SyncPendingRow[] {
      return [...rows.values()]
        .filter(isDue)
        .slice(0, Math.max(0, limit))
        .map((row) => ({
          entity: row.entity,
          entityId: row.id,
          version: row.version,
          op: row.op,
          payload: row.payload,
        }));
    },

    pendingCount(): number {
      return [...rows.values()].filter((row) => row.dirty).length;
    },

    markPushed(entity: SyncEntityKind, entityId: string, pushedVersion: number): void {
      const row = rows.get(rowKey(entity, entityId));
      if (row !== undefined) {
        row.dirty = false;
        row.version = pushedVersion;
        row.attempts = 0;
        row.nextAttemptAt = null;
      }
      pushes.push({ entity, entityId, version: pushedVersion });
    },

    markFailed(entity: SyncEntityKind, entityId: string, error: string, nextAttemptAt: string): void {
      const row = rows.get(rowKey(entity, entityId));
      if (row !== undefined) {
        row.attempts += 1;
        row.nextAttemptAt = nextAttemptAt;
        row.dirty = true;
      }
      failures.push({ entity, entityId, error, nextAttemptAt });
    },

    retryNow(entity: SyncEntityKind, entityId: string): void {
      const row = rows.get(rowKey(entity, entityId));
      if (row !== undefined) row.nextAttemptAt = null;
      retries.push({ entity, entityId });
    },

    applyRemote(entity: SyncEntityKind, remote: RemoteEntity): RemoteApplyResult {
      const key = rowKey(entity, remote.id);
      const local = rows.get(key);
      if (local === undefined) {
        rows.set(key, {
          entity,
          id: remote.id,
          version: remote.version,
          op: remote.deletedAt === null ? 'upsert' : 'delete',
          payload: remote.payload,
          dirty: false,
          attempts: 0,
          nextAttemptAt: null,
          updatedAt: remote.updatedAt,
          deletedAt: remote.deletedAt,
        });
        return 'applied';
      }
      if (remote.version > local.version) {
        if (local.dirty) return 'conflict';
        local.version = remote.version;
        local.payload = remote.payload;
        local.updatedAt = remote.updatedAt;
        local.deletedAt = remote.deletedAt;
        local.op = remote.deletedAt === null ? 'upsert' : 'delete';
        return 'applied';
      }
      return 'ignored';
    },

    recordConflict(input): void {
      conflictRecords.push({
        id: nextConflictId,
        entity: input.entity,
        entityId: input.entityId,
        localRevision: input.localRevision,
        remoteRevision: input.remoteRevision,
        detectedAt: iso(options.now()),
        resolution: 'unresolved',
        summary: input.summary,
        remotePayload: input.remotePayload,
      });
      nextConflictId += 1;
    },

    conflicts(): SyncConflict[] {
      return conflictRecords.map((conflict) => ({
        id: conflict.id,
        entity: conflict.entity,
        entityId: conflict.entityId,
        localRevision: conflict.localRevision,
        remoteRevision: conflict.remoteRevision,
        detectedAt: conflict.detectedAt,
        resolution: conflict.resolution,
        summary: conflict.summary,
      }));
    },

    conflictCount(): number {
      return conflictRecords.filter((conflict) => conflict.resolution === 'unresolved').length;
    },

    resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): void {
      const conflict = conflictRecords.find((item) => item.id === id);
      if (conflict === undefined) return;
      conflict.resolution = resolution;
      const local = rows.get(rowKey(conflict.entity, conflict.entityId));
      if (local === undefined) return;
      if (resolution === 'kept_remote') {
        local.version = Math.max(local.version, conflict.remoteRevision);
        local.payload = conflict.remotePayload;
        local.dirty = false;
        local.nextAttemptAt = null;
        local.deletedAt = null;
        local.op = 'upsert';
        return;
      }
      // Kept-local: the local copy must win the next push, so it moves past the remote
      // revision and becomes due immediately.
      local.version = Math.max(local.version, conflict.remoteRevision) + 1;
      local.dirty = true;
      local.nextAttemptAt = null;
    },

    meta: {
      get: (key: string): string | null => meta.get(key) ?? null,
      set: (key: string, value: string): void => {
        meta.set(key, value);
      },
      delete: (key: string): void => {
        meta.delete(key);
      },
    },
  };

  const fake: FakeDatabase = {
    db: { sync },
    rows,
    conflictRecords,
    meta,
    failures,
    pushes,
    retries,
    put(overrides): FakeLocalRow {
      const row = makeLocalRow(overrides);
      rows.set(rowKey(row.entity, row.id), row);
      return row;
    },
    pendingDue(): FakeLocalRow[] {
      return [...rows.values()].filter(isDue);
    },
  };
  return fake;
}

/* ------------------------------------------------------------- fake cloud ---- */

export interface FakeCloudOptions {
  now?: () => number;
  session?: SyncSession | null;
  rows?: readonly { table: SyncTableName; row: SyncRemoteRow }[];
  signInError?: SyncCloudError | null;
  requiresEmailConfirmation?: boolean;
  upsertError?: (context: {
    table: SyncTableName;
    row: SyncRemoteRow;
    attempt: number;
  }) => SyncCloudError | null;
  applyUpsertsToRemote?: boolean;
  /** Default true (RLS-like). Set false to prove the engine's own user check. */
  enforceUserFilter?: boolean;
  /** Never resolve a select; used to prove the request timeout. */
  hangSelect?: boolean;
  /** Never resolve an upsert; used to prove the request timeout. */
  hangUpsert?: boolean;
}

export interface FakeCloud {
  factory: SyncClientFactory;
  client: SyncCloudClient;
  remoteRows: SyncRemoteRow[];
  upserts: Array<{ table: SyncTableName; rows: SyncRemoteRow[]; onConflict: string }>;
  selects: Array<{ table: SyncTableName; input: SyncPullInput }>;
  events: string[];
  session: SyncSession | null;
  signOutCalls: number;
  setSession(session: SyncSession | null): void;
  emitAuth(event: SyncAuthEvent, session: SyncSession | null): void;
  setUpsertError(fn: FakeCloudOptions['upsertError']): void;
  setQueryHook(fn: ((table: SyncTableName) => void) | null): void;
  gateUpserts(): () => void;
  setHangSelect(value: boolean): void;
  setHangUpsert(value: boolean): void;
}

export function createFakeCloud(options: FakeCloudOptions = {}): FakeCloud {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(event: SyncAuthEvent, session: SyncSession | null) => void>();
  const remoteRows: SyncRemoteRow[] = [];
  const tableByRow = new Map<SyncRemoteRow, SyncTableName>();
  for (const entry of options.rows ?? []) {
    const row: SyncRemoteRow = { ...entry.row, payload: { ...entry.row.payload } };
    remoteRows.push(row);
    tableByRow.set(row, entry.table);
  }

  const upserts: FakeCloud['upserts'] = [];
  const selects: FakeCloud['selects'] = [];
  const events: string[] = [];
  const attemptsByTable = new Map<SyncTableName, number>();
  let session: SyncSession | null = options.session ?? null;
  let upsertError = options.upsertError;
  let queryHook: ((table: SyncTableName) => void) | null = null;
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let signOutCalls = 0;
  const applyUpsertsToRemote = options.applyUpsertsToRemote ?? true;
  const enforceUserFilter = options.enforceUserFilter ?? true;
  let hangSelect = options.hangSelect ?? false;
  let hangUpsert = options.hangUpsert ?? false;
  /** A promise that never settles, to model a socket that connects and then stalls. */
  const NEVER: Promise<never> = new Promise<never>(() => {});

  function emitAuth(event: SyncAuthEvent, next: SyncSession | null): void {
    for (const listener of [...listeners]) listener(event, next);
  }

  const auth: SyncCloudClient['auth'] = {
    async getSession() {
      return { session, error: null };
    },
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async signInWithPassword(input) {
      if (options.signInError !== undefined && options.signInError !== null) {
        return { session: null, error: options.signInError };
      }
      if (input.email.trim().length === 0 || input.password.trim().length === 0) {
        return { session: null, error: { message: 'Invalid login credentials', status: 400 } };
      }
      session = { userId: TEST_USER_ID, email: input.email };
      emitAuth('signed_in', session);
      return { session, error: null };
    },
    async signUp(input) {
      if (options.requiresEmailConfirmation === true) {
        return { session: null, needsEmailConfirmation: true, error: null };
      }
      session = { userId: TEST_USER_ID, email: input.email };
      emitAuth('signed_in', session);
      return { session, needsEmailConfirmation: false, error: null };
    },
    async signOut() {
      signOutCalls += 1;
      session = null;
      emitAuth('signed_out', null);
      return { error: null };
    },
  };

  const client: SyncCloudClient = {
    auth,
    from(table: SyncTableName): SyncTableApi {
      return {
        async upsert(rows, upsertOptions) {
          events.push(`upsert:${table}`);
          const attempt = (attemptsByTable.get(table) ?? 0) + 1;
          attemptsByTable.set(table, attempt);
          const copied = rows.map((row) => ({ ...row, payload: { ...row.payload } }));
          upserts.push({ table, rows: copied, onConflict: upsertOptions.onConflict });
          if (hangUpsert) return NEVER;
          if (gate !== null) await gate;
          const row = copied[0];
          if (upsertError !== undefined && upsertError !== null && row !== undefined) {
            const error = upsertError({ table, row, attempt });
            if (error !== null) return { ok: false, error } satisfies SyncCloudResult<null>;
          }
          if (applyUpsertsToRemote) {
            for (const next of copied) {
              const index = remoteRows.findIndex(
                (candidate) => tableByRow.get(candidate) === table && candidate.id === next.id,
              );
              if (index >= 0) {
                remoteRows[index] = next;
              } else {
                remoteRows.push(next);
              }
              tableByRow.set(next, table);
            }
          }
          return { ok: true, data: null } satisfies SyncCloudResult<null>;
        },

        async selectAfter(input) {
          events.push(`select:${table}`);
          selects.push({ table, input });
          if (queryHook !== null) queryHook(table);
          if (hangSelect) return NEVER;
          const rows = remoteRows
            .map((row, index) => ({ row, index }))
            .filter((entry) => tableByRow.get(entry.row) === table)
            .map((entry) => entry.row)
            .filter((row) => !enforceUserFilter || row.user_id === input.userId)
            .filter((row) => Date.parse(row.updated_at) > Date.parse(input.watermark))
            .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
            .slice(0, input.limit);
          return { ok: true, data: rows } satisfies SyncCloudResult<readonly unknown[]>;
        },
      };
    },
  };

  const factory: SyncClientFactory = () => client;

  return {
    factory,
    client,
    remoteRows,
    upserts,
    selects,
    events,
    get session() {
      return session;
    },
    set session(value: SyncSession | null) {
      session = value;
    },
    get signOutCalls() {
      return signOutCalls;
    },
    setSession(value: SyncSession | null): void {
      session = value;
    },
    emitAuth,
    setUpsertError(fn): void {
      upsertError = fn;
    },
    setQueryHook(fn): void {
      queryHook = fn;
    },
    setHangSelect(value: boolean): void {
      hangSelect = value;
    },
    setHangUpsert(value: boolean): void {
      hangUpsert = value;
    },
    gateUpserts(): () => void {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return () => {
        const release = releaseGate;
        gate = null;
        releaseGate = null;
        if (release !== null) release();
      };
    },
  };
}

/* ---------------------------------------------------------------- harness ---- */

export interface HarnessOptions {
  rows?: readonly FakeLocalRow[];
  remote?: readonly { table: SyncTableName; row: SyncRemoteRow }[];
  session?: SyncSession | null;
  signInError?: SyncCloudError | null;
  requiresEmailConfirmation?: boolean;
  upsertError?: FakeCloudOptions['upsertError'];
  online?: boolean;
  credentials?: SyncCredentials | null;
  pullLimit?: number;
  pushLimit?: number;
  maxPushAttempts?: number;
  enforceUserFilter?: boolean;
  /** Omitted means "let the engine apply its own default" (30 s). */
  requestTimeoutMs?: number;
  hangSelect?: boolean;
  hangUpsert?: boolean;
}

/** One timeout scheduled by the engine through the injected timer function. */
export interface ScheduledTimeout {
  delayMs: number;
  callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

export interface Harness {
  engine: SyncEngine;
  db: FakeDatabase;
  cloud: FakeCloud;
  clock: { now: () => number; advance: (ms: number) => void };
  sleeps: number[];
  statuses: SyncStatus[];
  timers: ScheduledTimeout[];
  nextLiveTimeout: () => ScheduledTimeout | undefined;
  fireNextTimeout: () => ScheduledTimeout | null;
  setOnline: (value: boolean) => void;
  setCredentials: (value: SyncCredentials | null) => void;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = {
    value: TEST_CLOCK_START,
    now(): number {
      return clock.value;
    },
    advance(milliseconds: number): void {
      clock.value += milliseconds;
    },
  };

  const db = createFakeDatabase({ now: clock.now, rows: options.rows });
  const cloud = createFakeCloud({
    now: clock.now,
    rows: options.remote,
    session: options.session ?? null,
    signInError: options.signInError,
    requiresEmailConfirmation: options.requiresEmailConfirmation,
    upsertError: options.upsertError,
    enforceUserFilter: options.enforceUserFilter,
    hangSelect: options.hangSelect,
    hangUpsert: options.hangUpsert,
  });

  let online = options.online ?? true;
  let credentials: SyncCredentials | null =
    options.credentials === undefined
      ? { url: 'https://example-project.supabase.co', anonKey: 'sb_publishable_test_key' }
      : options.credentials;
  const sleeps: number[] = [];
  const statuses: SyncStatus[] = [];
  const timers: ScheduledTimeout[] = [];
  const setTimer = (callback: () => void, delayMs: number): (() => void) => {
    const entry: ScheduledTimeout = { delayMs, callback, cancelled: false, fired: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  const engine = createSyncEngine({
    db: db.db,
    clientFactory: cloud.factory,
    credentialProvider: async () => credentials,
    onStatus: (status) => {
      statuses.push(status);
    },
    now: clock.now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 0,
    isOnline: () => online,
    maxPushAttempts: options.maxPushAttempts ?? 3,
    pullLimit: options.pullLimit ?? 200,
    pushLimit: options.pushLimit ?? 200,
    requestTimeoutMs: options.requestTimeoutMs,
    setTimer,
  });

  return {
    engine,
    db,
    cloud,
    clock,
    sleeps,
    statuses,
    timers,
    nextLiveTimeout(): ScheduledTimeout | undefined {
      return timers.find((entry) => !entry.cancelled && !entry.fired);
    },
    fireNextTimeout(): ScheduledTimeout | null {
      const entry = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
      if (entry === undefined) return null;
      entry.fired = true;
      entry.callback();
      return entry;
    },
    setOnline(value: boolean): void {
      online = value;
    },
    setCredentials(value: SyncCredentials | null): void {
      credentials = value;
    },
  };
}

export function makeRemoteRow(
  overrides: Partial<SyncRemoteRow> & { id: string },
): SyncRemoteRow {
  return {
    id: overrides.id,
    user_id: overrides.user_id ?? TEST_USER_ID,
    version: overrides.version ?? 1,
    updated_at: overrides.updated_at ?? '2026-10-29T03:00:00.000Z',
    deleted_at: overrides.deleted_at ?? null,
    payload: overrides.payload ?? {},
  };
}
