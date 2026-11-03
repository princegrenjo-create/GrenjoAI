import { describe, expect, it } from 'vitest';
import { createDeepSeekAdapter } from '@main/providers/deepseek';
import {
  bodyOf,
  createRequest,
  createRuntime,
  drainParser,
  finishReasonOf,
  headerOf,
  reasoningOf,
  sliceChunks,
  textOf,
} from './fake-http';

const adapter = createDeepSeekAdapter();
const runtime = createRuntime();

const SYSTEM_MESSAGES = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
  { role: 'user', content: 'Explain SSE.' },
];

function errorBody(message: string): string {
  return JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } });
}

describe('DeepSeek request shape', () => {
  it('builds POST /chat/completions with a Bearer header and the OpenAI body', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());

    expect(spec.url).toBe('https://api.example.test/v1/chat/completions');
    expect(spec.method).toBe('POST');
    expect(headerOf(spec, 'content-type')).toBe('application/json');
    expect(headerOf(spec, 'authorization')).toBe('Bearer sk-test-KEY-0123456789abcdef');
    expect(headerOf(spec, 'x-api-key')).toBeNull();

    expect(bodyOf(spec)).toEqual({
      model: 'test-model',
      messages: SYSTEM_MESSAGES,
      stream: true,
      temperature: 0.4,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      max_tokens: 256,
      stop: ['END'],
      stream_options: { include_usage: true },
    });
  });

  it('omits stream_options when not streaming', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ stream: false }));
    expect(bodyOf(spec)).toEqual({
      model: 'test-model',
      messages: SYSTEM_MESSAGES,
      stream: false,
      temperature: 0.4,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      max_tokens: 256,
      stop: ['END'],
    });
  });

  it('never forwards seed, top-k, weirdness or reasoning effort', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as Record<string, unknown>;
    expect(body.seed).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.weirdness).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('forwards only the parameters the caller supplied', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ params: {}, system: null }));
    expect(bodyOf(spec)).toEqual({
      model: 'test-model',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Explain SSE.' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('omits an empty system prompt instead of sending a blank system message', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ params: {}, system: '   ' }));
    const body = bodyOf(spec) as { messages: Array<{ role: string }> };
    expect(body.messages[0]?.role).toBe('user');
  });

  it('refuses to build a request with no credential', () => {
    let caught: unknown;
    try {
      adapter.buildChatRequest(createRuntime({ apiKey: '' }), createRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ shape: { code: 'missing_key' } });
  });
});

describe('DeepSeek response parsing', () => {
  it('parses a buffered completion', () => {
    const parser = adapter.createResponseParser(false);
    const chunks = drainParser(parser, [
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'A streamed answer.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    ]);

    expect(textOf(chunks)).toBe('A streamed answer.');
    expect(finishReasonOf(chunks)).toBe('stop');
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } },
    ]);
  });

  it('parses streamed deltas, reasoning content, usage and finish', () => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('Hello');
    expect(reasoningOf(chunks)).toBe('thinking');
    expect(finishReasonOf(chunks)).toBe('stop');
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toHaveLength(1);
  });

  it('produces the same chunks when the body is delivered one byte at a time', () => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const whole = drainParser(adapter.createResponseParser(true), [body]);
    const byteWise = drainParser(adapter.createResponseParser(true), sliceChunks(body, 1));
    expect(byteWise).toEqual(whole);
    expect(textOf(whole)).toBe('Hello');
    expect(finishReasonOf(whole)).toBe('length');
  });

  it('stops at [DONE] and ignores frames after it', () => {
    const body = ['data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}', '', 'data: [DONE]', '', 'data: {"choices":[{"index":0,"delta":{"content":"ignored"}}]}', '', ''].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('ok');
  });

  it('skips a malformed frame without throwing', () => {
    const body = ['data: {not json', '', 'data: {"choices":[{"index":0,"delta":{"content":"still here"}}]}', '', 'data: [DONE]', '', ''].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('still here');
  });
});

