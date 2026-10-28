/**
 * Endpoint policy for provider credentials and model endpoint overrides.
 *
 * The invariant this file enforces:
 *
 *   **A stored API key is only ever sent to the origin the owner typed it for.**
 *
 * Two paths could otherwise move a key to a host the owner never chose:
 *   1. A provider's `baseUrl` changing after the key was stored — through the
 *      settings editor, an imported configuration file, or a row pulled from
 *      cloud sync. The key would silently follow to the new host.
 *   2. A custom model's `baseUrlOverride`, which may itself arrive from an
 *      imported file or from another device through sync. A hostile override
 *      would forward the provider's key to an attacker.
 *
 * Consequence of the design: changing a base URL invalidates the key (the UI
 * reports "no key stored" and asks for it again), and a model override must stay
 * on the provider's origin. If you genuinely need a second host, that is a second
 * provider with its own key — which is exactly the mental model the UI presents.
 */
import crypto from 'node:crypto';
import { AppError, appError } from '@shared/errors';
import type { CredentialStore } from '../credentials';

const BINDING_PREFIX = '__provider_binding__:';

function bindingAccount(providerId: string): string {
  return `${BINDING_PREFIX}${providerId}`;
}

/** Normalised origin+path used for binding and comparison. */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Records which base URL the current key was entered for. */
export function bindProviderKey(
  store: CredentialStore,
  providerId: string,
  baseUrl: string,
  apiKey: string,
): void {
  store.set(providerId, apiKey);
  store.set(bindingAccount(providerId), digest(normaliseBaseUrl(baseUrl)));
}

/**
 * Reads a key only when it is still bound to the provider's current base URL.
 * A stale key is deleted rather than left in place: leaving it would mean the
 * next base-URL change resurrects it.
 */
export function readProviderKey(
  store: CredentialStore,
  providerId: string,
  baseUrl: string,
): string | null {
  const key = store.get(providerId);
  if (key === null) return null;
  const binding = store.get(bindingAccount(providerId));
  if (binding === null) {
    // No binding record: the key predates this check or was written by hand.
    // Treat it as unbound rather than trusting it for whatever host is current.
    store.delete(providerId);
    return null;
  }
  if (binding !== digest(normaliseBaseUrl(baseUrl))) {
    store.delete(providerId);
    store.delete(bindingAccount(providerId));
    return null;
  }
  return key;
}

export function clearProviderKey(store: CredentialStore, providerId: string): void {
  store.delete(providerId);
  store.delete(bindingAccount(providerId));
}

export function hasBoundKey(store: CredentialStore, providerId: string, baseUrl: string): boolean {
  return readProviderKey(store, providerId, baseUrl) !== null;
}

/**
 * Resolves the endpoint a chat request must go to.
 *
 * Returns the provider base URL unless the model overrides it, and refuses an
 * override on any other origin.
 */
export function resolveRequestEndpoint(providerBaseUrl: string, override: string | null | undefined): string {
  const base = normaliseBaseUrl(providerBaseUrl);
  if (!override || override.trim().length === 0) return base;

  const normalisedOverride = normaliseBaseUrl(override);
  if (normalisedOverride === base) return base;

  let baseOrigin: string;
  let overrideOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
    overrideOrigin = new URL(normalisedOverride).origin;
  } catch {
    throw new AppError(
      appError(
        'validation',
        'The model endpoint override is not a valid absolute URL. Fix it in Others / Custom Models.',
      ),
    );
  }

  if (baseOrigin !== overrideOrigin) {
    throw new AppError(
      appError(
        'validation',
        `This model points at ${overrideOrigin}, but the provider key was entered for ${baseOrigin}. The key is never sent to a different origin — add a separate provider with its own key if the endpoint really is elsewhere.`,
      ),
    );
  }
  return normalisedOverride;
}

/** Origin comparison used by tests and by the model editor's inline validation. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(normaliseBaseUrl(a)).origin === new URL(normaliseBaseUrl(b)).origin;
  } catch {
    return false;
  }
}
