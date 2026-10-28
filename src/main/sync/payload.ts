/**
 * Sync payload hygiene.
 *
 * Two rules decide everything here:
 *  1. A credential never leaves the device. Fields whose *name* says they hold a
 *     secret are removed from the outbound payload; a free-text value that happens to
 *     contain something credential-shaped blocks the upload instead of being silently
 *     rewritten, so local user data is never mutated behind the user's back.
 *  2. The remote row is built from the entity payload and the routing fields (id,
 *     version). Nothing else is invented.
 */
import type { SyncEntityKind } from '@shared/types';

/**
 * Credential-shaped strings. Deliberately broad: `sk-`/`AIza` provider keys and the
 * `eyJ` base64url prefix of a JWT. Kept without the `g` flag so `.test()` is stateless.
 */
export const CREDENTIAL_VALUE_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{6,}|eyJ[A-Za-z0-9_-]+)/;

/** Keys that must never be part of a sync payload, whatever the entity. */
const SENSITIVE_KEY_PATTERN =
  /^(?:api[_-]?key|apikey|x-api-key|x-goog-api-key|key|keys|secret|secrets|client[_-]?secret|clientsecret|token|tokens|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|passphrase|authorization|auth|cookie|cookies|credential|credentials|private[_-]?key|session[_-]?token|jwt|bearer)$/i;

/**
 * Device-local provider metadata. The cloud copy is a *non-secret* provider record:
 * name, kind, base URL and enabled flag. Whether this device holds a key, and the key
 * fingerprint, must not travel.
 */
const PROVIDER_LOCAL_ONLY_FIELDS = new Set([
  'haskey',
  'has_key',
  'keyfingerprint',
  'key_fingerprint',
  'keyupdatedat',
  'key_updated_at',
]);

const MAX_DEPTH = 16;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface SanitizeResult {
  /** Deep-cloned, JSON-safe payload with secret-bearing fields removed. */
  value: unknown;
  /** Dotted paths that were removed, for diagnostics. */
  removedKeys: readonly string[];
  /** True when a non-secret field carried a credential-shaped value. */
  blocked: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain JSON object: excludes arrays, Date, Map and class instances. */
export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isCredentialShaped(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERN.test(value);
}

/** True when any string inside `value` looks like a credential. */
export function containsCredentialShapedValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === 'string') return isCredentialShaped(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialShapedValue(item, depth + 1));
  }
  if (isPlainJsonObject(value)) {
    return Object.values(value).some((item) => containsCredentialShapedValue(item, depth + 1));
  }
  return false;
}

export function sanitizeForSync(entity: SyncEntityKind, payload: unknown): SanitizeResult {
  const removedKeys: string[] = [];
  const state = { blocked: false };
  const value = sanitizeValue(entity, payload, 0, '', removedKeys, state);
  return { value, removedKeys, blocked: state.blocked };
}

function sanitizeValue(
  entity: SyncEntityKind,
  value: unknown,
  depth: number,
  path: string,
  removedKeys: string[],
  state: { blocked: boolean },
): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (isCredentialShaped(value)) {
      // The field is not knowably a secret, so the upload is refused rather than the
      // user's text being rewritten. `sanitizeForSync` reports `blocked`.
      state.blocked = true;
      return undefined;
    }
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return undefined;
  }
  if (depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const clean = sanitizeValue(
        entity,
        value[index],
        depth + 1,
        `${path}[${index}]`,
        removedKeys,
        state,
      );
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }

  if (isPlainJsonObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (isSensitiveKey(key) || isEntityLocalOnlyField(entity, key)) {
        removedKeys.push(childPath);
        continue;
      }
      const clean = sanitizeValue(entity, child, depth + 1, childPath, removedKeys, state);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }

  // Date, Map, Set, class instances: not JSON, not syncable.
  return undefined;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isEntityLocalOnlyField(entity: SyncEntityKind, key: string): boolean {
  return entity === 'provider' && PROVIDER_LOCAL_ONLY_FIELDS.has(key.toLowerCase());
}

/**
 * `updated_at` for the remote row. Taken from the entity payload so remote ordering
 * reflects the local edit time; a clock far in the future is clamped to now, because
 * a future timestamp would poison the pull watermark for every device.
 */
export function resolveRemoteUpdatedAt(
  payload: Record<string, unknown>,
  nowIso: string,
): string {
  const candidate = readInstant(payload['updatedAt']) ?? readInstant(payload['updated_at']);
  if (candidate === null) return nowIso;
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(nowMs) && candidate > nowMs + MAX_FUTURE_SKEW_MS) return nowIso;
  return new Date(candidate).toISOString();
}

/** Tombstone time for a non-delete push, when the payload carries one. */
export function resolveRemoteDeletedAt(payload: Record<string, unknown>): string | null {
  const candidate = readInstant(payload['deletedAt']) ?? readInstant(payload['deleted_at']);
  return candidate === null ? null : new Date(candidate).toISOString();
}

function readInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
