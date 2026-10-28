/**
 * Mobile transport.
 *
 * The desktop transport cannot run here: React Native's built-in `fetch` does not
 * expose a readable body stream. This is the mobile counterpart, built on
 * `expo/fetch`, which does stream. The adapters above it are unchanged â€” they
 * only ever see a `FetchLike`.
 *
 * Deliberate differences from desktop, recorded rather than hidden:
 *  - `redirect: 'error'` is not settable through expo/fetch; React Native follows
 *    redirects, so "a redirect cannot forward your key" is weaker on mobile. The
 *    key-binding-to-base-URL rule still applies.
 *  - There is no `AbortSignal.timeout`; timeouts use an AbortController timer.
 *  - Bodies may be `FormData` (audio upload), which the desktop's spec does not
 *    need because it builds multipart bytes itself.
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { HttpResponseHeaders, HttpResponseLike } from '@core/provider-contract';

export type MobileBody = string | Uint8Array | null | FormData;

export interface MobileFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: MobileBody;
  signal?: AbortSignal;
}

class ExpoHeaders implements HttpResponseHeaders {
  constructor(private readonly source: Headers) {}

  get(name: string): string | null {
    return this.source.get(name);
  }
}

export function toHttpResponse(response: Response): HttpResponseLike {
  return {
    ok: response.ok,
    status: response.status,
    headers: new ExpoHeaders(response.headers as unknown as Headers),
    text: () => response.text(),
    body: response.body as unknown as ReadableStream<Uint8Array> | null,
  };
}

export async function mobileFetch(
  url: string,
  init: MobileFetchInit,
): Promise<HttpResponseLike> {
  const response = await expoFetch(url, {
    method: init.method,
    headers: init.headers,
    body: (init.body ?? undefined) as never,
    signal: init.signal,
  });
  return toHttpResponse(response as unknown as Response);
}

/** A combined signal plus timer, mirroring the desktop timeout behaviour. */
export function createRequestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const onAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onAbort);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Read a streamed body as text chunks until it closes or the signal aborts. */
export async function readStream(
  response: HttpResponseLike,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (!body) {
    onChunk(await response.text());
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}
