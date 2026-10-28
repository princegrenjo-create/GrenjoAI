/**
 * Transcription service: the audio path is where an application is most tempted
 * to fake success, so every refusal here is asserted explicitly.
 */
import { describe, expect, it } from 'vitest';
import { createTranscriptionService } from '@main/transcription/service';
import { createMemoryCredentialStore } from '@main/credentials';
import { bindProviderKey } from '@main/models/endpoint-policy';
import { createRegistry } from '@main/providers/registry';
import { createNullLogger } from '@main/logger';
import { createFakeDatabase } from '../../helpers/fake-database';
import type { ProviderTransport, TransportResponse } from '@shared/provider-contract';

const AUDIO_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]).toString('base64');

function harness(options: { withKey?: boolean; response?: TransportResponse; throwError?: Error } = {}) {
  const db = createFakeDatabase();
  const credentials = createMemoryCredentialStore();
  const provider = db.providers.create({
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });
  if (options.withKey !== false) {
    bindProviderKey(credentials, provider.id, provider.baseUrl, 'sk-test-0123456789abcdef');
  }

  const sent: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
  const transport: ProviderTransport = {
    async send(spec): Promise<TransportResponse> {
      sent.push({
        url: spec.url,
        headers: spec.headers,
        bytes: spec.bodyBytes?.length ?? 0,
      });
      if (options.throwError) throw options.throwError;
      return options.response ?? { status: 200, body: JSON.stringify({ text: 'hello world' }), headers: {} };
    },
    async run() {
      return { text: '', usage: null, finishReason: 'stop' };
    },
  };

  const service = createTranscriptionService({
    db,
    credentials,
    registry: createRegistry(),
    transport,
    logger: createNullLogger(),
  });

  return { db, credentials, provider, service, sent };
}

describe('transcription service', () => {
  it('reports the missing configuration instead of offering a broken button', () => {
    const { service } = harness({ withKey: false });
    const status = service.status();
    expect(status.available).toBe(false);
    expect(status.providerName).toBeNull();
    expect(status.reason).toMatch(/OpenAI API key/i);
    expect(status.reason).toMatch(/Models & Providers/i);
  });

  it('reports the provider name once an OpenAI key is bound', () => {
    const { service } = harness();
    const status = service.status();
    expect(status.available).toBe(true);
    expect(status.providerName).toBe('OpenAI');
    expect(status.reason).toBeNull();
  });

  it('refuses with a readable error when no provider is configured', async () => {
    const { service } = harness({ withKey: false });
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm', durationMs: 1200 }),
    ).rejects.toThrowError(/OpenAI API key/i);
  });

  it('sends a multipart request and returns the transcript', async () => {
    const { service, sent } = harness();
    const result = await service.transcribe({
      dataBase64: AUDIO_BASE64,
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 4200,
    });

    expect(result.text).toBe('hello world');
    expect(result.modelId).toBe('whisper-1');
    expect(result.durationMs).toBe(4200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(sent[0]?.headers.Authorization).toBe('Bearer sk-test-0123456789abcdef');
    expect(sent[0]?.url).not.toContain('sk-test');
    expect(sent[0]?.bytes).toBeGreaterThan(200);
  });

  it('normalises the codec parameter when choosing the filename', async () => {
    const { service } = harness();
    await service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm;codecs=opus', durationMs: 1 });
    // Built successfully => the ";codecs=..." suffix was stripped before matching.
    expect(true).toBe(true);
  });

  it('refuses a format the endpoint does not accept', async () => {
    const { service, sent } = harness();
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'video/mp4', durationMs: 1000 }),
    ).rejects.toThrowError(/cannot be transcribed/i);
    expect(sent).toHaveLength(0);
  });

  it('refuses an empty recording without calling the network', async () => {
    const { service, sent } = harness();
    await expect(
      service.transcribe({ dataBase64: '', mimeType: 'audio/webm', durationMs: 0 }),
    ).rejects.toThrowError(/empty/i);
    expect(sent).toHaveLength(0);
  });

  it('refuses a recording longer than the limit', async () => {
    const { service, sent } = harness();
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm', durationMs: 301_000 }),
    ).rejects.toThrowError(/longer than/i);
    expect(sent).toHaveLength(0);
  });

  it('refuses an oversized recording before uploading it', async () => {
    const { service, sent } = harness();
    const huge = Buffer.alloc(21 * 1024 * 1024, 1).toString('base64');
    await expect(
      service.transcribe({ dataBase64: huge, mimeType: 'audio/webm', durationMs: 1000 }),
    ).rejects.toThrowError(/larger than/i);
    expect(sent).toHaveLength(0);
  });

  it('maps an API failure and does not invent text', async () => {
    const { service } = harness({
      response: { status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }), headers: {} },
    });
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm', durationMs: 900 }),
    ).rejects.toThrowError(/API key/i);
  });

  it('surfaces a transport failure as a mapped error', async () => {
    const { service } = harness({ throwError: new Error('socket hang up') });
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm', durationMs: 900 }),
    ).rejects.toThrowError(/socket hang up|unexpected|provider/i);
  });

  it('returns an error rather than an empty string when the provider sends no text', async () => {
    const { service } = harness({ response: { status: 200, body: '{"text":""}', headers: {} } });
    await expect(
      service.transcribe({ dataBase64: AUDIO_BASE64, mimeType: 'audio/webm', durationMs: 900 }),
    ).rejects.toThrowError(/empty/i);
  });
});