describe('DeepSeek discovery', () => {
  it('builds GET /models', () => {
    const spec = adapter.buildListModelsRequest(runtime);
    expect(spec).not.toBeNull();
    if (!spec) throw new Error('expected a model-list request');
    expect(spec.url).toBe('https://api.example.test/v1/models');
    expect(spec.method).toBe('GET');
    expect(headerOf(spec, 'authorization')).toBe('Bearer sk-test-KEY-0123456789abcdef');
    expect(adapter.buildTestRequest(runtime).url).toBe('https://api.example.test/v1/models');
  });

  it('parses the {data:[...]} list, applies hints and keeps a non-chat model as unclassified', () => {
    const body = JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model' },
        { id: 'text-embedding-3-small', object: 'model' },
      ],
    });

    const { models, error } = adapter.parseListModels(200, body);
    expect(error).toBeNull();
    // The embedding model is kept, not deleted: deleting is why an image model
    // could never appear in the picker. It is listed with nothing assumed.
    expect(models.map((model) => model.modelId)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'text-embedding-3-small',
    ]);
    const unclassified = models[2];
    expect(Object.values(unclassified?.capabilities ?? {})).not.toContain(true);
    expect(unclassified?.supportedParams).toEqual([]);

    const chat = models[0];
    expect(chat?.displayName).toBe('DeepSeek Chat');
    expect(chat?.capabilities).toEqual({
      chat: true,
      streaming: true,
      imageInput: false,
      toolCalling: true,
      imageOutput: false,
      imageEditing: false,
      videoInput: false,
      videoOutput: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
    });
    expect(chat?.limits.contextWindow).toBe(128000);
    expect(chat?.weirdnessSupported).toBe(false);
    expect(chat?.description).toContain('not verified with the provider');
  });

  it('reports a connection-test success with the model count', () => {
    const result = adapter.parseTestResponse(
      200,
      JSON.stringify({ data: [{ id: 'deepseek-chat' }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.modelsFound).toBe(1);
    expect(result.error).toBeNull();
  });

  it('reports a connection-test failure with the mapped error', () => {
    const result = adapter.parseTestResponse(401, errorBody('Authentication Fails'));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(result.modelsFound).toBeNull();
  });

  it('maps a discovery 404 to model_not_found', () => {
    const { models, error } = adapter.parseListModels(404, errorBody('Not Found'));
    expect(models).toEqual([]);
    expect(error?.code).toBe('model_not_found');
  });
});

describe('DeepSeek error mapping', () => {
  it('maps 401 to invalid_key', () => {
    expect(adapter.parseError(401, errorBody('bad key'), 'p1')).toMatchObject({
      code: 'invalid_key',
      retryable: false,
      status: 401,
    });
  });

  it('maps 404 to model_not_found', () => {
    expect(adapter.parseError(404, errorBody('no such model'), 'p1')).toMatchObject({
      code: 'model_not_found',
      retryable: false,
    });
  });

  it('maps 429 to retryable rate_limited', () => {
    expect(adapter.parseError(429, errorBody('slow down'), 'p1')).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('maps 500 to retryable provider_error', () => {
    expect(adapter.parseError(500, '<html>oops</html>', 'p1')).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });

  it('maps 400 to bad_request', () => {
    expect(adapter.parseError(400, errorBody('Request validation failed'), 'p1')).toMatchObject({
      code: 'bad_request',
      retryable: false,
    });
  });

  it('maps an over-long conversation to context_length', () => {
    expect(
      adapter.parseError(400, errorBody('This model\'s maximum context length is 64000 tokens'), 'p1'),
    ).toMatchObject({ code: 'context_length', retryable: false });
  });

  it('does not reclassify a 500 that merely mentions context as a client error', () => {
    expect(
      adapter.parseError(500, errorBody('context length service unavailable'), 'p1'),
    ).toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('redacts a credential echoed in the provider message', () => {
    const shape = adapter.parseError(
      401,
      errorBody('Incorrect API key provided: sk-test-KEY-0123456789abcdef'),
      'p1',
    );
    expect(shape.message).not.toContain('sk-test-KEY-0123456789abcdef');
  });

  it('marks an error object inside a 200 body as a failed finish for the transport', () => {
    const chunks = drainParser(adapter.createResponseParser(false), [errorBody('boom')]);
    expect(chunks).toEqual([{ type: 'finish', reason: 'error' }]);
  });
});
