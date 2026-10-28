import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { createSettingsService } from '@main/services/settings';
import { createNullLogger } from '@main/logger';
import { createFakeDatabase } from '../../helpers/fake-database';

function harness() {
  const db = createFakeDatabase();
  const service = createSettingsService({ db, logger: createNullLogger() });
  return { db, service };
}

describe('settings service', () => {
  it('patches a section and keeps the other sections intact', async () => {
    const { service } = harness();
    const updated = await service.patch({ general: { theme: 'light' } });
    expect(updated.general.theme).toBe('light');
    expect(updated.chat.streaming).toBe(DEFAULT_SETTINGS.chat.streaming);
  });

  it('normalises an out-of-range patch instead of storing it', async () => {
    const { service } = harness();
    // The IPC schema would reject this; the service must not store it either if
    // it is reached from an import.
    const updated = await service.patch({ generation: { maxRetries: 99 } });
    expect(updated.generation.maxRetries).toBe(5);
  });

  it('resets to the documented defaults', async () => {
    const { service } = harness();
    await service.patch({ general: { theme: 'light' }, weirdness: { mode: 'creativityBias' } });
    const reset = await service.reset();
    expect(reset.general.theme).toBe(DEFAULT_SETTINGS.general.theme);
    expect(reset.weirdness.mode).toBe('off');
  });

  it('exports configuration with credentials structurally excluded', async () => {
    const { db, service } = harness();
    const provider = db.providers.create({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    db.providers.recordKeyState(provider.id, 'deadbeef', '2026-01-01T00:00:00.000Z');
    db.agents.create({ name: 'Terse', systemPrompt: 'Be brief.' });

    const document = await service.exportConfig();
    expect(document.credentials).toBe('excluded');
    expect(document.providers).toHaveLength(1);
    expect(document.agents).toHaveLength(1);
    expect(JSON.stringify(document)).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(document.providers[0]).not.toHaveProperty('hasKey');
    expect(document.providers[0]).not.toHaveProperty('keyFingerprint');
  });

  it('imports settings, providers, agents and custom models', async () => {
    const { db, service } = harness();
    const payload = JSON.stringify({
      app: 'personal-ai-desk',
      exportedAt: '2026-01-01T00:00:00.000Z',
      credentials: 'excluded',
      settings: { general: { theme: 'light' } },
      providers: [
        { id: 'p-openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
      ],
      agents: [{ id: 'a-1', name: 'Editor', systemPrompt: 'Edit prose.' }],
      customModels: [
        {
          providerId: 'p-openai',
          modelId: 'my-local-model',
          displayName: 'Local',
          capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
        },
      ],
    });

    const result = await service.importConfig(payload);
    expect(result.applied).toContain('settings');
    expect(db.providers.get('p-openai')?.name).toBe('OpenAI');
    expect(db.agents.get('a-1')?.systemPrompt).toBe('Edit prose.');
    expect(
      db.models.list('p-openai').some((model) => model.modelId === 'my-local-model'),
    ).toBe(true);
  });

  it('refuses an import document that contains something key-shaped', async () => {
    const { service } = harness();
    const payload = JSON.stringify({
      app: 'personal-ai-desk',
      settings: { general: { theme: 'dark' } },
      note: 'sk-abcdefghijklmnop1234567890',
    });
    await expect(service.importConfig(payload)).rejects.toThrowError(/looks like an api key/i);
  });

  it('skips a secret-named field instead of importing it', async () => {
    const { service } = harness();
    const payload = JSON.stringify({
      app: 'personal-ai-desk',
      settings: {},
      apiKey: 'placeholder',
    });
    const result = await service.importConfig(payload);
    expect(result.skipped).toContain('apiKey');
    expect(result.warnings.join(' ')).toMatch(/credentials are never imported/i);
  });

  it('rejects a document that is not a Personal AI Desk export', async () => {
    const { service } = harness();
    await expect(service.importConfig('{"app":"something-else"}')).rejects.toThrowError(
      /not a personal ai desk configuration/i,
    );
  });

  it('rejects malformed JSON with a readable message', async () => {
    const { service } = harness();
    await expect(service.importConfig('{oops')).rejects.toThrowError(/not valid json/i);
  });

  it('skips a provider whose base URL is not acceptable', async () => {
    const { service } = harness();
    const payload = JSON.stringify({
      app: 'personal-ai-desk',
      providers: [{ kind: 'openai', name: 'Bad', baseUrl: 'http://evil.example.com/v1' }],
    });
    const result = await service.importConfig(payload);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/plain http/i);
  });
});
