/**
 * Error model shared by main, preload and renderer.
 *
 * Two hard rules live here because every layer depends on them:
 *  1. A credential never appears in an error message, a log line or a toast.
 *  2. A failed request never produces a message the UI could mistake for a
 *     successful reply.
 */
import type { AppErrorShape, ErrorCode } from './types';

const REDACTIONS: Array<[RegExp, string]> = [
  // OpenAI / DeepSeek / Anthropic style keys.
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-REDACTED'],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{6,}/g, 'AIza-REDACTED'],
  // Authorization headers echoed back by a gateway.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer REDACTED'],
  [/\bx-api-key\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{6,}/gi, 'x-api-key: REDACTED'],
  [/\bx-goog-api-key\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{6,}/gi, 'x-goog-api-key: REDACTED'],
  // JWTs (Supabase access/refresh tokens).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, 'JWT-REDACTED'],
  // Query-string credentials on a URL the user pasted.
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1REDACTED'],
];

/** Remove anything that looks like a credential. Applied to every outbound error. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Defensive truncation so a provider never floods the renderer with a body. */
export function truncate(input: string, max = 400): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}

export class AppError extends Error {
  readonly shape: AppErrorShape;

  constructor(shape: AppErrorShape) {
    super(shape.message);
    this.name = 'AppError';
    this.shape = shape;
  }

  get code(): ErrorCode {
    return this.shape.code;
  }

  get retryable(): boolean {
    return this.shape.retryable;
  }
}

const RETRYABLE: Record<ErrorCode, boolean> = {
  missing_key: false,
  invalid_key: false,
  rate_limited: true,
  timeout: true,
  offline: true,
  model_not_found: false,
  context_length: false,
  provider_error: true,
  bad_request: false,
  cancelled: false,
  not_found: false,
  validation: false,
  storage: false,
  sync_auth: false,
  sync_config: false,
  unknown: false,
};

export function appError(
  code: ErrorCode,
  message: string,
  extra: Partial<Omit<AppErrorShape, 'code' | 'message'>> = {},
): AppErrorShape {
  return {
    code,
    message: redactSecrets(truncate(message, 500)),
    retryable: extra.retryable ?? RETRYABLE[code],
    ...(extra.providerId ? { providerId: extra.providerId } : {}),
    ...(extra.status ? { status: extra.status } : {}),
  };
}

/** Map an HTTP status to the error vocabulary used by the UI. */
export function errorForStatus(
  status: number,
  providerMessage: string | null,
  providerId?: string,
): AppErrorShape {
  const detail = providerMessage ? redactSecrets(truncate(providerMessage, 300)) : null;
  const suffix = detail ? ` — ${detail}` : '';
  if (status === 401 || status === 403) {
    return appError('invalid_key', `The provider rejected the API key (HTTP ${status})${suffix}`, {
      providerId,
      status,
      retryable: false,
    });
  }
  if (status === 404) {
    return appError(
      'model_not_found',
      `The provider returned 404 — the model id or endpoint path is wrong${suffix}`,
      { providerId, status, retryable: false },
    );
  }
  if (status === 400 || status === 422) {
    return appError('bad_request', `The provider rejected the request (HTTP ${status})${suffix}`, {
      providerId,
      status,
      retryable: false,
    });
  }
  if (status === 413) {
    return appError('context_length', 'The request is larger than the provider allows', {
      providerId,
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return appError(
      'rate_limited',
      `The provider rate-limited this request. Wait a moment and retry${suffix}`,
      { providerId, status, retryable: true },
    );
  }
  if (status === 408 || status === 504) {
    return appError('timeout', `The provider timed out (HTTP ${status})${suffix}`, {
      providerId,
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return appError(
      'provider_error',
      `The provider reported a server error (HTTP ${status})${suffix}`,
      { providerId, status, retryable: true },
    );
  }
  return appError('provider_error', `Unexpected provider response (HTTP ${status})${suffix}`, {
    providerId,
    status,
    retryable: false,
  });
}

const KNOWN_CODES = new Set<string>([
  'missing_key',
  'invalid_key',
  'rate_limited',
  'timeout',
  'offline',
  'model_not_found',
  'context_length',
  'provider_error',
  'bad_request',
  'cancelled',
  'not_found',
  'validation',
  'storage',
  'sync_auth',
  'sync_config',
  'unknown',
]);

/** Normalise anything thrown anywhere into the shared error shape. */
export function toAppError(err: unknown, fallbackCode: ErrorCode = 'unknown'): AppErrorShape {
  if (err && typeof err === 'object' && 'shape' in err) {
    const shape = (err as AppError).shape;
    if (shape && typeof shape.code === 'string' && KNOWN_CODES.has(shape.code)) {
      return {
        ...shape,
        message: redactSecrets(truncate(shape.message, 500)),
      };
    }
  }
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return appError('cancelled', 'The request was cancelled');
    }
    const decoded = parseIpcErrorMessage(err.message, fallbackCode);
    if (decoded) return decoded;
    return appError(fallbackCode, err.message || name || 'Unexpected error');
  }
  if (typeof err === 'string') {
    const decoded = parseIpcErrorMessage(err, fallbackCode);
    if (decoded) return decoded;
    return appError(fallbackCode, err);
  }
  return appError(fallbackCode, 'Unexpected error');
}

/** True for the class of failure the retry loop must not retry. */
export function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'name' in err &&
    ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError')
  );
}

