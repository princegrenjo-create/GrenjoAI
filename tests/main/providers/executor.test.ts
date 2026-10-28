import { describe, expect, it } from 'vitest';
import { createDeepSeekAdapter } from '@main/providers/deepseek';
import { runBuffered, runChat } from '@main/providers/executor';
import type { ChatStreamChunk } from '@shared/provider-contract';
import { createRequest, createRuntime, fakeFetch, jsonResponse, streamResponse } from './fake-http';

const adapter = createDeepSeekAdapter();

const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('runChat', () => {
  it('adapts parser output onto ChatStreamChunk hooks and calls onFinish once', async () => {
    const fake = fakeFetch(() => streamResponse([SSE]));
    const chunks: ChatStreamChunk[] = [];
    const finishes: Array<string | null> = [];

    const result = await runChat(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest(),
      {
        onChunk: (chunk) => chunks.push(chunk),
        onFinish: (reason) => finishes.push(reason),
      },
      { retryBackoffMs: 0 },
    );

    expect(result.text).toBe('Hi');
    // The finish chunk is emitted once the run completes, so it follows the
    // usage chunk that arrived during the stream.
    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'usage', 'finish']);
    expect(finishes).toEqual(['stop']);
  });

  it('calls onFinish with null when the provider reported no reason', async () => {
    const fake = fakeFetch(() => streamResponse(['data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n']));
    const finishes: Array<string | null> = [];

    const result = await runChat(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest(),
      { onFinish: (reason) => finishes.push(reason) },
      { retryBackoffMs: 0 },
    );

    expect(result.finishReason).toBeNull();
    expect(finishes).toEqual([null]);
  });

  it('throws the mapped AppError for a rejected key', async () => {
    const fake = fakeFetch(() => jsonResponse(401, '{"error":{"message":"bad key"}}'));

    await expect(
      runChat(
        createRuntime({ fetchImpl: fake.fetchImpl }),
        adapter,
        createRequest(),
        {},
        { retryBackoffMs: 0 },
      ),
    ).rejects.toMatchObject({ shape: { code: 'invalid_key' } });
  });
});

describe('runBuffered', () => {
  it('returns the buffered completion and forces the non-streaming body', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'buffered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const fake = fakeFetch(() => jsonResponse(200, body));

    const result = await runBuffered(
      createRuntime({ fetchImpl: fake.fetchImpl }),
      adapter,
      createRequest({ stream: true }),
      { retryBackoffMs: 0 },
    );

    expect(result).toEqual({
      text: 'buffered',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    });
    const sentBody = JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
    expect(sentBody.stream).toBe(false);
  });
});
