/**
 * Provider and model services.
 *
 * These cover the boundary the auditor flagged as untested: what the renderer is
 * allowed to see, what a bad URL or a repointed base URL does to a stored key,
 * and what happens to a model override that would move the key off-origin.
 */
import { describe, expect, it } from 'vitest';
import { createProviderService } from '@main/services/providers';
import { createModelService } from '@main/services/models';
import { createMemoryCredentialStore } from '@main/credentials';
import { createNullLogger } from '@main/logger';
import { createFakeDatabase } from '../../helpers/fake-database';
import type { ProviderAdapter, ProviderRegistry, ProviderTransport, TransportResponse } from '@shared/provider-contract';
import type { HttpRequestSpec } from '@shared/provider-contract';
import { appError } from '@shared/errors';

function spec(url = 'https://api.example.test/v1/models'): HttpRequestSpec {
  return { url, method: 'GET', headers: {}, body: null };
}

function stubAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    kind: 'deepseek',
    label: 'Stub provider',
    supportedParams: ['temperature', 'topP', 'maxOutputTokens'],
    supportsModelDiscovery: true,
    buildTestRequest: () => spec(),
    buildListModelsRequest: () => spec(),
    parseListModels: () => ({
      models: [
        {
          modelId: 'model-a',
          displayName: 'Model A',
          description: '',
          capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
          limits: {},
          supportedParams: ['temperature'],
          weirdnessSupported: false,
        },
      ],
      error: null,
    }),
    parseTestResponse: () => ({
      ok: true,
      latencyMs: null,
      message: 'Reachable.',
      modelsFound: 1,
      error: null,
    }),
    buildChatRequest: () => spec(),
    createResponseParser: () => ({ push: () => [], end: () => [] }),
    parseError: () => appError('provider_error', 'failed'),
    ...overrides,
  };
}

function harness(adapter: ProviderAdapter = stubAdapter()) {
  const db = createFakeDatabase();
  const credentials = createMemoryCredentialStore();
  const sent: HttpRequestSpec[] = [];
  let failSendWith: Error | null = null;
  const transport: ProviderTransport = {
    async send(request): Promise<TransportResponse> {
      if (failSendWith) throw failSendWith;
      sent.push(request);
      return { status: 200, body: '{"data":[]}', headers: {} };
    },
    async run() {
      return { text: 'ok', usage: null, finishReason: 'stop' };
    },
  };
  const registry: ProviderRegistry = { get: () => adapter, all: () => [adapter] };
  const providers = createProviderService({
    db,
    credentials,
    registry,
    transport,
    settings: () => db.settings.get(),
    logger: createNullLogger(),
  });
  const models = createModelService({
    db,
    credentials,
    registry,
    transport,
    settings: () => db.settings.get(),
    logger: createNullLogger(),
  });
  return {
    db,
    credentials,
    providers,
    models,
    sent,
    setSendFailure: (error: Error | null) => {
      failSendWith = error;
    },
  };
}

describe('provider service', () => {
  it('never exposes the key, only presence and a fingerprint', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(created.hasKey).toBe(false);

    const withKey = await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');
    expect(withKey.hasKey).toBe(true);
    expect(withKey.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(withKey)).not.toContain('sk-live-abcdef1234567890');
    expect(JSON.stringify(await h.providers.list())).not.toContain('sk-live-abcdef1234567890');
  });

  it('discards the stored key when the base URL is repointed', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');

    const repointed = await h.providers.upsert({
      id: created.id,
      kind: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://attacker.example/v1',
    });
    expect(repointed.hasKey).toBe(false);
    expect(h.credentials.get(created.id)).toBeNull();
  });

  it('rejects a plain-HTTP remote base URL', async () => {
    const h = harness();
    await expect(
      h.providers.upsert({ kind: 'openai', name: 'Bad', baseUrl: 'http://evil.example.com/v1' }),
    ).rejects.toThrowError(/plain http/i);
  });

  it('reports a missing key instead of probing', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const result = await h.providers.test(created.id);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('missing_key');
    expect(h.sent).toHaveLength(0);
  });

  it('probes the provider and reports latency', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');
    const result = await h.providers.test(created.id);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).not.toBeNull();
    expect(h.sent).toHaveLength(1);
  });

  it('returns a mapped error rather than throwing when the probe fails', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');
    const { AppError } = await import('@shared/errors');
    h.setSendFailure(new AppError(appError('timeout', 'The request timed out.')));
    const result = await h.providers.test(created.id);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
  });

  it('discovers models and returns normalised descriptors', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');
    const discovered = await h.providers.discoverModels(created.id);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.modelId).toBe('model-a');
  });

  it('removing a provider clears its credential', async () => {
    const h = harness();
    const created = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await h.providers.setKey(created.id, 'sk-live-abcdef1234567890');
    await h.providers.remove(created.id);
    expect(h.credentials.get(created.id)).toBeNull();
    expect(await h.providers.list()).toHaveLength(0);
  });
});

describe('model service', () => {
  it('refuses to test an unregistered model without calling the network', async () => {
    const h = harness();
    const provider = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await h.providers.setKey(provider.id, 'sk-live-abcdef1234567890');
    const result = await h.models.test({ providerId: provider.id, modelId: 'no-such-model' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('model_not_found');
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a model override on another origin before any request', async () => {
    const h = harness();
    const provider = await h.providers.upsert({
      kind: 'openai-compatible',
      name: 'Custom',
      baseUrl: 'https://api.example.test/v1',
    });
    await h.providers.setKey(provider.id, 'sk-live-abcdef1234567890');
    await h.models.upsert({
      providerId: provider.id,
      modelId: 'evil-model',
      displayName: 'Evil',
      baseUrlOverride: 'https://attacker.example/v1',
      capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
    });
    const result = await h.models.test({ providerId: provider.id, modelId: 'evil-model' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation');
    expect(sendCount(h)).toBe(0);
  });

  it('rejects a plain-HTTP override when it is saved', async () => {
    const h = harness();
    const provider = await h.providers.upsert({
      kind: 'openai-compatible',
      name: 'Custom',
      baseUrl: 'https://api.example.test/v1',
    });
    await expect(
      h.models.upsert({
        providerId: provider.id,
        modelId: 'm1',
        displayName: 'M1',
        baseUrlOverride: 'http://plain.example.test/v1',
        capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
      }),
    ).rejects.toThrowError(/plain http/i);
  });

  it('deletes only models the owner created', async () => {
    const h = harness();
    const provider = await h.providers.upsert({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const created = await h.models.upsert({
      providerId: provider.id,
      modelId: 'mine',
      displayName: 'Mine',
      capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
    });
    await h.models.remove(created.id);
    expect(h.db.models.get(created.id)).toBeNull();

    const discovered = await h.models.saveDiscovered(provider.id, [
      {
        modelId: 'from-discovery',
        displayName: 'Discovered',
        description: '',
        capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
        limits: {},
        supportedParams: [],
        weirdnessSupported: false,
      },
    ]);
    const row = discovered.find((model) => model.modelId === 'from-discovery');
    expect(row).toBeDefined();
    await expect(h.models.remove(row?.id ?? '')).rejects.toThrowError(/only models you added/i);
  });
});

function sendCount(h: ReturnType<typeof harness>): number {
  return h.sent.length;
}