/**
 * Recover the structured error from anything that crossed the preload bridge.
 *
 * This is deliberately defensive because of a hard platform constraint: Electron's
 * `contextBridge` converts *any* thrown value into a plain `Error` and keeps only
 * its `message` — custom properties are silently dropped. A probe
 * (`.work/2026-10-29-personal-ai-desk/tmp/apperror-probe.cjs`) proved that an
 * `Error` with an `appError` property, a plain object with `appError`, and a
 * flattened plain object all arrive as `Error { message }` with no extra keys.
 *
 * So the code must travel *inside the message*, where it does survive, as a
 * `code: human sentence` prefix. Everything else about the shape is derivable —
 * `retryable` from the code table, and the HTTP status is already quoted in the
 * sentence by `errorForStatus`.
 */
const MARKER = /^([a-z][a-z_]{2,32}):\s+([\s\S]+)$/;

export function formatIpcErrorMessage(shape: AppErrorShape): string {
  return `${shape.code}: ${shape.message}`;
}

export function parseIpcErrorMessage(
  text: string,
  fallbackCode: ErrorCode = 'unknown',
): AppErrorShape | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  const code = match[1];
  const message = match[2];
  if (!code || !message || !KNOWN_CODES.has(code)) return null;
  return appError(code as ErrorCode, message, { retryable: RETRYABLE[code as ErrorCode] });
}

export function asAppError(err: unknown, fallbackCode: ErrorCode = 'unknown'): AppErrorShape {
  if (err && typeof err === 'object' && 'appError' in err) {
    const shape = (err as { appError?: unknown }).appError;
    if (
      shape &&
      typeof shape === 'object' &&
      'code' in shape &&
      typeof (shape as AppErrorShape).code === 'string' &&
      KNOWN_CODES.has((shape as AppErrorShape).code)
    ) {
      return shape as AppErrorShape;
    }
  }
  if (err instanceof AppError) return err.shape;

  // A message that crossed the bridge: decode the marker if it is there.
  const text =
    err instanceof Error ? err.message : typeof err === 'string' ? err : null;
  if (text !== null) {
    const decoded = parseIpcErrorMessage(text, fallbackCode);
    if (decoded) return decoded;
  }

  return toAppError(err, fallbackCode);
}

/** A single sentence safe to show in a toast or an error card. */
export function errorText(err: unknown): string {
  return redactSecrets(truncate(asAppError(err).message, 400));
}
