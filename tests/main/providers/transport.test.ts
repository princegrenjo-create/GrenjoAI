import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@shared/types';
import { createDeepSeekAdapter } from '@main/providers/deepseek';
import { createProviderTransportWith } from '@main/providers/transport';
import {
  createRequest,
  createRuntime,
  fakeFetch,
  failingStreamResponse,
  hangingResponse,
  jsonResponse,
  sequentialFetch,
  signalAwareHangingFetch,
  sliceChunks,
  streamResponse,
} from './fake-http';

const adapter = createDeepSeekAdapter();

const SSE_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const ERROR_401 = JSON.stringify({ error: { message: 'Incorrect API key provided' } });

describe('transport.run — success paths', () => {
  it('assembles text from a chunked stream and fires hooks in order', async () => {
    const fake = fakeFetch(() => streamResponse(sliceChunks(SSE_BODY, 7)));
    const transport = createProviderTransportWith(fake.fetchImpl);
    const runtime = createRuntime({ fetchImpl: fake.fetchImpl });

    const texts: string[] = [];
    const usages: TokenUsage[] = [];
    const finishes: string[] = [];

    const result = await transport.run(
      runtime,
      adapter,
      createRequest(),
      {
        onText: (text) => texts.push(text),
        onUsage: (usage) => usages.push(usage),
        onFinish: (reason) => finishes.push(reason),
      },
      { retryBackoffMs: 0 },
    );

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
    expect(result.finishReason).toBe('stop');
    expect(texts.join('')).toBe('Hello world');
    expect(usages).toEqual([{ promptTokens: 4, completionTokens: 2, totalTokens: 6 }]);
    expect(finishes).toEqual(['stop']);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.redirect).toBe('error');
    const sentBody = JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
  });

  it('runs a buffered request when the caller asked for one chunk', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'buffered text' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const fake = fakeFetch(() => jsonResponse(200, body));
    const transport = createProviderTransportWith(fake.fetchImpl);

    const result = await transport.run(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest({ stream: false }),
      {},
      { retryBackoffMs: 0 },
    );

    expect(result.text).toBe('buffered text');
    expect(result.finishReason).toBe('stop');
    const sentBody = JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
    expect(sentBody.stream).toBe(false);
  });

  it('does not call onFinish when the provider never reported a reason', async () => {
    const fake = fakeFetch(() =>
      streamResponse(['data: {"choices":[{"index":0,"delta":{"content":"cut"}}]}\n\n']),
    );
    const transport = createProviderTransportWith(fake.fetchImpl);
    const finishes: string[] = [];

    const result = await transport.run(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest(),
      { onFinish: (reason) => finishes.push(reason) },
      { retryBackoffMs: 0 },
    );

    expect(result.text).toBe('cut');
    expect(result.finishReason).toBeNull();
    expect(finishes).toEqual([]);
  });
});

describe('transport.run — HTTP error mapping', () => {
  it('maps a 401 through the adapter error mapper and never retries it', async () => {
    const fake = sequentialFetch([jsonResponse(401, ERROR_401), jsonResponse(401, ERROR_401)]);
    const transport = createProviderTransportWith(fake.fetchImpl);

    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl }), adapter, createRequest(), {}, { retryBackoffMs: 0 }),
    ).rejects.toMatchObject({
      shape: { code: 'invalid_key', retryable: false, providerId: 'prov-test', status: 401 },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('maps a 404 to model_not_found without retrying', async () => {
    const fake = fakeFetch(() => jsonResponse(404, '{}'));
    const transport = createProviderTransportWith(fake.fetchImpl);
    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl }), adapter, createRequest(), {}, { retryBackoffMs: 0 }),
    ).rejects.toMatchObject({ shape: { code: 'model_not_found' } });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('transport.run — bounded retry', () => {
  it('retries a retryable 429 before any content and then succeeds', async () => {
    const fake = sequentialFetch([
      jsonResponse(429, '{"error":{"message":"rate limited"}}'),
      streamResponse([SSE_BODY]),
    ]);
    const transport = createProviderTransportWith(fake.fetchImpl);

    const result = await transport.run(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest(),
      {},
      { retryBackoffMs: 0 },
    );

    expect(result.text).toBe('Hello world');
    expect(fake.calls).toHaveLength(2);
  });

  it('stops after the retry budget (default 2 retries = 3 attempts)', async () => {
    const fake = sequentialFetch([
      jsonResponse(500, 'oops'),
      jsonResponse(500, 'oops'),
      jsonResponse(500, 'oops'),
      jsonResponse(500, 'unexpected fourth attempt'),
    ]);
    const transport = createProviderTransportWith(fake.fetchImpl);

    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl }), adapter, createRequest(), {}, { retryBackoffMs: 0 }),
    ).rejects.toMatchObject({ shape: { code: 'provider_error', retryable: true } });
    expect(fake.calls).toHaveLength(3);
  });

  it('honours maxRetries: 0', async () => {
    const fake = sequentialFetch([jsonResponse(503, 'busy'), jsonResponse(503, 'busy')]);
    const transport = createProviderTransportWith(fake.fetchImpl);

    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl }), adapter, createRequest(), {}, {
        retryBackoffMs: 0,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ shape: { code: 'provider_error' } });
    expect(fake.calls).toHaveLength(1);
  });

  it('never retries a failure after text has been emitted', async () => {
    const fake = fakeFetch(() =>
      failingStreamResponse(
        ['data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'],
        new Error('stream reset'),
      ),
    );
    const transport = createProviderTransportWith(fake.fetchImpl);
    const seen: string[] = [];

    await expect(
      transport.run(
        createRuntime({ fetchImpl: fake.fetchImpl }),
        adapter,
        createRequest(),
        { onText: (text) => seen.push(text) },
        { retryBackoffMs: 0 },
      ),
    ).rejects.toMatchObject({ shape: { code: 'provider_error', retryable: true } });

    expect(fake.calls).toHaveLength(1);
    expect(seen).toEqual(['partial']);
  });

  it('fails, without retrying, when an in-band error frame arrives after text', async () => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}',
      '',
      'data: {"error":{"message":"upstream overloaded"}}',
      '',
      '',
    ].join('\n');
    const fake = fakeFetch(() => streamResponse([body]));
    const transport = createProviderTransportWith(fake.fetchImpl);
    const seen: string[] = [];

    await expect(
      transport.run(
        createRuntime({ fetchImpl: fake.fetchImpl }),
        adapter,
        createRequest(),
        { onText: (text) => seen.push(text) },
        { retryBackoffMs: 0, maxRetries: 2 },
      ),
    ).rejects.toMatchObject({ shape: { code: 'provider_error' } });

    // The text parsed before the error frame was delivered, not discarded.
    expect(seen).toEqual(['partial']);
    expect(fake.calls).toHaveLength(1);
  });

  it('fails on an in-band error frame even before any text arrived', async () => {
    const body = ['data: {"error":{"message":"upstream overloaded"}}', '', ''].join('\n');
    const fake = fakeFetch(() => streamResponse([body]));
    const transport = createProviderTransportWith(fake.fetchImpl);

    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl }), adapter, createRequest(), {}, {
        retryBackoffMs: 0,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ shape: { code: 'provider_error', retryable: true } });
  });
});

