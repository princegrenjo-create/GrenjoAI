import { describe, expect, it } from 'vitest';
import { createGeminiAdapter } from '@main/providers/gemini';
import {
  TEST_GEMINI_KEY,
  bodyOf,
  createRequest,
  createRuntime,
  drainParser,
  finishReasonOf,
  headerOf,
  sliceChunks,
  textOf,
} from './fake-http';

const adapter = createGeminiAdapter();
const runtime = createRuntime({
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: TEST_GEMINI_KEY,
});

function geminiError(message: string, status: string, reason: string): string {
  return JSON.stringify({
    error: {
      code: 400,
      message,
      status,
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
    },
  });
}

describe('Gemini request shape', () => {
  it('builds the native streamGenerateContent URL with a header key', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());
    expect(spec.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse',
    );
    expect(spec.method).toBe('POST');
    expect(headerOf(spec, 'x-goog-api-key')).toBe(TEST_GEMINI_KEY);
    expect(headerOf(spec, 'authorization')).toBeNull();
    expect(spec.url).not.toContain(TEST_GEMINI_KEY);
    expect(spec.url).not.toContain('key=');
  });

  it('builds generateContent for a buffered request', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ stream: false }));
    expect(spec.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
    );
  });

  it('maps the body: systemInstruction, role "model" and generationConfig', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());
    expect(bodyOf(spec)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
        { role: 'user', parts: [{ text: 'Explain SSE.' }] },
      ],
      systemInstruction: { parts: [{ text: 'You are terse.' }] },
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        topK: 7,
        maxOutputTokens: 256,
        stopSequences: ['END'],
        seed: 42,
      },
    });
  });

  it('omits systemInstruction and generationConfig when nothing was supplied', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest({ params: {}, system: null }));
    expect(bodyOf(spec)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
        { role: 'user', parts: [{ text: 'Explain SSE.' }] },
      ],
    });
  });

  it('never forwards frequency/presence penalties or weirdness', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.frequencyPenalty).toBeUndefined();
    expect(body.generationConfig.presencePenalty).toBeUndefined();
    expect(body.generationConfig.weirdness).toBeUndefined();
    expect(body.generationConfig.reasoningEffort).toBeUndefined();
  });

  it('uses /models for discovery', () => {
    const spec = adapter.buildListModelsRequest(runtime);
    expect(spec).not.toBeNull();
    if (!spec) throw new Error('expected a model-list request');
    expect(spec.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(headerOf(spec, 'x-goog-api-key')).toBe(TEST_GEMINI_KEY);
  });
});

describe('Gemini response parsing', () => {
  it('parses a buffered candidates response', () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello' }, { text: ' there.' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
    });
    const chunks = drainParser(adapter.createResponseParser(false), [body]);
    expect(textOf(chunks)).toBe('Hello there.');
    expect(finishReasonOf(chunks)).toBe('stop');
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } },
    ]);
  });

  it('parses streamed SSE chunks and the MAX_TOKENS finish', () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"totalTokenCount":11}}',
      '',
      '',
    ].join('\n');

    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(textOf(chunks)).toBe('Hello');
    expect(finishReasonOf(chunks)).toBe('length');
  });

  it('parses the same chunks one byte at a time', () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"b"}]},"finishReason":"STOP"}]}',
      '',
      '',
    ].join('\n');
    const whole = drainParser(adapter.createResponseParser(true), [body]);
    const byteWise = drainParser(adapter.createResponseParser(true), sliceChunks(body, 1));
    expect(byteWise).toEqual(whole);
    expect(textOf(whole)).toBe('ab');
  });

  it('maps a blocked prompt to content_filter', () => {
    const body = JSON.stringify({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: [],
    });
    const chunks = drainParser(adapter.createResponseParser(false), [body]);
    expect(finishReasonOf(chunks)).toBe('content_filter');
  });

  it('routes a thinking part to reasoning, not text', () => {    const body = JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'thinking hard', thought: true },
              { text: 'answer' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    const chunks = drainParser(adapter.createResponseParser(false), [body]);
    expect(textOf(chunks)).toBe('answer');
    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning');
    expect(reasoning).toEqual([{ type: 'reasoning', text: 'thinking hard' }]);
  });

  it('marks an in-band error payload as a failed finish for the transport', () => {
    const body = [
      'data: {"error":{"code":500,"message":"Internal error","status":"INTERNAL"}}',
      '',
      '',
    ].join('\n');
    const chunks = drainParser(adapter.createResponseParser(true), [body]);
    expect(chunks).toEqual([{ type: 'finish', reason: 'error' }]);
  });
});

describe('Gemini discovery', () => {
  const LIST = JSON.stringify({
    models: [
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        description: 'Flagship model.',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      },
      {
        name: 'models/gemini-embedding-001',
        displayName: 'Embedding',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  });

  it('keeps every model, strips the models/ prefix, and marks a non-chat one unclassified', () => {
    const { models, error } = adapter.parseListModels(200, LIST);
    expect(error).toBeNull();
    // Gemini states the supported methods per model, which is the one place a
    // provider tells us a model cannot chat. That is a classification, not a
    // reason to hide the model.
    expect(models.map((model) => model.modelId)).toEqual(['gemini-2.5-pro', 'gemini-embedding-001']);
    const unclassified = models[1];
    expect(Object.values(unclassified?.capabilities ?? {})).not.toContain(true);
  });

  it('uses provider token limits and catalog capabilities', () => {
    const model = adapter.parseListModels(200, LIST).models[0];
    expect(model?.displayName).toBe('Gemini 2.5 Pro');
    expect(model?.limits).toEqual({ contextWindow: 1048576, maxOutputTokens: 65536 });
    expect(model?.capabilities.imageInput).toBe(true);
    expect(model?.weirdnessSupported).toBe(false);
  });

  it('reports a failed connection test', () => {
    const result = adapter.parseTestResponse(403, geminiError('Permission denied', 'PERMISSION_DENIED', ''));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
  });
});

describe('Gemini error mapping', () => {
  it('maps an API_KEY_INVALID 400 to invalid_key, not bad_request', () => {
    const shape = adapter.parseError(
      400,
      geminiError('API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'),
      'p1',
    );
    expect(shape).toMatchObject({ code: 'invalid_key', retryable: false });
  });

  it('maps statuses through the shared vocabulary', () => {
    expect(adapter.parseError(401, '{}', 'p')).toMatchObject({ code: 'invalid_key' });
    expect(adapter.parseError(404, '{}', 'p')).toMatchObject({ code: 'model_not_found' });
    expect(adapter.parseError(429, '{}', 'p')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(adapter.parseError(500, '{}', 'p')).toMatchObject({ code: 'provider_error', retryable: true });
    expect(adapter.parseError(400, '{"error":{"message":"Bad parameter"}}', 'p')).toMatchObject({
      code: 'bad_request',
    });
  });

  it('redacts a key echoed back by the API', () => {
    const shape = adapter.parseError(400, geminiError(`API key not valid: ${TEST_GEMINI_KEY}`, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'p');
    expect(shape.message).not.toContain(TEST_GEMINI_KEY);
  });
});
