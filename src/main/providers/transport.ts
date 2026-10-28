/**
 * The application's single provider I/O engine — `ProviderTransport`.
 *
 * `send` performs one request and returns the body for any HTTP status;
 * `run` drives a chat completion end to end: build the spec, send it, feed the
 * bytes through the adapter's `ResponseParser`, invoke hooks, and return the
 * assembled result.
 *
 * Three invariants the rest of the app relies on:
 *
 *  - A request that fails after any content has been emitted is never retried.
 *    Retrying there would duplicate text the user can already see.
 *  - A provider error delivered inside a 2xx response (an `error` object in the
 *    body or a stream error event) is a failed request, never a completed turn:
 *    the parser marks it `finish: 'error'` and `run` throws `provider_error`
 *    after the chunks already parsed from that read have been delivered.
 *  - Nothing is logged. This module has no logger by design; a header map, a
 *    body and a key are all values that must never reach a log sink.
 */
import type {
  ChatCompletionRequest,
  ChatRunHooks,
  ChatRunResult,
  ChatStreamChunk,
  FetchLike,
  HttpRequestSpec,
  HttpResponseLike,
  ProviderAdapter,
  ProviderRuntime,
  ProviderTransport,
  TransportOptions,
  TransportResponse,
} from '@shared/provider-contract';
import type { AppErrorShape, TokenUsage } from '@shared/types';
import { AppError, appError, toAppError } from '@shared/errors';
import {
  DEFAULT_TIMEOUT_MS,
  cancelledError,
  collectHeaders,
  combineSignals,
  createFetch,
  performRequest,
  readResponseText,
  streamBody,
  toTransportError,
} from './http';
import { mergeUsage } from './json';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 800;
const MAX_RETRIES_LIMIT = 5;

/** Collects parser output and forwards it to the caller's hooks. */
class RunState {
  text = '';

  reasoning = '';

  usage: TokenUsage | null = null;

  finishReason: string | null = null;

  private readonly hooks: ChatRunHooks;

  constructor(hooks: ChatRunHooks) {
    this.hooks = hooks;
  }

  /** True once any content has been handed to the caller. */
  get emittedContent(): boolean {
    return this.text.length > 0 || this.reasoning.length > 0;
  }

  absorb(chunks: ChatStreamChunk[]): void {
    for (const chunk of chunks) {
      switch (chunk.type) {
        case 'text':
          this.text += chunk.text;
          this.hooks.onText?.(chunk.text);
          break;
        case 'reasoning':
          this.reasoning += chunk.text;
          this.hooks.onReasoning?.(chunk.text);
          break;
        case 'usage':
          this.usage = mergeUsage(this.usage, chunk.usage);
          this.hooks.onUsage?.(chunk.usage);
          break;
        case 'finish':
          this.finishReason = chunk.reason;
          break;
      }
    }
  }
}

class HttpProviderTransport implements ProviderTransport {
  private readonly fetchImpl: FetchLike;

  private readonly defaultTimeoutMs: number;

  constructor(fetchImpl: FetchLike, defaultTimeoutMs: number) {
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async send(spec: HttpRequestSpec, options: TransportOptions = {}): Promise<TransportResponse> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    try {
      const response = await performRequest(spec, { fetchImpl: this.fetchImpl, signal });
      const body = await readResponseText(response, timeoutMs);
      return { status: response.status, body, headers: collectHeaders(response.headers) };
    } catch (err) {
      throw toTransportError(err, {
        timedOut: timeoutSignal.aborted,
        abortedByCaller: options.signal?.aborted === true,
        timeoutMs,
      });
    }
  }

