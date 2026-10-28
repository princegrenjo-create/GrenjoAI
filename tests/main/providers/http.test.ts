import { describe, expect, it } from 'vitest';
import type { HttpResponseLike } from '@shared/provider-contract';
import {
  createFetch,
  performRequest,
  sendOnce,
  streamBody,
} from '@main/providers/http';
import {
  createRuntime,
  fakeFetch,
  hangingResponse,
  jsonResponse,
  signalAwareHangingFetch,
  streamResponse,
} from './fake-http';

const SPEC = {
  url: 'https://api.example.test/v1/chat/completions',
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
  body: '{"model":"x"}',
};

function byteStream(chunks: readonly Uint8Array[]): HttpResponseLike {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
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

describe('createFetch', () => {
  it('always sends redirect: "error" and forwards method, headers and body', async () => {
    const fake = fakeFetch(() => jsonResponse(200, '{}'));
    const hardened = createFetch({ timeoutMs: 2_000, fetchImpl: fake.fetchImpl });

    await hardened(SPEC.url, {
      method: SPEC.method,
      headers: SPEC.headers,
      body: SPEC.body,
      redirect: 'error',
    });

    const call = fake.calls[0];
    expect(call?.url).toBe(SPEC.url);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.headers).toEqual(SPEC.headers);
    expect(call?.init.body).toBe(SPEC.body);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a network failure to the shared offline error', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const hardened = createFetch({ fetchImpl: fake.fetchImpl });

    await expect(hardened(SPEC.url, { method: 'POST', headers: {}, redirect: 'error' })).rejects.toMatchObject({
      shape: { code: 'offline', retryable: true },
    });
  });

  it('maps a caller abort to cancelled', async () => {
    const fake = signalAwareHangingFetch();
    const hardened = createFetch({ timeoutMs: 5_000, fetchImpl: fake.fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      hardened(SPEC.url, {
        method: 'POST',
        headers: {},
        redirect: 'error',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ shape: { code: 'cancelled' } });
  });

  it('maps its own request timeout to timeout', async () => {
    const fake = signalAwareHangingFetch();
    const hardened = createFetch({ timeoutMs: 5, fetchImpl: fake.fetchImpl });

    await expect(hardened(SPEC.url, { method: 'POST', headers: {}, redirect: 'error' })).rejects.toMatchObject({
      shape: { code: 'timeout', retryable: true },
    });
  });
});

describe('performRequest / sendOnce', () => {
  it('sets redirect: "error" even for an injected fetch', async () => {
    const fake = fakeFetch(() => jsonResponse(200, 'ok'));
    const response = await performRequest(SPEC, { fetchImpl: fake.fetchImpl });
    expect(response.status).toBe(200);
    expect(fake.calls[0]?.init.redirect).toBe('error');
    expect(fake.calls[0]?.init.body).toBe(SPEC.body);
  });

  it('resolves a 401 with its status, body and headers instead of throwing', async () => {
    const fake = fakeFetch(() =>
      jsonResponse(401, '{"error":{"message":"bad key"}}', {
        'content-type': 'application/json',
        'retry-after': '3',
      }),
    );
    const result = await sendOnce(SPEC, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe(401);
    expect(result.text).toBe('{"error":{"message":"bad key"}}');
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['retry-after']).toBe('3');
  });

  it('omits a body for a GET request', async () => {
    const fake = fakeFetch(() => jsonResponse(200, '{}'));
    await performRequest(
      { url: 'https://api.example.test/v1/models', method: 'GET', headers: {}, body: null },
      { fetchImpl: fake.fetchImpl },
    );
    expect(fake.calls[0]?.init.body).toBeUndefined();
  });
});

describe('streamBody', () => {
  it('reassembles a multi-byte character split across two reads', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('héllo ✓');
    const parts: string[] = [];
    const response = byteStream([bytes.slice(0, 2), bytes.slice(2)]);

    await streamBody(response, (text) => parts.push(text), { idleTimeoutMs: 1_000 });

    expect(parts.join('')).toBe('héllo ✓');
  });

  it('delivers each read in order', async () => {
    const parts: string[] = [];
    await streamBody(streamResponse(['one', 'two', 'three']), (text) => parts.push(text), {
      idleTimeoutMs: 1_000,
    });
    expect(parts).toEqual(['one', 'two', 'three']);
  });

  it('fails with timeout when the stream stalls', async () => {
    await expect(
      streamBody(hangingResponse(), () => undefined, { idleTimeoutMs: 5 }),
    ).rejects.toMatchObject({ shape: { code: 'timeout' } });
  });

  it('fails when the provider sends no body at all', async () => {
    await expect(
      streamBody(jsonResponse(200, ''), () => undefined, { idleTimeoutMs: 100 }),
    ).rejects.toMatchObject({ shape: { code: 'provider_error' } });
  });

  it('fails immediately with cancelled when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamBody(streamResponse(['a']), () => undefined, {
        idleTimeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ shape: { code: 'cancelled' } });
  });

  it('stops delivering and releases the reader when aborted mid-stream', async () => {
    const controller = new AbortController();
    const parts: string[] = [];
    let cancelCalled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('first'));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const response: HttpResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      body,
    };

    await expect(
      streamBody(
        response,
        (text) => {
          parts.push(text);
          // Abort from inside the delivery callback: deterministic, no timers.
          controller.abort();
        },
        { idleTimeoutMs: 1_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ shape: { code: 'cancelled' } });

    expect(parts).toEqual(['first']);
    expect(cancelCalled).toBe(true);
  });
});

describe('runtime fixtures', () => {
  it('has no fetch implementation, so adapters cannot reach the network', () => {
    expect(createRuntime().fetchImpl).toBeUndefined();
  });
});
