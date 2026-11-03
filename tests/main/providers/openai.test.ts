import { describe, expect, it } from 'vitest';
import { createOpenAiAdapter } from '@main/providers/openai';
import {
  bodyOf,
  createRequest,
  createRuntime,
  drainParser,
  finishReasonOf,
  headerOf,
  textOf,
} from './fake-http';

const adapter = createOpenAiAdapter();
const runtime = createRuntime();

const MESSAGES = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
  { role: 'user', content: 'Explain SSE.' },
];

describe('OpenAI request shape', () => {
  it('builds POST /chat/completions with Bearer auth and the OpenAI body', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());
    expect(spec.url).toBe('https://api.example.test/v1/chat/completions');
    expect(spec.method).toBe('POST');
    expect(headerOf(spec, 'authorization')).toBe('Bearer sk-test-KEY-0123456789abcdef');
    expect(bodyOf(spec)).toEqual({
      model: 'test-model',
      messages: MESSAGES,
      stream: true,
      temperature: 0.4,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      max_tokens: 256,
      stop: ['END'],
      seed: 42,
      reasoning_effort: 'low',
      stream_options: { include_usage: true },
    });
  });

  it('does not forward top-k, weirdness or an absent seed/reasoning effort', () => {
    const request = createRequest({ params: { temperature: 0.2 } });
    const spec = adapter.buildChatRequest(runtime, request);
    const body = bodyOf(spec) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'test-model',
      messages: MESSAGES,
      stream: true,
      temperature: 0.2,
      stream_options: { include_usage: true },
    });
    expect(body.top_k).toBeUndefined();
    expect(body.weirdness).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('uses /models for discovery and the probe', () => {
    expect(adapter.buildListModelsRequest(runtime)?.url).toBe('https://api.example.test/v1/models');
    expect(adapter.buildTestRequest(runtime).url).toBe('https://api.example.test/v1/models');
  });

  it('refuses an empty key', () => {
    let caught: unknown;
    try {
      adapter.buildChatRequest(createRuntime({ apiKey: '' }), createRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ shape: { code: 'missing_key' } });
  });
});

describe('OpenAI response parsing', () => {
  it('parses a buffered response and keeps the model finish reason', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'From the buffered body.' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
    const chunks = drainParser(adapter.createResponseParser(false), [body]);
    expect(textOf(chunks)).toBe('From the buffered body.');
    expect(finishReasonOf(chunks)).toBe('length');
  });

  it('parses streamed content arrays returned by some gateways', () => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"part one "}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"part two"}]}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('part one part two');
  });

  it('turns a content_filter finish into the app vocabulary', () => {
    const body = ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}', '', 'data: [DONE]', '', ''].join('\n');
    expect(finishReasonOf(drainParser(adapter.createResponseParser(true), [body]))).toBe('content_filter');
  });
});

describe('OpenAI discovery and errors', () => {
  it('parses {data:[...]}, inventing no capability for an unclassified id', () => {
    const result = adapter.parseListModels(
      200,
      JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }, { id: 'gpt-4o-audio-preview' }] }),
    );
    expect(result.error).toBeNull();
    // The audio-preview id is kept and marked unclassified rather than deleted,
    // so a model that exists is never invisible to the user.
    expect(result.models.map((model) => model.modelId)).toEqual([
      'gpt-4o',
      'o3-mini',
      'gpt-4o-audio-preview',
    ]);
    expect(Object.values(result.models[2]?.capabilities ?? {})).not.toContain(true);

    const o3 = result.models[1];
    expect(o3?.capabilities.imageInput).toBe(false);
    expect(o3?.supportedParams).toEqual(['maxOutputTokens', 'reasoningEffort']);
  });

  it('maps statuses through the shared vocabulary', () => {
    expect(adapter.parseError(401, '{}', 'p')).toMatchObject({ code: 'invalid_key' });
    expect(adapter.parseError(429, '{}', 'p')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(adapter.parseError(503, '{}', 'p')).toMatchObject({ code: 'provider_error', retryable: true });
  });
});
