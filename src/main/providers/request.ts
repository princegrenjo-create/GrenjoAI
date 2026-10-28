/**
 * Shared request guards for the adapters.
 *
 * Adapters are network-free, but they own two security-relevant decisions:
 * which header carries the credential, and whether a usable credential exists at
 * all. Both live here so five adapters cannot disagree.
 */
import type { ProviderRuntime } from '@shared/provider-contract';
import { AppError, appError } from '@shared/errors';

/**
 * Return the credential to place in a request header.
 *
 * An empty key is a configuration mistake the adapter must not paper over with
 * a request that will fail upstream with a confusing 401. Control characters are
 * rejected because a key containing CR/LF would otherwise be a header-injection
 * primitive.
 */
export function assertApiKey(runtime: ProviderRuntime): string {
  const key = runtime.apiKey;
  if (!key || key.trim().length === 0) {
    throw new AppError(
      appError('missing_key', 'No API key is configured for this provider.', {
        providerId: runtime.providerId,
      }),
    );
  }
  if (/[\r\n\u0000]/.test(key)) {
    throw new AppError(
      appError('validation', 'The stored API key contains characters that are not allowed in an HTTP header.', {
        providerId: runtime.providerId,
      }),
    );
  }
  return key.trim();
}

/** JSON request headers. The credential is added by the adapter that owns it. */
export function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

/**
 * Normalise a provider's finish reason onto the app's vocabulary.
 *
 * An unknown value is passed through rather than flattened to `stop`: reporting
 * an unfamiliar outcome is more honest than claiming a clean completion.
 */
export function normalizeFinishReason(
  raw: string | null,
  table: Readonly<Record<string, string>>,
): string | null {
  if (raw === null || raw.length === 0) return null;
  return table[raw.toLowerCase()] ?? raw;
}
