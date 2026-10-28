import { describe, expect, it } from 'vitest';
import { createOpenAiCompatibleAdapter } from '@ai/providers/openaiCompatible';
import { bodyOf, createRequest, createRuntime, drainParser, headerOf, textOf } from './fake-http';

const adapter = createOpenAiCompatibleAdapter();
const runtime = createRuntime({ baseUrl: 'https://gateway.example.test/v1' });

describe('OpenAI-compatible request shape', () => {
  it('builds POST {base}/chat/completions with Bearer auth', () => {
    const spec = adapter.buildChatRequest(runtime, createRequest());
    expect(spec.url).toBe('https://gateway.example.test/v1/chat/completions');
    expect(headerOf(spec, 'authorization')).toBe('Bearer sk-test-KEY-0123456789abcdef');
  });

  it('forwards top_k and weirdness verbatim when the caller supplied them', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as Record<string, unknown>;
    expect(body.top_k).toBe(7);
    expect(body.weirdness).toBe(0.35);
    expect(body.seed).toBe(42);
    expect(body.top_p).toBe(0.9);
    // Provider-specific creativity is never silently mapped onto another knob.
    expect(body.temperature).toBe(0.4);
  });

  it('omits top_k and weirdness when the caller did not supply them', () => {
    const body = bodyOf(
      adapter.buildChatRequest(runtime, createRequest({ params: { temperature: 0.1 } })),
    ) as Record<string, unknown>;
    expect(body.top_k).toBeUndefined();
    expect(body.weirdness).toBeUndefined();
    expect(body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Explain SSE.' },
      ],
      stream: true,
      temperature: 0.1,
      stream_options: { include_usage: true },
    });
  });

  it('uses a model-level baseUrlOverride for chat requests only', () => {
    const override = createRequest({ baseUrlOverride: 'https://local.example.test:8080/v1' });
    const spec = adapter.buildChatRequest(runtime, override);
    expect(spec.url).toBe('https://local.example.test:8080/v1/chat/completions');

    const discovery = adapter.buildListModelsRequest(runtime);
    expect(discovery?.url).toBe('https://gateway.example.test/v1/models');
  });

  it('falls back to the provider base URL when the override is empty or null', () => {
    expect(adapter.buildChatRequest(runtime, createRequest({ baseUrlOverride: null })).url).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
    expect(adapter.buildChatRequest(runtime, createRequest({ baseUrlOverride: '  ' })).url).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
  });

  it('does not forward reasoning effort, which the compatible profile does not declare', () => {
    const body = bodyOf(adapter.buildChatRequest(runtime, createRequest())) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('OpenAI-compatible discovery', () => {
  it('parses a gateway model list and keeps unknown ids as heuristics', () => {
    const result = adapter.parseListModels(
      200,
      JSON.stringify({ object: 'list', data: [{ id: 'acme-vision-7b' }, { id: 'acme-text-7b' }] }),
    );
    expect(result.error).toBeNull();
    expect(result.models.map((model) => model.modelId)).toEqual(['acme-vision-7b', 'acme-text-7b']);

    const vision = result.models[0];
    expect(vision?.capabilities.imageInput).toBe(true);
    expect(vision?.capabilities.toolCalling).toBe(false);
    expect(vision?.limits).toEqual({});
    // A compatible endpoint only gets weirdness when the model declares it.
    expect(vision?.weirdnessSupported).toBe(false);
    expect(vision?.supportedParams).not.toContain('weirdness');
    expect(vision?.supportedParams).toContain('topK');

    expect(result.models[1]?.capabilities.imageInput).toBe(false);
  });

  it('reports a gateway that does not implement /models', () => {
    const result = adapter.parseListModels(404, '<html>Not Found</html>');
    expect(result.models).toEqual([]);
    expect(result.error?.code).toBe('model_not_found');
  });

  it('parses a buffered completion from a gateway', () => {
    const chunks = drainParser(adapter.createResponseParser(false), [
      JSON.stringify({ choices: [{ message: { content: 'gateway answer' }, finish_reason: 'stop' }] }),
    ]);
    expect(textOf(chunks)).toBe('gateway answer');
  });
});
