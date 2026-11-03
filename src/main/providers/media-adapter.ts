/**
 * Shared plumbing for media adapters.
 *
 * Three things every provider-specific adapter needs and none should re-invent:
 * a base64 decode that fails loudly, an HTTP status → retryable-verdict mapping,
 * and a way to pull a provider's own error message out of a body that is usually
 * JSON but is not guaranteed to be.
 *
 * The mapping encodes a rule the UI depends on: a 4xx caused by the *request*
 * (bad parameter, moderation, bad key) is never retried, because retrying sends
 * the same thing again. Only rate limits and server-side failures are.
 */
import type { MediaJobError } from '@shared/media-job';

export function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface ProviderErrorBody {
  message?: string;
  code?: string;
}

/**
 * Reads whatever a provider put in an error body.
 *
 * OpenAI nests under `error`; Gemini under `error` too but with a numeric `code`
 * and a `status` string; a captured body may be plain text or a gateway page. All
 * of them become one message, or null when nothing readable is there.
 */
export function parseErrorBody(body: string): ProviderErrorBody {
  const trimmed = body.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { message: trimmed.slice(0, 300) };
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const record = parsed as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === 'object' && nested !== null) {
    const inner = nested as Record<string, unknown>;
    const message = typeof inner.message === 'string' ? inner.message : undefined;
    const code =
      typeof inner.code === 'string'
        ? inner.code
        : typeof inner.status === 'string'
          ? inner.status
          : undefined;
    return { message, code };
  }
  const message = typeof record.message === 'string' ? record.message : undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;
  return { message, code };
}

/**
 * One media error from a status code, a parsed body and the provider's name.
 *
 * `code` is stable and shared across providers so the UI can decide what to
 * offer (a retry button for a rate limit, an explanation for a missing key, a
 * refusal to retry for moderation) without knowing which API produced it.
 */
export function mediaErrorFromResponse(
  providerLabel: string,
  status: number,
  body: string,
): MediaJobError {
  const parsed = parseErrorBody(body);
  const detail = parsed.message ? ` ${parsed.message}` : '';

  if (status === 401 || status === 403) {
    return {
      code: 'invalid_key',
      message: `${providerLabel} rejected the API key. Check it on the Models & Providers page.${detail}`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: `${providerLabel} is rate-limiting this account. The request will be retried.${detail}`,
      retryable: true,
    };
  }
  if (status === 413) {
    return {
      code: 'bad_request',
      message: `The request is too large for ${providerLabel}.${detail}`,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      code: 'provider_error',
      message: `${providerLabel} could not complete the request. It will be retried.${detail}`,
      retryable: true,
    };
  }
  if (parsed.code === 'moderation_blocked' || /content policy|safety/i.test(parsed.message ?? '')) {
    return {
      code: 'moderation_blocked',
      message: `${providerLabel} refused this prompt under its content policy. Editing the prompt is the only fix.${detail}`,
      retryable: false,
    };
  }
  return {
    code: 'bad_request',
    message: `${providerLabel} rejected the request.${detail}`,
    retryable: false,
  };
}

/**
 * Base64 payload for an inline image block (Gemini), without the `data:` prefix.
 * Kept separate from `toDataUrl` because the two providers want different forms
 * and conflating them is how a data URL ends up inside a JSON field that expects
 * raw base64.
 */
export function toDataUrlData(_mime: string, bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}