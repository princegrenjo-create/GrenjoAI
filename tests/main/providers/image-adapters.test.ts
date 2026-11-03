/**
 * The two image adapters, against recorded request/response shapes.
 *
 * Offline by design: every case here is a fixture, so the request body and the
 * parser are proven without a key or a network. Whether a live provider accepts
 * these bodies is a separate, `UNAVAILABLE` check until a key exists — the same
 * rule the chat adapters follow.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRequestSpec, ProviderTransport, TransportResponse } from '@shared/provider-contract';
import type { MediaJobOutcome } from '@shared/media-job';
import {
  buildOpenAiImageBody,
  createOpenAiImageAdapter,
  parseOpenAiImageResponse,
} from '@main/providers/openaiImages';
import {
  buildGeminiImageBody,
  createGeminiImageAdapter,
  parseGeminiImageResponse,
} from '@main/providers/geminiImages';
import { mediaErrorFromResponse, parseErrorBody } from '@main/providers/media-adapter';

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');

interface FakeTransport extends ProviderTransport {
  sent: HttpRequestSpec[];
  run: ProviderTransport['run'];
}

function fakeTransport(response: TransportResponse): FakeTransport {
  const sent: HttpRequestSpec[] = [];
  return {
    sent,
    async send(spec) {
      sent.push(spec);
      return response;
    },
    async run() {
      throw new Error('run is not used by a media adapter');
    },
  };
}

const submitInput = {
  task: 'image' as const,
  modelId: 'gpt-image-2.5-sunburst',
  prompt: 'A heron at dawn',
  negativePrompt: null,
  params: {},
};

describe('OpenAI images — request', () => {
  it('sends only documented fields', () => {
    const body = buildOpenAiImageBody({
      ...submitInput,
      params: { n: 3, size: '1024x1024', quality: 'high', output_format: 'webp', background: 'transparent' },
    });
    expect(body).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'A heron at dawn',
      n: 3,
      size: '1024x1024',
      quality: 'high',
      output_format: 'webp',
      background: 'transparent',
      response_format: 'b64_json',
    });
  });

  it('never sends a parameter the API does not have', () => {
    const body = buildOpenAiImageBody({
      ...submitInput,
      params: { negative_prompt: 'blurry', seed: 7, aspect_ratio: '16:9', steps: 30 },
    });
    // These three belong to other providers. Sending them would be ignored at
    // best and rejected at worst; the UI does not offer them for this model.
    expect(body).not.toHaveProperty('negative_prompt');
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('steps');
  });

  it('clamps the count and the compression to the documented ranges', () => {
    expect(buildOpenAiImageBody({ ...submitInput, params: { n: 99 } }).n).toBe(10);
    expect(buildOpenAiImageBody({ ...submitInput, params: { n: 0 } }).n).toBe(1);
    expect(
      buildOpenAiImageBody({ ...submitInput, params: { output_compression: 150 } }).output_compression,
    ).toBe(100);
  });

  it('switches to the edits endpoint with reference images and a mask', async () => {
    const transport = fakeTransport({
      status: 200,
      body: JSON.stringify({ created: 1, data: [{ b64_json: PNG_BASE64 }], size: '1024x1024' }),
      headers: {},
    });
    const adapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport,
    });

    const outcome = await adapter.submit({
      ...submitInput,
      references: [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }],
      mask: { bytes: new Uint8Array([4, 5, 6]), mime: 'image/png' },
    });

    expect(transport.sent[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    const body = JSON.parse(transport.sent[0]?.body ?? '{}') as Record<string, unknown>;
    const images = body.images as Array<{ image_url: string }>;
    expect(images).toHaveLength(1);
    expect(images[0]?.image_url.startsWith('data:image/png;base64,')).toBe(true);
    expect(body.mask).toBeDefined();
    expect(outcome.kind).toBe('done');
  });

  it('uses the generations endpoint and the header, never a key in the URL', async () => {
    const transport = fakeTransport({
      status: 200,
      body: JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }),
      headers: {},
    });
    const adapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport,
    });
    await adapter.submit(submitInput);

    const spec = transport.sent[0];
    expect(spec?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(spec?.headers.Authorization).toBe('Bearer sk-test');
    expect(spec?.url).not.toContain('sk-test');
  });

  it('refuses to call the provider at all without a key', async () => {
    const transport = fakeTransport({ status: 200, body: '{}', headers: {} });
    const adapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => '',
      transport,
    });
    const outcome = await adapter.submit(submitInput);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'missing_key', retryable: false } });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('OpenAI images — response', () => {
  it('decodes every returned image and reads the size', () => {
    const outcome = parseOpenAiImageResponse(
      JSON.stringify({
        created: 1,
        output_format: 'webp',
        size: '1536x1024',
        data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
      }),
    );
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.outputs).toHaveLength(2);
    expect(outcome.outputs[0]?.mime).toBe('image/webp');
    expect(outcome.outputs[0]?.width).toBe(1536);
    expect(outcome.outputs[0]?.height).toBe(1024);
    expect(outcome.outputs[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('treats a success with no decodable image as a failure, not an empty success', () => {
    const outcome = parseOpenAiImageResponse(JSON.stringify({ created: 1, data: [] }));
    expect(outcome.kind).toBe('failed');
  });

  it('maps a rejected key and a rate limit differently', async () => {
    const keyTransport = fakeTransport({ status: 401, body: '{"error":{"message":"bad key"}}', headers: {} });
    const keyAdapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport: keyTransport,
    });
    const keyOutcome = await keyAdapter.submit(submitInput);
    expect(keyOutcome).toMatchObject({ kind: 'failed', error: { code: 'invalid_key', retryable: false } });

    const rateTransport = fakeTransport({ status: 429, body: '{}', headers: {} });
    const rateAdapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport: rateTransport,
    });
    const rateOutcome = await rateAdapter.submit(submitInput);
    expect(rateOutcome).toMatchObject({ kind: 'failed', error: { code: 'rate_limited', retryable: true } });
  });

  it('recognises a moderation refusal so the engine never retries it', async () => {
    const transport = fakeTransport({
      status: 400,
      body: JSON.stringify({ error: { code: 'moderation_blocked', message: 'rejected by safety system' } }),
      headers: {},
    });
    const adapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport,
    });
    const outcome = await adapter.submit(submitInput);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'moderation_blocked', retryable: false } });
  });
});

describe('Gemini images — request', () => {
  it('builds the Interactions body, not a chat body', () => {
    const body = buildGeminiImageBody({
      ...submitInput,
      modelId: 'gemini-nano-banana-2.1',
      params: { aspect_ratio: '16:9', image_size: '2K' },
      references: [{ bytes: new Uint8Array([9, 9]), mime: 'image/jpeg' }],
    }) as {
      model: string;
      input: Array<Record<string, unknown>>;
      response_format: Array<Record<string, unknown>>;
    };

    expect(body.model).toBe('gemini-nano-banana-2.1');
    expect(body.input[0]).toEqual({ type: 'text', text: 'A heron at dawn' });
    expect(body.input[1]).toMatchObject({ type: 'image', mime_type: 'image/jpeg' });
    // Raw base64, not a data URL: the block schema says `data`.
    expect(String(body.input[1]?.data)).not.toContain('data:');
    expect(body.response_format[0]).toMatchObject({ type: 'image', aspect_ratio: '16:9', image_size: '2K' });
    // The chat shape must not leak in.
    expect(body).not.toHaveProperty('contents');
    expect(body).not.toHaveProperty('generationConfig');
  });

  it('drops an image size the API does not document', () => {
    const body = buildGeminiImageBody({ ...submitInput, params: { image_size: '8K' } }) as {
      response_format: Array<Record<string, unknown>>;
    };
    expect(body.response_format[0]).not.toHaveProperty('image_size');
  });

  it('puts the key in the header and never in the URL', async () => {
    const transport = fakeTransport({
      status: 200,
      body: JSON.stringify({
        id: 'v1_abc',
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'image', mime_type: 'image/png', data: PNG_BASE64 }],
          },
        ],
      }),
      headers: {},
    });
    const adapter = createGeminiImageAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: async () => 'AIza-test',
      transport,
    });
    const outcome = await adapter.submit(submitInput);

    const spec = transport.sent[0];
    expect(spec?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(spec?.headers['x-goog-api-key']).toBe('AIza-test');
    expect(spec?.url).not.toContain('AIza-test');
    expect(spec?.url).not.toContain('key=');
    expect(outcome.kind).toBe('done');
  });
});

describe('Gemini images — response', () => {
  it('walks model_output steps and ignores thinking images', () => {
    const outcome = parseGeminiImageResponse(
      JSON.stringify({
        id: 'v1_xyz',
        status: 'completed',
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
          { type: 'thought', content: [{ type: 'image', data: PNG_BASE64 }] },
          { type: 'model_output', content: [{ type: 'text', text: 'here' }] },
          {
            type: 'model_output',
            content: [{ type: 'image', mime_type: 'image/webp', data: PNG_BASE64 }],
          },
        ],
      }),
    );

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    // One image: the thought step's interim image is not the result.
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.outputs[0]?.mime).toBe('image/webp');
    expect(outcome.providerJobId).toBe('v1_xyz');
  });

  it('fails when the reply has steps but no image block', () => {
    const outcome = parseGeminiImageResponse(
      JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no image' }] }] }),
    );
    expect(outcome.kind).toBe('failed');
  });

  it('refuses to call the provider without a key', async () => {
    const transport = fakeTransport({ status: 200, body: '{}', headers: {} });
    const adapter = createGeminiImageAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: async () => '',
      transport,
    });
    const outcome = await adapter.submit(submitInput);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'missing_key' } });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('shared media error mapping', () => {
  it('separates a refusal that must not be retried from a failure that should', () => {
    expect(mediaErrorFromResponse('X', 400, '{"error":{"code":"moderation_blocked"}}')).toMatchObject({
      code: 'moderation_blocked',
      retryable: false,
    });
    expect(mediaErrorFromResponse('X', 500, '')).toMatchObject({ code: 'provider_error', retryable: true });
    expect(mediaErrorFromResponse('X', 429, '')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(mediaErrorFromResponse('X', 403, '')).toMatchObject({ code: 'invalid_key', retryable: false });
    expect(mediaErrorFromResponse('X', 413, '')).toMatchObject({ code: 'bad_request', retryable: false });
  });

  it('reads a nested, a flat and a non-JSON error body', () => {
    expect(parseErrorBody('{"error":{"message":"nested"}}')).toEqual({ message: 'nested', code: undefined });
    expect(parseErrorBody('{"message":"flat"}')).toEqual({ message: 'flat', code: undefined });
    expect(parseErrorBody('<html>gateway</html>').message).toContain('gateway');
    expect(parseErrorBody('   ')).toEqual({});
  });

  it('marks a job-only outcome type as unreachable for a synchronous adapter', async () => {
    const adapter = createOpenAiImageAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: async () => 'sk-test',
      transport: fakeTransport({ status: 200, body: '{}', headers: {} }),
    });
    const polled: MediaJobOutcome = await adapter.poll({
      task: 'image',
      modelId: 'm',
      remoteId: 'r',
      pollUrl: null,
    });
    expect(polled.kind).toBe('failed');
  });
});
