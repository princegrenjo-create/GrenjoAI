/**
 * Sync error mapping.
 *
 * Everything the cloud can fail with is normalised into the shared `AppErrorShape`
 * vocabulary so the renderer never renders a raw Supabase/PostgREST body. Only the
 * sync-specific codes are produced here: `sync_auth`, `sync_config`, `rate_limited`,
 * `offline` and `provider_error`.
 *
 * Redirects and message text never contain a credential: `appError` runs the shared
 * redactor, and the engine additionally scrubs the configured publishable key.
 */
import { appError, redactSecrets } from '@shared/errors';
import type { AppErrorShape } from '@shared/types';
import { isRecord } from './payload';
import { SYNC_TIMEOUT_CODE } from './timeout';

interface ErrorFields {
  message: string;
  status: number | null;
  code: string | null;
  name: string | null;
  timeoutMs: number | null;
  shape: AppErrorShape | null;
}

const NETWORK_PATTERN =
  /(fetch failed|failed to fetch|networkerror|network request failed|enotfound|econnrefused|econnreset|etimedout|eai_again|socket hang up|authretryablefetch|offline|no internet)/i;

const CONFIG_PATTERN =
  /(invalid supabaseurl|supabaseurl is required|invalid api key|no api key|missing.*(anon|publishable)|project url is required)/i;

const AUTH_PATTERN =
  /(invalid login credentials|invalid credentials|email not confirmed|invalid_grant|invalid refresh token|refresh token not found|jwt expired|user not found)/i;

export function mapSyncError(error: unknown): AppErrorShape {
  const fields = readError(error);
  if (fields.shape !== null) return fields.shape;

  const message = redactSecrets(fields.message);
  const code = fields.code;
  const status = fields.status;
  const haystack = `${code ?? ''} ${fields.name ?? ''} ${message}`;

  // A request that exceeded its bounded timeout is reported as the shared `timeout` code,
  // retryable, and naming Supabase so the UI can be specific.
  if (fields.timeoutMs !== null || code === SYNC_TIMEOUT_CODE || fields.name === 'TimeoutError') {
    const budget = fields.timeoutMs !== null ? ` after ${fields.timeoutMs} ms` : '';
    return appError(
      'timeout',
      `The Supabase request timed out${budget}. It was cancelled and will be retried with backoff.`,
      { retryable: true },
    );
  }

  // Row Level Security refusal: the session may be valid but the policies/table grants
  // do not allow this row. Usually a missing migration or a signed-out session.
  if (status === 42501 || code === '42501') {
    return appError(
      'sync_auth',
      'The Supabase project refused this request (row-level security denied it). Re-run migrations/0002_rls.sql and make sure the account is signed in.',
      { retryable: false, status: 403 },
    );
  }

  if (status === 429 || code === '429') {
    return appError(
      'rate_limited',
      'The cloud service is rate-limiting sync requests. Nothing is lost; the app will retry with backoff.',
      { retryable: true, status: 429 },
    );
  }

  if (status === 401 || status === 403 || code === 'PGRST301' || code === 'PGRST302' || AUTH_PATTERN.test(haystack)) {
    return appError(
      'sync_auth',
      'The sync account was rejected. Check the email and password, or sign in again.',
      { retryable: false, ...(status !== null ? { status } : {}) },
    );
  }

  // Table missing from the PostgREST schema cache / relation does not exist.
  if (status === 404 || code === 'PGRST205' || code === '42P01') {
    return appError(
      'sync_config',
      'The cloud tables are missing. Apply supabase/migrations/0001_init.sql and 0002_rls.sql in your Supabase project.',
      { retryable: false, status: 404 },
    );
  }

  if (NETWORK_PATTERN.test(haystack)) {
    return appError(
      'offline',
      'The cloud service is unreachable. Local data is safe and unsynced rows stay pending.',
      { retryable: true },
    );
  }

  if (CONFIG_PATTERN.test(haystack)) {
    return appError(
      'sync_config',
      'The Supabase configuration is not usable. Re-enter the project URL and the publishable (anon) key in Settings → Sync.',
      { retryable: false },
    );
  }

  if (status !== null && status >= 500) {
    return appError(
      'provider_error',
      `The cloud service reported a server error (HTTP ${status}). The app will retry with backoff.`,
      { retryable: true, status },
    );
  }

  if (status === 400 || status === 422) {
    return appError(
      'provider_error',
      `The cloud service rejected the sync record (HTTP ${status}). Check the payload shape against the migration.`,
      { retryable: false, status },
    );
  }

  return appError('provider_error', message.length > 0 ? message : 'Cloud sync failed for an unknown reason.', {
    ...(status !== null ? { status } : {}),
  });
}

/** True when retrying the same request later can plausibly succeed. */
export function isRetryableSyncError(error: AppErrorShape): boolean {
  return error.retryable;
}

/**
 * Remove a literal secret from an error message. Used for the configured publishable
 * key and session token, which the shared redactor cannot know about.
 */
export function redactKnownSecrets(
  shape: AppErrorShape,
  secrets: readonly (string | null | undefined)[],
): AppErrorShape {
  let message = shape.message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && message.includes(secret)) {
      message = message.split(secret).join('[redacted]');
    }
  }
  return message === shape.message ? shape : { ...shape, message };
}

function readError(error: unknown): ErrorFields {
  const fields: ErrorFields = {
    message: '',
    status: null,
    code: null,
    name: null,
    timeoutMs: null,
    shape: null,
  };
  if (typeof error === 'string') {
    fields.message = error;
    return fields;
  }
  if (!isRecord(error)) return fields;

  if (isAppErrorShape(error['shape'])) fields.shape = error['shape'];
  if (typeof error['message'] === 'string') fields.message = error['message'];
  if (typeof error['status'] === 'number' && Number.isFinite(error['status'])) {
    fields.status = error['status'];
  } else if (typeof error['status'] === 'string' && /^\d{3}$/.test(error['status'])) {
    fields.status = Number(error['status']);
  }
  if (typeof error['code'] === 'string') {
    fields.code = error['code'];
  } else if (typeof error['code'] === 'number') {
    fields.code = String(error['code']);
  }
  if (typeof error['name'] === 'string') fields.name = error['name'];
  if (typeof error['timeoutMs'] === 'number' && Number.isFinite(error['timeoutMs'])) {
    fields.timeoutMs = error['timeoutMs'];
  }
  return fields;
}

function isAppErrorShape(value: unknown): value is AppErrorShape {
  if (!isRecord(value)) return false;
  return (
    typeof value['code'] === 'string' &&
    typeof value['message'] === 'string' &&
    typeof value['retryable'] === 'boolean'
  );
}
