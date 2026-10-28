/**
 * Multimodal request construction and audio transcription, asserted against the
 * bytes each provider actually documents.
 *
 * The regression that matters most here is the *text-only* path: every stored
 * conversation is text, so a turn with a string content must still produce exactly
 * the body it produced before attachments existed.
 */
import { describe, expect, it } from 'vitest';
import { createRegistry } from '@ai/providers/registry';
import type {
  ChatCompletionRequest,
  ChatContentPart,
  ProviderRuntime,
} from '@core/provider-contract';

const runtime = (kind: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openai-compatible'): ProviderRuntime => ({
  providerId: `p-${kind}`,
  baseUrl:
    kind === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : kind === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : 'https://api.example.test/v1',
  apiKey: 'test-key-0123456789',
  timeoutMs: 30_000,
});

const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function request(content: string | ChatContentPart[]): ChatCompletionRequest {
  return {
    modelId: 'test-model',
    system: 'Be brief.',
    turns: [{ role: 'user', content }],
    params: { maxOutputTokens: 128 },
    stream: false,
  };
}

function bodyOf(spec: { body: string | null }): Record<string, unknown> {
  expect(spec.body).not.toBeNull();
  return JSON.parse(spec.body ?? '{}') as Record<string, unknown>;
}

describe('OpenAI-family image content', () => {
  for (const kind of ['openai', 'deepseek', 'openai-compatible'] as const) {
    it(`${kind}: keeps a text-only turn as a plain string`, () => {
      const adapter = createRegistry().get(kind);
      const spec = adapter.buildChatRequest(runtime(kind), request('hello'));
      const body = bodyOf(spec);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      expect(messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
    });

    it(`${kind}: sends an image as an image_url data URL`, () => {
      const adapter = createRegistry().get(kind);
      const spec = adapter.buildChatRequest(
        runtime(kind),
        request([
          { type: 'text', text: 'what is this?' },
          { type: 'image', mimeType: 'image/png', dataBase64: IMAGE_BASE64 },
        ]),
      );
      const body = bodyOf(spec);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      const last = messages.at(-1);
      expect(Array.isArray(last?.content)).toBe(true);
      const parts = last?.content as Array<Record<string, unknown>>;
      expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' });
      expect(parts[1]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${IMAGE_BASE64}`, detail: 'auto' },
      });
    });
  }
});

describe('Anthropic image content', () => {
  it('keeps a text-only turn as a plain string', () => {
    const spec = createRegistry().get('anthropic').buildChatRequest(runtime('anthropic'), request('hello'));
    const body = bodyOf(spec);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
  });

  it('sends an image as a base64 source block', () => {
    const spec = createRegistry().get('anthropic').buildChatRequest(
      runtime('anthropic'),
      request([
        { type: 'text', text: 'describe' },
        { type: 'image', mimeType: 'image/jpeg', dataBase64: IMAGE_BASE64 },
      ]),
    );
    const body = bodyOf(spec);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const blocks = messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'describe' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE_BASE64 },
    });
    // The system prompt is still a top-level field, not a message.
    expect(body.system).toBe('Be brief.');
  });

  it('never puts the API key in the URL', () => {
    const spec = createRegistry().get('anthropic').buildChatRequest(runtime('anthropic'), request('hi'));
    expect(spec.url).not.toContain('test-key');
    expect(spec.headers['x-api-key']).toBe('test-key-0123456789');
  });
});

describe('Gemini image content', () => {
  it('keeps a text-only turn as one text part', () => {
    const spec = createRegistry().get('gemini').buildChatRequest(runtime('gemini'), request('hello'));
    const body = bodyOf(spec);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
  });

  it('sends an image as inlineData', () => {
    const spec = createRegistry().get('gemini').buildChatRequest(
      runtime('gemini'),
      request([
        { type: 'text', text: 'describe' },
        { type: 'image', mimeType: 'image/webp', dataBase64: IMAGE_BASE64 },
      ]),
    );
    const body = bodyOf(spec);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents.at(-1)?.parts).toEqual([
      { text: 'describe' },
      { inlineData: { mimeType: 'image/webp', data: IMAGE_BASE64 } },
    ]);
  });

  it('keeps the assistant role mapped to `model`', () => {
    const adapter = createRegistry().get('gemini');
    const spec = adapter.buildChatRequest(runtime('gemini'), {
      ...request('follow-up'),
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'follow-up' },
      ],
    });
    const contents = bodyOf(spec).contents as Array<{ role: string }>;
    expect(contents.map((entry) => entry.role)).toEqual(['user', 'model', 'user']);
  });
});

describe('OpenAI transcription adapter', () => {
  const adapter = createRegistry().get('openai');
  const transcription = adapter.transcription;

  it('is offered by OpenAI only', () => {
    expect(transcription).toBeDefined();
    for (const kind of ['deepseek', 'anthropic', 'gemini', 'openai-compatible'] as const) {
      expect(createRegistry().get(kind).transcription).toBeUndefined();
    }
  });

  it('builds a multipart request with the model and the audio bytes', () => {
    expect(transcription).toBeDefined();
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const spec = transcription?.buildTranscriptionRequest(runtime('openai'), {
      audio,
      mimeType: 'audio/webm',
      filename: 'recording.webm',
      model: 'whisper-1',
    });
    expect(spec?.url).toBe('https://api.example.test/v1/audio/transcriptions');
    expect(spec?.method).toBe('POST');
    expect(spec?.headers.Authorization).toBe('Bearer test-key-0123456789');
    expect(spec?.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    // The key never appears in the URL or the body bytes.
    expect(spec?.url).not.toContain('test-key');
    expect(spec?.body).toBeNull();
    const bytes = spec?.bodyBytes;
    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = Buffer.from(bytes ?? new Uint8Array()).toString('latin1');
    expect(text).toContain('name="model"');
    expect(text).toContain('whisper-1');
    expect(text).toContain('name="file"; filename="recording.webm"');
    expect(text).toContain('Content-Type: audio/webm');
    expect(text).not.toContain('test-key');
    // The raw audio bytes are present verbatim, inside the file part.
    const raw = Buffer.from(bytes ?? new Uint8Array()).toString('latin1');
    expect(raw.includes(Buffer.from([1, 2, 3, 4, 5]).toString('latin1'))).toBe(true);
  });

  it('parses a successful transcript', () => {
    const parsed = transcription?.parseTranscriptionResponse(
      200,
      JSON.stringify({ text: '  hello there  ' }),
      'p-openai',
    );
    expect(parsed?.text).toBe('hello there');
    expect(parsed?.error).toBeNull();
  });

  it('reports an empty transcript instead of inventing one', () => {
    const parsed = transcription?.parseTranscriptionResponse(200, JSON.stringify({ text: '   ' }), 'p');
    expect(parsed?.text).toBeNull();
    expect(parsed?.error?.message).toMatch(/empty/i);
  });

  it('reports a response with no text field as an error', () => {
    const parsed = transcription?.parseTranscriptionResponse(200, '{"ok":true}', 'p');
    expect(parsed?.text).toBeNull();
    expect(parsed?.error?.code).toBe('provider_error');
  });

  it('maps an HTTP failure through the provider error mapping', () => {
    const parsed = transcription?.parseTranscriptionResponse(
      401,
      JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
      'p',
    );
    expect(parsed?.text).toBeNull();
    expect(parsed?.error?.code).toBe('invalid_key');
  });

  it('maps a non-JSON success body as an error rather than guessing', () => {
    const parsed = transcription?.parseTranscriptionResponse(200, 'not json', 'p');
    expect(parsed?.text).toBeNull();
    expect(parsed?.error?.code).toBe('provider_error');
  });

  it('refuses to build a request without a key', () => {
    expect(() =>
      transcription?.buildTranscriptionRequest(
        { ...runtime('openai'), apiKey: '   ' },
        { audio: new Uint8Array([1]), mimeType: 'audio/webm', filename: 'a.webm', model: 'whisper-1' },
      ),
    ).toThrowError(/missing_key/);
  });
});
