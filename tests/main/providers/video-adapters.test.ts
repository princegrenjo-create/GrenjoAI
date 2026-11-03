/**
 * The two video adapters, against recorded shapes.
 *
 * Video is where the job engine earns its keep: both providers are asynchronous,
 * and one of them hands back a signed URL that dies in ten minutes. Every test
 * here is a state transition — submitted, still working, ready, failed — rather
 * than a single request/response.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRequestSpec, ProviderTransport, TransportResponse } from '@shared/provider-contract';
import type { MediaJobOutcome } from '@shared/media-job';
import {
  buildGeminiVideoBody,
  createGeminiVideoAdapter,
  parseGeminiInteraction,
} from '@main/providers/geminiVideo';
import { buildBflVideoBody, createBflVideoAdapter, parseBflPollBody } from '@main/providers/bflVideo';
import { downloadBytes, isAllowedDownloadUrl } from '@main/providers/media-download';

const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]).toString('base64');

const submitInput = {
  task: 'video' as const,
  modelId: 'gemini-omni-1.1-flash',
  prompt: 'Slow pan over a harbour at dawn',
  negativePrompt: null,
  params: {},
};

interface QueuedTransport extends ProviderTransport {
  sent: HttpRequestSpec[];
  run: ProviderTransport['run'];
}

function queueTransport(responses: TransportResponse[]): QueuedTransport {
  const sent: HttpRequestSpec[] = [];
  return {
    sent,
    async send(spec) {
      sent.push(spec);
      const next = responses.shift();
      if (!next) throw new Error('no more queued responses');
      return next;
    },
    async run() {
      throw new Error('run is not used by a media adapter');
    },
  };
}

describe('Gemini video — asynchronous submission', () => {
  it('asks for a background interaction and returns the handle', async () => {
    const transport = queueTransport([
      { status: 200, body: JSON.stringify({ id: 'v1_abc', status: 'in_progress' }), headers: {} },
    ]);
    const adapter = createGeminiVideoAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: async () => 'AIza-test',
      transport,
    });

    const outcome = await adapter.submit(submitInput);
    expect(outcome).toMatchObject({ kind: 'pending', remoteId: 'v1_abc' });

    const body = JSON.parse(transport.sent[0]?.body ?? '{}') as Record<string, unknown>;
    // The whole point of background mode: the app is never blocked on a request
    // that takes minutes.
    expect(body.background).toBe(true);
    expect(body.response_format).toMatchObject({ type: 'video' });
  });

  it('never sends a duration, because the API does not document one', () => {
    const body = buildGeminiVideoBody({
      ...submitInput,
      params: { duration: 8, aspect_ratio: '16:9', resolution: '1080p' },
    }) as Record<string, unknown>;
    const format = body.response_format as Record<string, unknown>;
    expect(format).toMatchObject({ type: 'video', aspect_ratio: '16:9', resolution: '1080p' });
    expect(format).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('duration');
  });

  it('polls the interaction and returns the video once it is ready', async () => {
    const transport = queueTransport([
      { status: 200, body: JSON.stringify({ id: 'v1_abc', status: 'in_progress' }), headers: {} },
      {
        status: 200,
        body: JSON.stringify({
          id: 'v1_abc',
          status: 'completed',
          steps: [
            { type: 'model_output', content: [{ type: 'text', text: 'here' }] },
            { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: MP4 }] },
          ],
        }),
        headers: {},
      },
    ]);
    const adapter = createGeminiVideoAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: async () => 'AIza-test',
      transport,
    });

    expect((await adapter.submit(submitInput)).kind).toBe('pending');
    const outcome = await adapter.poll({ task: 'video', modelId: 'm', remoteId: 'v1_abc', pollUrl: null });

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.outputs[0]?.mime).toBe('video/mp4');
    expect(outcome.outputs[0]?.bytes.byteLength).toBeGreaterThan(0);
    expect(outcome.providerJobId).toBe('v1_abc');
    // The poll is a GET on the interaction, addressed by the handle.
    expect(transport.sent[1]?.method).toBe('GET');
    expect(transport.sent[1]?.url).toContain('interactions/v1_abc');
  });

  it('reports a provider-side failure and lets the engine decide about retrying', () => {
    const outcome = parseGeminiInteraction(
      JSON.stringify({ id: 'v1_abc', status: 'failed', error: { message: 'capacity' } }),
    );
    expect(outcome).toMatchObject({ kind: 'failed', error: { retryable: true } });
    if (outcome.kind === 'failed') expect(outcome.error.message).toContain('capacity');
  });

  it('is still working when the status is one it does not recognise', () => {
    // An unknown status is not a failure: the documentation does not enumerate
    // every intermediate state, and guessing "failed" would kill a live job.
    expect(parseGeminiInteraction(JSON.stringify({ id: 'v', status: 'queued' })).kind).toBe('pending');
  });

  it('refuses to call the provider without a key', async () => {
    const transport = queueTransport([]);
    const adapter = createGeminiVideoAdapter({
      baseUrl: 'https://x/v1beta',
      apiKey: async () => '',
      transport,
    });
    const outcome = await adapter.submit(submitInput);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'missing_key' } });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('Black Forest Labs — submit, poll, download', () => {
  it('uses x-key, not Bearer, and returns the polling handle', async () => {
    const transport = queueTransport([
      {
        status: 200,
        body: JSON.stringify({ id: 'bfl-1', polling_url: 'https://api.bfl.ai/v1/poll/bfl-1' }),
        headers: {},
      },
    ]);
    const adapter = createBflVideoAdapter({
      baseUrl: 'https://api.bfl.ai/v1',
      apiKey: async () => 'bfl-key',
      transport,
    });

    const outcome = await adapter.submit({ ...submitInput, modelId: 'flux-3-video' });
    expect(outcome).toMatchObject({
      kind: 'pending',
      remoteId: 'bfl-1',
      pollUrl: 'https://api.bfl.ai/v1/poll/bfl-1',
    });

    const spec = transport.sent[0];
    expect(spec?.headers['x-key']).toBe('bfl-key');
    expect(spec?.headers.Authorization).toBeUndefined();
    expect(spec?.url).toBe('https://api.bfl.ai/v1/flux-3-video');
    const body = JSON.parse(spec?.body ?? '{}') as Record<string, unknown>;
    expect(body.mode).toBe('t2v');
  });

  it('keeps polling on an intermediate status', async () => {
    const transport = queueTransport([
      { status: 200, body: JSON.stringify({ status: 'Processing' }), headers: {} },
    ]);
    const adapter = createBflVideoAdapter({ baseUrl: 'https://api.bfl.ai/v1', apiKey: async () => 'k', transport });
    const outcome = await adapter.poll({
      task: 'video',
      modelId: 'flux-3-video',
      remoteId: 'bfl-1',
      pollUrl: 'https://api.bfl.ai/v1/poll/bfl-1',
    });
    expect(outcome.kind).toBe('pending');
  });

  it('downloads the signed result immediately when the job is ready', async () => {
    const transport = queueTransport([
      {
        status: 200,
        body: JSON.stringify({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/x.mp4' } }),
        headers: {},
      },
    ]);
    const downloaded: string[] = [];
    const adapter = createBflVideoAdapter({
      baseUrl: 'https://api.bfl.ai/v1',
      apiKey: async () => 'k',
      transport,
      fetchImpl: (async (url: string) => {
        downloaded.push(url);
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }) as unknown as typeof fetch,
    });

    const outcome = await adapter.poll({
      task: 'video',
      modelId: 'flux-3-video',
      remoteId: 'bfl-1',
      pollUrl: 'https://api.bfl.ai/v1/poll/bfl-1',
    });

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.outputs[0]?.mime).toBe('video/mp4');
    expect(outcome.outputs[0]?.bytes.byteLength).toBe(4);
    // The URL is fetched during the poll: storing it would be a dead link tomorrow.
    expect(downloaded).toEqual(['https://delivery.bfl.ai/x.mp4']);
  });

  it('fails when the provider says the job failed, and when Ready carries no URL', () => {
    expect(parseBflPollBody(JSON.stringify({ status: 'Failed', error: 'nsfw' })).error).toBe('nsfw');
    expect(parseBflPollBody(JSON.stringify({ status: 'Error' })).error).toBeTruthy();
    const readyNoUrl = parseBflPollBody(JSON.stringify({ status: 'Ready', result: {} }));
    expect(readyNoUrl.status).toBe('ready');
    expect(readyNoUrl.sampleUrl).toBeNull();
  });

  it('does not offer image-to-video, which this build has not verified', () => {
    const body = buildBflVideoBody({ ...submitInput, modelId: 'flux-3-video' }) as Record<string, unknown>;
    // Only the documented text-to-video mode is sent.
    expect(body.mode).toBe('t2v');
    expect(body).not.toHaveProperty('image');
    expect(body).not.toHaveProperty('init_image');
  });
});

describe('downloading a provider result', () => {
  it('accepts only HTTPS hosts the provider is documented to serve from', () => {
    expect(isAllowedDownloadUrl('https://delivery.bfl.ai/a.mp4', ['bfl.ai'])).toBe(true);
    expect(isAllowedDownloadUrl('https://bfl.ai/a.mp4', ['bfl.ai'])).toBe(true);
    expect(isAllowedDownloadUrl('http://delivery.bfl.ai/a.mp4', ['bfl.ai'])).toBe(false);
    expect(isAllowedDownloadUrl('https://evil-bfl.ai/a.mp4', ['bfl.ai'])).toBe(false);
    expect(isAllowedDownloadUrl('https://bfl.ai.evil.test/a.mp4', ['bfl.ai'])).toBe(false);
    expect(isAllowedDownloadUrl('not a url', ['bfl.ai'])).toBe(false);
  });

  it('refuses a foreign host instead of fetching it', async () => {
    let called = false;
    await expect(
      downloadBytes('https://elsewhere.test/a.mp4', {
        allowedHosts: ['bfl.ai'],
        fetchImpl: (async () => {
          called = true;
          return new Response('x');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Refusing to download/i);
    expect(called).toBe(false);
  });

  it('refuses a result larger than the ceiling, from the header', async () => {
    await expect(
      downloadBytes('https://delivery.bfl.ai/a.mp4', {
        allowedHosts: ['bfl.ai'],
        maxBytes: 10,
        fetchImpl: (async () =>
          new Response(new Uint8Array(50), {
            status: 200,
            headers: { 'content-length': '50' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/larger than/i);
  });

  it('returns bytes, not text', async () => {
    const bytes = await downloadBytes('https://delivery.bfl.ai/a.mp4', {
      allowedHosts: ['bfl.ai'],
      fetchImpl: (async () =>
        new Response(Uint8Array.from([0x00, 0xff, 0x10, 0x80]), { status: 200 })) as unknown as typeof fetch,
    });
    expect([...bytes]).toEqual([0x00, 0xff, 0x10, 0x80]);
  });
});

describe('async outcome discipline', () => {
  it('a submitted video job never reports success before the bytes exist', async () => {
    const transport = queueTransport([
      { status: 200, body: JSON.stringify({ id: 'v1_a', status: 'in_progress' }), headers: {} },
    ]);
    const adapter = createGeminiVideoAdapter({ baseUrl: 'https://x/v1beta', apiKey: async () => 'k', transport });
    const outcome: MediaJobOutcome = await adapter.submit(submitInput);
    // `pending` carries no outputs at all: there is nothing to persist yet.
    expect(outcome.kind).toBe('pending');
    expect(outcome).not.toHaveProperty('outputs');
  });
});

describe('the media-only provider cannot leak into chat', () => {
  it('declares a BFL model that is offered for video and never for chat', async () => {
    const { MODEL_HINTS } = await import('@shared/defaults');
    const { supportsTask } = await import('@shared/capabilities');
    const hints = MODEL_HINTS.bfl;
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(supportsTask(hint.capabilities, 'video')).toBe(true);
      // This is the guard that makes the BFL chat adapter's refusal unreachable in
      // the running app rather than merely unlikely.
      expect(supportsTask(hint.capabilities, 'chat')).toBe(false);
    }
  });

  it('has a preset with no chat parameters and no discovery', async () => {
    const { PROVIDER_PRESETS } = await import('@shared/defaults');
    expect(PROVIDER_PRESETS.bfl.supportedParams).toEqual([]);
    expect(PROVIDER_PRESETS.bfl.supportsModelDiscovery).toBe(false);
  });
});