  async run(
    runtime: ProviderRuntime,
    adapter: ProviderAdapter,
    request: ChatCompletionRequest,
    hooks: ChatRunHooks = {},
    options: TransportOptions = {},
  ): Promise<ChatRunResult> {
    // Building the spec is pure and may throw (missing_key, bad key characters)
    // before any I/O: that class of failure is never retried.
    const spec = adapter.buildChatRequest(runtime, request);
    const maxRetries = normalizeRetries(options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const retryBackoffMs = Math.max(0, options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const callerSignal = combineSignals([options.signal, runtime.signal]);
    let attempt = 0;

    for (;;) {
      const state = new RunState(hooks);
      try {
        const response = await this.openResponse(runtime, spec, timeoutMs, callerSignal);

        if (response.status < 200 || response.status >= 300) {
          const body = await readResponseText(response, timeoutMs);
          const shape = adapter.parseError(response.status, body, runtime.providerId);
          throw new AppError(withProviderId(shape, runtime.providerId));
        }

        const parser = adapter.createResponseParser(request.stream);
        if (request.stream) {
          await streamBody(
            response,
            (text) => {
              state.absorb(parser.push(text));
            },
            { idleTimeoutMs: timeoutMs, ...(callerSignal ? { signal: callerSignal } : {}) },
          );
          state.absorb(parser.end());
        } else {
          const body = await readResponseText(response, timeoutMs);
          state.absorb(parser.push(body));
          state.absorb(parser.end());
        }

        if (state.finishReason === 'error') {
          // The provider returned HTTP 200 and then reported an error inside
          // the body/stream. That is a failed request: a finish reason of
          // "error" must never reach a caller as a completed turn. Anything
          // already parsed from the same read has been delivered to the hooks
          // by now, so partial text is preserved in the caller's accumulation.
          throw new AppError(
            appError('provider_error', 'The provider reported an error during the response.', {
              retryable: true,
            }),
          );
        }
        if (state.finishReason !== null) hooks.onFinish?.(state.finishReason);
        return { text: state.text, usage: state.usage, finishReason: state.finishReason };
      } catch (err) {
        if (callerSignal?.aborted) {
          throw new AppError(
            appError('cancelled', 'The request was cancelled', { providerId: runtime.providerId }),
          );
        }
        const shape = withProviderId(toAppError(err, 'provider_error'), runtime.providerId);
        const retryable = shape.retryable && !state.emittedContent;
        if (!retryable || attempt >= maxRetries) throw new AppError(shape);
        attempt += 1;
        await delay(retryBackoffMs * 2 ** (attempt - 1), callerSignal);
      }
    }
  }

  /**
   * One request attempt. The timer covers the request phase and is disarmed as
   * soon as the response headers arrive: a long generation is bounded by the
   * stream idle timeout, not by an absolute wall-clock cap that would truncate
   * a healthy answer.
   */
  private async openResponse(
    runtime: ProviderRuntime,
    spec: HttpRequestSpec,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<HttpResponseLike> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const attemptSignal = combineSignals([callerSignal, controller.signal]);

    try {
      return await performRequest(spec, {
        // Tests inject a fake through the runtime; production resolves the
        // transport's own hardened fetch, which is the only place I/O happens.
        fetchImpl: runtime.fetchImpl ?? this.fetchImpl,
        ...(attemptSignal ? { signal: attemptSignal } : {}),
      });
    } catch (err) {
      throw toTransportError(err, {
        timedOut,
        abortedByCaller: callerSignal?.aborted === true,
        timeoutMs,
        providerId: runtime.providerId,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Attach the provider id when an adapter's error was built without one. */
function withProviderId(shape: AppErrorShape, providerId: string): AppErrorShape {
  if (shape.providerId || !providerId) return shape;
  return { ...shape, providerId };
}

function normalizeRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
  return Math.max(0, Math.min(MAX_RETRIES_LIMIT, Math.floor(value)));
}

/** Backoff sleep that rejects `cancelled` the moment the caller aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      cleanup();
      reject(cancelledError());
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(cancelledError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * `CreateTransport` — the production transport, using the global `fetch`.
 * `send` is the only method that needs it; `run` uses the runtime's own
 * injectable `FetchLike`, which is what keeps tests offline.
 */
export function createProviderTransport(): ProviderTransport {
  return new HttpProviderTransport(createFetch(), DEFAULT_TIMEOUT_MS);
}

/**
 * Test/diagnostic seam: a transport whose `send` uses the supplied fetch.
 * Production code calls `createProviderTransport()`.
 */
export function createProviderTransportWith(
  fetchImpl: FetchLike,
  defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
): ProviderTransport {
  return new HttpProviderTransport(fetchImpl, Math.max(1, defaultTimeoutMs));
}
