/**
 * Supabase client factory for the main process.
 *
 * Hard rules encoded here:
 *  - The session is persisted through the caller-provided `storage` adapter (backed by
 *    the OS credential store). Renderer `localStorage` is never touched.
 *  - Only a publishable/anon key is accepted. A `service_role` or `sb_secret_` key is a
 *    configuration error: it bypasses Row Level Security and must never ship.
 *  - The URL must be HTTPS (plain HTTP is refused, matching the settings UI policy).
 *  - The session/JWT and the key are never logged, returned in status or placed in a
 *    sync payload. The engine only receives the user id and email.
 *
 * The returned client is a small structural interface (`SyncCloudClient`) instead of the
 * full Supabase client, so tests can inject an in-memory fake with no network at all.
 */
import { createClient } from '@supabase/supabase-js';
import type { AuthSession, SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js';
import { MAX_API_KEY_LENGTH, SUPABASE_SESSION_ACCOUNT } from '@shared/defaults';
import { AppError, appError } from '@shared/errors';
import { validateEndpointUrl } from '@shared/url-policy';
import { isRecord } from './payload';
import { SYNC_REMOTE_COLUMNS, type SyncTableName } from './tables';

/* ------------------------------------------------------------- client API -- */

export type SyncAuthEvent =
  | 'initial_session'
  | 'signed_in'
  | 'signed_out'
  | 'token_refreshed'
  | 'user_updated'
  | 'password_recovery'
  | 'other';

/** Session details the sync engine is allowed to see. Never the access/refresh token. */
export interface SyncSession {
  userId: string;
  email: string | null;
}

export interface SyncCloudError {
  message: string;
  status?: number;
  code?: string;
  name?: string;
}

export type SyncCloudResult<T> = { ok: true; data: T } | { ok: false; error: SyncCloudError };

/** One row as stored in a cloud sync table (see supabase/migrations/0001_init.sql). */
export interface SyncRemoteRow {
  id: string;
  user_id: string;
  version: number;
  updated_at: string;
  deleted_at: string | null;
  payload: Record<string, unknown>;
}

export interface SyncPullInput {
  userId: string;
  /** Exclusive lower bound on `updated_at`; the last observed server timestamp. */
  watermark: string;
  limit: number;
}

export interface SyncTableApi {
  upsert(
    rows: readonly SyncRemoteRow[],
    options: { onConflict: 'id' },
  ): Promise<SyncCloudResult<null>>;
  selectAfter(input: SyncPullInput): Promise<SyncCloudResult<readonly unknown[]>>;
}

export interface SyncAuthApi {
  getSession(): Promise<{ session: SyncSession | null; error: SyncCloudError | null }>;
  onAuthStateChange(
    listener: (event: SyncAuthEvent, session: SyncSession | null) => void,
  ): () => void;
  signInWithPassword(input: {
    email: string;
    password: string;
  }): Promise<{ session: SyncSession | null; error: SyncCloudError | null }>;
  signUp(input: {
    email: string;
    password: string;
  }): Promise<{
    session: SyncSession | null;
    needsEmailConfirmation: boolean;
    error: SyncCloudError | null;
  }>;
  signOut(): Promise<{ error: SyncCloudError | null }>;
}

export interface SyncCloudClient {
  readonly auth: SyncAuthApi;
  from(table: SyncTableName): SyncTableApi;
}

export interface SyncClientConfig {
  url: string;
  anonKey: string;
}

export type SyncClientFactory = (config: SyncClientConfig) => SyncCloudClient;

/* ------------------------------------------------------- session storage --- */

/**
 * Minimal storage contract Supabase auth needs. Implemented by the main process over
 * the OS credential store; the renderer's `localStorage` is never used.
 */
export interface SyncSessionStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface SessionStorageBackend {
  read(account: string): string | null | Promise<string | null>;
  write(account: string, value: string): void | Promise<void>;
  remove(account: string): void | Promise<void>;
}

/**
 * Adapt a credential-store backend (one account per Supabase storage key) into the
 * storage adapter the client expects. The session JSON — which contains the JWT — is
 * therefore encrypted by the OS credential store, not written to SQLite.
 */
export function createCredentialSessionStorage(backend: SessionStorageBackend): SyncSessionStorage {
  const accountFor = (key: string): string => `${SUPABASE_SESSION_ACCOUNT}:${key}`;
  return {
    getItem: (key) => backend.read(accountFor(key)),
    setItem: (key, value) => backend.write(accountFor(key), value),
    removeItem: (key) => backend.remove(accountFor(key)),
  };
}

/* ------------------------------------------------------------- validation -- */

/**
 * Validate and normalise the owner-supplied configuration. Throws `sync_config` for
 * anything unusable — including a secret key, which is a security error, not a typo.
 */
export function validateClientConfig(config: SyncClientConfig): SyncClientConfig {
  const urlCheck = validateEndpointUrl(config.url, {
    requireHttps: true,
    allowInsecureLocalhost: false,
  });
  if (!urlCheck.ok) {
    throw new AppError(
      appError('sync_config', `The Supabase project URL is not usable: ${urlCheck.reason}`, {
        retryable: false,
      }),
    );
  }

  const anonKey = config.anonKey.trim();
  if (anonKey.length === 0) {
    throw new AppError(
      appError('sync_config', 'A Supabase publishable (anon) key is required.', { retryable: false }),
    );
  }
  if (anonKey.length > MAX_API_KEY_LENGTH) {
    throw new AppError(
      appError('sync_config', 'That key is too long to be a Supabase publishable key.', {
        retryable: false,
      }),
    );
  }
  if (isSecretKey(anonKey)) {
    throw new AppError(
      appError(
        'sync_config',
        'That key is a service_role / secret key. It bypasses Row Level Security and must never be used or shipped; use the publishable (anon) key instead.',
        { retryable: false },
      ),
    );
  }

  return { url: urlCheck.url, anonKey };
}

/** A key that must never be used from a desktop client. */
export function isSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  if (/service_role/i.test(key)) return true;
  return readJwtRole(key) === 'service_role';
}