describe('transport.run — cancellation and configuration', () => {
  it('fails with missing_key and performs no request when no credential is set', async () => {
    const fake = fakeFetch(() => streamResponse([SSE_BODY]));
    const transport = createProviderTransportWith(fake.fetchImpl);

    await expect(
      transport.run(createRuntime({ fetchImpl: fake.fetchImpl, apiKey: '' }), adapter, createRequest(), {}, {
        retryBackoffMs: 0,
      }),
    ).rejects.toMatchObject({ shape: { code: 'missing_key' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('aborting mid-stream yields cancelled and keeps only the text that arrived', async () => {
    const fake = fakeFetch(() =>
      hangingResponse('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'),
    );
    const transport = createProviderTransportWith(fake.fetchImpl);
    const controller = new AbortController();
    const seen: string[] = [];

    await expect(
      transport.run(
        createRuntime({ fetchImpl: fake.fetchImpl, signal: controller.signal }),
        adapter,
        createRequest(),
        {
          onText: (text) => {
            seen.push(text);
            controller.abort();
          },
        },
        { retryBackoffMs: 0 },
      ),
    ).rejects.toMatchObject({ shape: { code: 'cancelled' } });

    expect(fake.calls).toHaveLength(1);
    expect(seen).toEqual(['Hi']);
  });
});

describe('transport.send', () => {
  it('resolves a 401 instead of throwing', async () => {
    const fake = fakeFetch(() =>
      jsonResponse(401, ERROR_401, { 'content-type': 'application/json' }),
    );
    const transport = createProviderTransportWith(fake.fetchImpl);

    const response = await transport.send(adapter.buildTestRequest(createRuntime()), { timeoutMs: 500 });

    expect(response.status).toBe(401);
    expect(response.body).toContain('Incorrect API key provided');
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('returns the body of a successful response', async () => {
    const fake = fakeFetch(() => jsonResponse(200, '{"data":[]}'));
    const transport = createProviderTransportWith(fake.fetchImpl);
    const response = await transport.send(adapter.buildTestRequest(createRuntime()));
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"data":[]}');
  });

  it('throws offline for a transport failure', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const transport = createProviderTransportWith(fake.fetchImpl);
    await expect(transport.send(adapter.buildTestRequest(createRuntime()))).rejects.toMatchObject({
      shape: { code: 'offline' },
    });
  });

  it('throws timeout when the provider does not answer', async () => {
    const fake = signalAwareHangingFetch();
    const transport = createProviderTransportWith(fake.fetchImpl);
    await expect(
      transport.send(adapter.buildTestRequest(createRuntime()), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ shape: { code: 'timeout' } });
  });

  it('sends redirect: "error" for a raw spec', async () => {
    const fake = fakeFetch(() => jsonResponse(200, '{}'));
    const transport = createProviderTransportWith(fake.fetchImpl);
    await transport.send(adapter.buildChatRequest(createRuntime(), createRequest()));
    expect(fake.calls[0]?.init.redirect).toBe('error');
  });
});
