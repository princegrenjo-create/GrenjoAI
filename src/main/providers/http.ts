/**
 * HTTP primitives for provider I/O.
 *
 * Three rules are enforced here rather than trusted to the caller:
 *
 *  1. `redirect: 'error'` on every request. A provider endpoint that redirects
 *     is refused, so a compromised or misconfigured endpoint cannot bounce the
 *     request — and the credential in its Authorization header — to another
 *     host.
 *  2. A per-request timeout, so a stalled socket never holds a renderer promise
 *     open forever. The timer covers the request phase and is disarmed once the
 *     response headers arrive; response bodies are bounded separately
 *     (`readResponseText`) or by the stream idle timeout (`streamBody`).
 *  3. No logging at all. This module never receives a logger and never emits a
 *     header map, a body or a key; transport failures are converted into the
 *     shared `AppError` shape with a redacted, truncated message.
 *
 * Adapter tests never reach this code: adapters only build specs and parse
 * bodies, and a test supplies a fake `FetchLike`.
 */
import type {
  FetchInitLike,
  FetchLike,
  HttpRequestSpec,
  HttpResponseHeaders,
  HttpResponseLike,
} from '@shared/provider-contract';
import { AppError, appError } from '@shared/errors';

/** Matches `DEFAULT_SETTINGS.generation.requestTimeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Header names exposed on `TransportResponse.headers`. */
const EXPOSED_HEADERS = [
  'content-type',
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-processing-ms',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-remaining',
] as const;

export interface CreateFetchOptions {
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injection point; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

function globalFetch(url: string, init: FetchInitLike): Promise<HttpResponseLike> {
  return globalThis.fetch(url, init);
}

/**
 * Build the hardened `FetchLike` a `ProviderRuntime` carries.
 *
 * The returned function always overtakes `redirect` with `'error'` and always
 * applies a timeout; transport failures become `AppError` values so no raw
 * undici error (which can embed the URL) ever reaches a log or a toast.
 */
export function createFetch(options: CreateFetchOptions = {}): FetchLike {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const underlying: FetchLike = options.fetchImpl ?? globalFetch;

  return async (url, init) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const outer = init.signal;
    const onOuterAbort = (): void => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      return await underlying(url, { ...init, signal: controller.signal, redirect: 'error' });
    } catch (err) {
      throw toTransportError(err, {
        timedOut,
        abortedByCaller: outer?.aborted === true,
        timeoutMs,
      });
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
  };
}

export interface PerformRequestOptions {
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

/**
 * Perform one request and hand back the raw response — including a 4xx/5xx,
 * which is a normal outcome the adapter maps, not a transport failure.
 */
export async function performRequest(
  spec: HttpRequestSpec,
  options: PerformRequestOptions,
): Promise<HttpResponseLike> {
  const init: FetchInitLike = {
    method: spec.method,
    headers: spec.headers,
    redirect: 'error',
  };
  if (spec.body !== null) init.body = spec.body;
  if (options.signal) init.signal = options.signal;
  return options.fetchImpl(spec.url, init);
}

export interface SendOnceOptions {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SendOnceResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** One request, whole body, any HTTP status. */
export async function sendOnce(
  spec: HttpRequestSpec,
  options: SendOnceOptions,
): Promise<SendOnceResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const response = await performRequest(spec, {
    fetchImpl: options.fetchImpl,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await readResponseText(response, timeoutMs);
  return { status: response.status, headers: collectHeaders(response.headers), text };
}

/**
 * Read a whole response body with a deadline.
 *
 * The contract's header surface only supports `get`, so the returned map probes
 * a fixed list of documented headers rather than enumerating everything. That is
 * deliberate: enumeration would hand arbitrary provider-controlled header names
 * (and potentially values containing echoed credentials) to callers that log
 * them.
 */
export function collectHeaders(headers: HttpResponseHeaders): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const name of EXPOSED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) collected[name] = value;
  }
  return collected;
}

/** Read a body as text, failing with `timeout` if it does not complete. */
export async function readResponseText(response: HttpResponseLike, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AppError(appError('timeout', `The provider response body did not complete within ${timeoutMs} ms`))),
      Math.max(1, timeoutMs),
    );
  });
  try {
    return await Promise.race([response.text(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface StreamBodyOptions {
  /** Abort when no bytes arrive for this long. */
  idleTimeoutMs: number;
  signal?: AbortSignal;
}

/** The reader's resolved result, named without relying on a lib-specific type. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/**
 * Read a response stream as text, invoking `onChunk` with each decoded fragment.
 *
 * A multi-byte UTF-8 sequence split across two chunks is reassembled by the
 * streaming decoder. An abort cancels the reader (so the socket is released) and
 * surfaces `cancelled`; a stall surfaces `timeout`.
 */
export async function streamBody(
  response: HttpResponseLike,
  onChunk: (text: string) => void,
  options: StreamBodyOptions,
): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new AppError(appError('provider_error', 'The provider returned an empty response body'));
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const signal = options.signal;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => {
    cancel();
  };

  if (signal) {
    if (signal.aborted) {
      cancel();
      throw cancelledError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      let result: StreamReadResult;
      try {
        result = await readWithIdleTimeout(reader, options.idleTimeoutMs);
      } catch (err) {
        cancel();
        throw err;
      }
      if (result.done) break;
      const value = result.value;
      if (value && value.byteLength > 0) {
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) onChunk(text);
      }
      if (signal?.aborted) throw cancelledError();
    }
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
    if (signal?.aborted) throw cancelledError();
  } catch (err) {
    cancel();
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The reader is already closed and released after cancel(); nothing to do.
    }
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<StreamReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AppError(appError('timeout', `The provider stream sent no data for ${idleTimeoutMs} ms`))),
      Math.max(1, idleTimeoutMs),
    );
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Combine the caller's abort signal with an inner one (or `undefined` when
 * neither exists). Node's `AbortSignal.any` drops its listeners when it is
 * collected, so no listener accumulates on a long-lived runtime signal.
 */
export function combineSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export interface TransportFailureContext {
  timedOut: boolean;
  abortedByCaller: boolean;
  timeoutMs: number;
  providerId?: string;
}

/**
 * Convert anything thrown by a fetch implementation into the shared error
 * shape. The message never contains the URL, a header or a key.
 */
export function toTransportError(err: unknown, context: TransportFailureContext): AppError {
  if (err instanceof AppError) return err;

  const extra = context.providerId ? { providerId: context.providerId } : {};

  if (context.timedOut) {
    return new AppError(
      appError('timeout', `The provider did not respond within ${context.timeoutMs} ms`, extra),
    );
  }
  if (context.abortedByCaller || isAbortError(err)) {
    return new AppError(appError('cancelled', 'The request was cancelled', extra));
  }
  if (looksLikeRedirectFailure(err)) {
    return new AppError(
      appError(
        'provider_error',
        'The provider endpoint redirected. Redirects are refused so the API key is never forwarded to another host.',
        extra,
      ),
    );
  }
  return new AppError(
    appError('offline', 'Could not reach the provider endpoint. Check the connection and the base URL.', extra),
  );
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

function looksLikeRedirectFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = err.cause;
  const detail = `${err.message} ${cause instanceof Error ? cause.message : ''}`;
  return /redirect/i.test(detail);
}

export function cancelledError(): AppError {
  return new AppError(appError('cancelled', 'The request was cancelled'));
}
