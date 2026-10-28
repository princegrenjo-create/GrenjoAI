import { describe, expect, it } from 'vitest';
import { ANTHROPIC_API_VERSION, createAnthropicAdapter } from '@ai/providers/anthropic';
import {
  TEST_ANTHROPIC_KEY,
  bodyOf,
  createRequest,
  createRuntime,
  drainParser,
  finishReasonOf,
  headerOf,
  sliceChunks,
  textOf,
} from './fake-http';

const adapter = createAnthropicAdapter();
const runtime = createRuntime({
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: TEST_ANTHROPIC_KEY,
});

const TURNS = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
  { role: 'user', content: 'Explain SSE.' },
];

describe('Anthropic request shape', () => {
  it('builds POST /messages with x-api-key and anthropic-version, no Bearer header', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());
    expect(spec.url).toBe('https://api.anthropic.com/v1/messages');
    expect(spec.method).toBe('POST');
    expect(headerOf(spec, 'x-api-key')).toBe(TEST_ANTHROPIC_KEY);
    expect(headerOf(spec, 'anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    expect(headerOf(spec, 'content-type')).toBe('application/json');
    expect(headerOf(spec, 'authorization')).toBeNull();
    expect(spec.url).not.toContain(TEST_ANTHROPIC_KEY);
  });

  it('sends the system prompt at the top level, not as a message', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system).toBe('You are terse.');
    expect(body.messages).toEqual(TURNS);
    expect(body.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('maps the full parameter set onto the Messages API fields', () => {
    expect(bodyOf(adapter.buildChatRequest(runtime, createRequest()))).toEqual({
      model: 'test-model',
      max_tokens: 256,
      messages: TURNS,
      stream: true,
      system: 'You are terse.',
      temperature: 0.4,
      top_p: 0.9,
      top_k: 7,
      stop_sequences: ['END'],
    });
  });

  it('always sends max_tokens, using the app default when the caller supplied none', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ params: {}, system: null }));
    const body = bodyOf(spec) as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual(TURNS);
    expect(body.system).toBeUndefined();
    expect(body).toEqual({ model: 'test-model', max_tokens: 2048, messages: TURNS, stream: true });
  });

  it('never forwards frequency/presence penalties, seed or weirdness', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as Record<string, unknown>;
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.weirdness).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('uses GET /models with the same auth headers for discovery', () => {
    const spec = adapter.buildListModelsRequest(runtime);
    expect(spec).not.toBeNull();
    if (!spec) throw new Error('expected a model-list request');
    expect(spec.url).toBe('https://api.anthropic.com/v1/models');
    expect(spec.method).toBe('GET');
    expect(headerOf(spec, 'x-api-key')).toBe(TEST_ANTHROPIC_KEY);
    expect(headerOf(spec, 'anthropic-version')).toBe(ANTHROPIC_API_VERSION);
  });
});

describe('Anthropic response parsing', () => {
  it('parses a buffered message with typed content blocks', () => {
    const body = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'weighing options' },
        { type: 'text', text: 'The answer.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    const chunks = drainParser(adapter.createResponseParser(false), [body]);
    expect(textOf(chunks)).toBe('The answer.');
    expect(finishReasonOf(chunks)).toBe('stop');
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 5 } },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'weighing options' },
    ]);
  });

  it('parses named stream events into text, usage and a normalised finish', () => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","usage":{"input_tokens":12,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('Hello');
    expect(finishReasonOf(chunks)).toBe('stop');

    const usage = chunks.filter((chunk) => chunk.type === 'usage');
    expect(usage).toEqual([
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 1 } },
      { type: 'usage', usage: { completionTokens: 5 } },
    ]);
  });

  it('parses MAX_TOKENS as length and emits one finish chunk at message_stop', () => {
    const body = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(finishReasonOf(chunks)).toBe('length');
    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1);
  });

  it('parses identically when fed one byte at a time', () => {
    const body = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    const whole = drainParser(adapter.createResponseParser(true), [body]);
    const byteWise = drainParser(adapter.createResponseParser(true), sliceChunks(body, 1));
    expect(byteWise).toEqual(whole);
    expect(finishReasonOf(whole)).toBe('stop');
  });

  it('marks an in-band error event as a failed finish for the transport', () => {
    const body = [
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      '',
      '',
    ].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(chunks).toEqual([{ type: 'finish', reason: 'error' }]);
  });
});

describe('Anthropic discovery', () => {
  it('parses {data:[...]} and applies catalog hints', () => {
    const result = adapter.parseListModels(
      200,
      JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-0', type: 'model', display_name: 'Claude Sonnet 4' },
          { id: 'claude-experimental-9', type: 'model' },
        ],
        has_more: false,
      }),
    );
    expect(result.error).toBeNull();
    expect(result.models.map((model) => model.modelId)).toEqual([
      'claude-sonnet-4-0',
      'claude-experimental-9',
    ]);
    expect(result.models[0]?.limits.contextWindow).toBe(200000);
    expect(result.models[0]?.capabilities.imageInput).toBe(true);
    expect(result.models[1]?.displayName).toBe('claude-experimental-9');
    expect(result.models[1]?.capabilities.imageInput).toBe(true);
  });

  it('reports a failed connection test', () => {
    const result = adapter.parseTestResponse(
      401,
      JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
  });
});

describe('Anthropic error mapping', () => {
  it('maps statuses through the shared vocabulary', () => {
    expect(adapter.parseError(401, '{}', 'p')).toMatchObject({ code: 'invalid_key', retryable: false });
    expect(adapter.parseError(404, '{}', 'p')).toMatchObject({ code: 'model_not_found' });
    expect(adapter.parseError(429, '{}', 'p')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(adapter.parseError(500, '{}', 'p')).toMatchObject({ code: 'provider_error', retryable: true });
    expect(adapter.parseError(400, '{"error":{"message":"bad request"}}', 'p')).toMatchObject({
      code: 'bad_request',
    });
  });

  it('maps a too-long prompt to context_length', () => {
    const body = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
    });
    expect(adapter.parseError(400, body, 'p')).toMatchObject({
      code: 'context_length',
      retryable: false,
    });
  });

  it('redacts an x-api-key echoed in the provider message', () => {
    const body = JSON.stringify({
      error: { type: 'authentication_error', message: `invalid x-api-key: ${TEST_ANTHROPIC_KEY}` },
    });
    const shape = adapter.parseError(401, body, 'p');
    expect(shape.message).not.toContain(TEST_ANTHROPIC_KEY);
  });
});