/** Decode the `role` claim of a legacy JWT key without verifying it (verification is the server's job). */
export function readJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (payloadPart === undefined || payloadPart.length === 0) return null;
  try {
    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (isRecord(parsed) && typeof parsed['role'] === 'string') return parsed['role'];
    return null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- factory --- */

/** The subset of `SupabaseClient` this module actually uses. */
export type SupabaseClientLike = Pick<SupabaseClient, 'auth' | 'from'>;

export type CreateClientImpl = (
  url: string,
  key: string,
  options: SupabaseClientOptions<'public'>,
) => SupabaseClientLike;

export interface SupabaseClientFactoryDeps {
  storage: SyncSessionStorage;
  /** Test seam: swap the real `createClient` for a recorder. */
  createClientImpl?: CreateClientImpl;
}

export function createSupabaseClientFactory(deps: SupabaseClientFactoryDeps): SyncClientFactory {
  const impl: CreateClientImpl =
    deps.createClientImpl ?? ((url, key, options) => createClient(url, key, options));

  return (config) => {
    const validated = validateClientConfig(config);
    const supabase = impl(validated.url, validated.anonKey, {
      auth: {
        storage: deps.storage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        headers: { 'x-application-name': 'grenjo-ai-tool' },
      },
    });
    return createCloudClient(supabase);
  };
}

/** Name used by the engine contract (`clientFactory`): the injectable Supabase client factory. */
export const createClientFactory = createSupabaseClientFactory;

/**
 * Wrap the real Supabase client in the small engine-facing interface.
 *
 * This adapter performs the raw network calls and deliberately contains no timeout of
 * its own: the sync engine is the only consumer and wraps every call in
 * `withTimeout(operation, …)`, so the timeout budget is configured in one place
 * (`requestTimeoutMs`) and applies to fakes and to the real client alike. Do not await
 * these methods directly from new code — go through the engine.
 */
export function createCloudClient(supabase: SupabaseClientLike): SyncCloudClient {
  return {
    auth: {
      async getSession() {
        try {
          const { data, error } = await supabase.auth.getSession();
          return { session: toSession(data.session), error: toCloudError(error) };
        } catch (err) {
          return { session: null, error: toCloudError(err) };
        }
      },

      onAuthStateChange(listener) {
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          listener(normalizeAuthEvent(event), toSession(session));
        });
        return () => {
          data.subscription.unsubscribe();
        };
      },

      async signInWithPassword(input) {
        try {
          const { data, error } = await supabase.auth.signInWithPassword({
            email: input.email,
            password: input.password,
          });
          return { session: toSession(data.session), error: toCloudError(error) };
        } catch (err) {
          return { session: null, error: toCloudError(err) };
        }
      },

      async signUp(input) {
        try {
          const { data, error } = await supabase.auth.signUp({
            email: input.email,
            password: input.password,
          });
          const cloudError = toCloudError(error);
          return {
            session: toSession(data.session),
            needsEmailConfirmation: cloudError === null && data.session === null,
            error: cloudError,
          };
        } catch (err) {
          return {
            session: null,
            needsEmailConfirmation: false,
            error: toCloudError(err),
          };
        }
      },

      async signOut() {
        try {
          const { error } = await supabase.auth.signOut();
          return { error: toCloudError(error) };
        } catch (err) {
          return { error: toCloudError(err) };
        }
      },
    },

    from(table) {
      return {
        async upsert(rows, options) {
          try {
            const { error, status } = await supabase
              .from(table)
              .upsert([...rows], { onConflict: options.onConflict });
            const cloudError = toCloudError(error, status);
            return cloudError === null ? { ok: true, data: null } : { ok: false, error: cloudError };
          } catch (err) {
            return { ok: false, error: toCloudError(err) ?? { message: 'The cloud request failed.' } };
          }
        },

        async selectAfter(input) {
          try {
            const { data, error, status } = await supabase
              .from(table)
              .select(SYNC_REMOTE_COLUMNS)
              .eq('user_id', input.userId)
              .gt('updated_at', input.watermark)
              .order('updated_at', { ascending: true })
              .limit(input.limit);
            const cloudError = toCloudError(error, status);
            if (cloudError !== null) return { ok: false, error: cloudError };
            const rows: unknown = data;
            return { ok: true, data: Array.isArray(rows) ? rows : [] };
          } catch (err) {
            return { ok: false, error: toCloudError(err) ?? { message: 'The cloud request failed.' } };
          }
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ helpers -- */

function toSession(session: AuthSession | null): SyncSession | null {
  if (session === null) return null;
  const email = typeof session.user.email === 'string' ? session.user.email : null;
  return { userId: session.user.id, email };
}

function normalizeAuthEvent(event: string): SyncAuthEvent {
  switch (event) {
    case 'INITIAL_SESSION':
      return 'initial_session';
    case 'SIGNED_IN':
      return 'signed_in';
    case 'SIGNED_OUT':
      return 'signed_out';
    case 'TOKEN_REFRESHED':
      return 'token_refreshed';
    case 'USER_UPDATED':
      return 'user_updated';
    case 'PASSWORD_RECOVERY':
      return 'password_recovery';
    default:
      return 'other';
  }
}

function toCloudError(error: unknown, status?: number): SyncCloudError | null {
  if (error === null || error === undefined) return null;
  if (isRecord(error)) {
    const message =
      typeof error['message'] === 'string' && error['message'].length > 0
        ? error['message']
        : 'The cloud request failed.';
    const code = typeof error['code'] === 'string' ? error['code'] : undefined;
    const name = typeof error['name'] === 'string' ? error['name'] : undefined;
    const errorStatus =
      typeof error['status'] === 'number' && Number.isFinite(error['status'])
        ? error['status']
        : status;
    return {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(errorStatus !== undefined ? { status: errorStatus } : {}),
    };
  }
  return {
    message: typeof error === 'string' ? error : 'The cloud request failed.',
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Validate one raw row returned by the cloud before it can reach the local database.
 * Anything malformed is dropped instead of being applied as a half-valid record.
 */
export function parseRemoteRow(value: unknown): SyncRemoteRow | null {
  if (!isRecord(value)) return null;

  const id = value['id'];
  const userId = value['user_id'];
  const version = value['version'];
  const updatedAt = value['updated_at'];
  const deletedAt = value['deleted_at'];
  const payload = value['payload'];

  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return null;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 64) return null;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    version > 2147483647
  ) {
    return null;
  }
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return null;
  if (
    deletedAt !== null &&
    deletedAt !== undefined &&
    (typeof deletedAt !== 'string' || !Number.isFinite(Date.parse(deletedAt)))
  ) {
    return null;
  }
  if (!isRecord(payload) || Array.isArray(payload)) return null;

  return {
    id,
    user_id: userId,
    version,
    updated_at: updatedAt,
    deleted_at: typeof deletedAt === 'string' ? deletedAt : null,
    payload,
  };
}
