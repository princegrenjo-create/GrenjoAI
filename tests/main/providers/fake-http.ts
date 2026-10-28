/**
 * Shared fixtures for the provider suite.
 *
 * Everything here is offline by construction: request-shape tests are given a
 * runtime WITHOUT a `fetchImpl` (so an adapter that tried to perform I/O would
 * throw), and transport tests inject a `FetchLike` over in-memory responses.
 * No test contacts a provider.
 */
import type {
  ChatCompletionRequest,
  ChatStreamChunk,
  FetchInitLike,
  FetchLike,
  HttpRequestSpec,
  HttpResponseLike,
  ProviderRuntime,
  ResponseParser,
} from '@shared/provider-contract';

export const TEST_KEY = 'sk-test-KEY-0123456789abcdef';
export const TEST_ANTHROPIC_KEY = 'sk-ant-test-KEY-0123456789abcdef';
export const TEST_GEMINI_KEY = 'AIzaSyTESTKEY0123456789abcdef';

export interface RecordedCall {
  url: string;
  init: FetchInitLike;
}

export interface FakeFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/** A `FetchLike` that records its calls and answers from a handler. */
export function fakeFetch(
  handler: (call: RecordedCall) => HttpResponseLike | Promise<HttpResponseLike>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: RecordedCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

/** Answers with the responses in order; a call past the end fails loudly. */
export function sequentialFetch(responses: readonly HttpResponseLike[]): FakeFetch {
  let index = 0;
  return fakeFetch(() => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error(`unexpected request #${index}`);
    return response;
  });
}

export function createRuntime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    providerId: 'prov-test',
    baseUrl: 'https://api.example.test/v1',
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** A request that fills every parameter, so each adapter's mapping is visible. */
export function createRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    modelId: 'test-model',
    system: 'You are terse.',
    turns: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Explain SSE.' },
    ],
    params: {
      temperature: 0.4,
      topP: 0.9,
      topK: 7,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      maxOutputTokens: 256,
      stop: ['END'],
      seed: 42,
      weirdness: 0.35,
      reasoningEffort: 'low',
    },
    stream: true,
    ...overrides,
  };
}

function headerMap(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) map.set(name.toLowerCase(), value);
  return map;
}

/** A response with a whole body and no stream. */
export function jsonResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const map = headerMap(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
    body: null,
  };
}

/** A response whose body delivers each string as its own read. */
export function streamResponse(chunks: readonly string[]): HttpResponseLike {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    body,
  };
}

/** A response that emits an optional first chunk and then fails the reader. */
export function failingStreamResponse(chunks: readonly string[], error: Error): HttpResponseLike {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.error(error);
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    body,
  };
}

/** A response whose body never produces another byte. */
export function hangingResponse(first?: string): HttpResponseLike {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first !== undefined) controller.enqueue(encoder.encode(first));
      // Deliberately never closed: the idle timeout is what must fire.
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    body,
  };
}

/** A fetch whose promise only settles when the request signal aborts. */
export function signalAwareHangingFetch(): FakeFetch {
  return fakeFetch(
    (call) =>
      new Promise<HttpResponseLike>((_resolve, reject) => {
        const signal = call.init.signal;
        const onAbort = (): void => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (!signal) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
  );
}

export function bodyOf(spec: HttpRequestSpec): unknown {
  return spec.body === null ? null : JSON.parse(spec.body);
}

/** Case-insensitive header lookup on a built request spec. */
export function headerOf(spec: HttpRequestSpec, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(spec.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Headers whose value contains the credential. */
export function headersCarrying(spec: HttpRequestSpec, key: string): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(spec.headers)) {
    if (value.includes(key)) names.push(name);
  }
  return names;
}

export function drainParser(parser: ResponseParser, chunks: readonly string[]): ChatStreamChunk[] {
  const collected: ChatStreamChunk[] = [];
  for (const chunk of chunks) collected.push(...parser.push(chunk));
  collected.push(...parser.end());
  return collected;
}

/** Split a fixture body into fixed-size string chunks. */
export function sliceChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export function textOf(chunks: readonly ChatStreamChunk[]): string {
  let text = '';
  for (const chunk of chunks) {
    if (chunk.type === 'text') text += chunk.text;
  }
  return text;
}

export function reasoningOf(chunks: readonly ChatStreamChunk[]): string {
  let text = '';
  for (const chunk of chunks) {
    if (chunk.type === 'reasoning') text += chunk.text;
  }
  return text;
}

export function finishReasonOf(chunks: readonly ChatStreamChunk[]): string | null {
  let reason: string | null = null;
  for (const chunk of chunks) {
    if (chunk.type === 'finish') reason = chunk.reason;
  }
  return reason;
}
