import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@main/db/index';
import type { ModelDescriptor } from '@shared/types';
import { seedProvider, TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

const CAPABILITIES = { chat: true, streaming: true, imageInput: false, toolCalling: true, imageOutput: false, imageEditing: false, videoInput: false, videoOutput: false, audioInput: false, audioOutput: false, embeddings: false };

function discovered(
  providerId: string,
  modelId: string,
  overrides: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    id: `disc:${providerId}:${modelId}`,
    providerId,
    modelId,
    displayName: modelId,
    source: 'discovered',
    capabilities: CAPABILITIES,
    limits: { contextWindow: 128000, maxOutputTokens: 8192 },
    description: 'Discovered over the provider API',
    supportedParams: ['temperature', 'maxOutputTokens'],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('models', () => {
  it('creates a custom model with a deterministic id', () => {
    const provider = seedProvider(t.db);

    const model = t.db.models.upsert({
      providerId: provider.id,
      modelId: 'my-local-llm',
      displayName: 'My local LLM',
      capabilities: CAPABILITIES,
      limits: { contextWindow: 4096 },
      supportedParams: ['temperature', 'topK'],
      weirdnessSupported: true,
      baseUrlOverride: 'https://localhost.test/v1',
      description: 'A model I run myself',
    });

    expect(model.id).toBe(`custom:${provider.id}:my-local-llm`);
    expect(model.source).toBe('custom');
    expect(model.displayName).toBe('My local LLM');
    expect(model.limits).toEqual({ contextWindow: 4096 });
    expect(model.supportedParams).toEqual(['temperature', 'topK']);
    expect(model.weirdnessSupported).toBe(true);
    expect(model.baseUrlOverride).toBe('https://localhost.test/v1');
  });

  it('updates the same row on a second upsert instead of duplicating it', () => {
    const provider = seedProvider(t.db);
    const input = {
      providerId: provider.id,
      modelId: 'repeatable',
      displayName: 'First name',
      capabilities: CAPABILITIES,
    };

    const first = t.db.models.upsert(input);
    const second = t.db.models.upsert({ ...input, displayName: 'Second name' });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(t.db.models.list()).toHaveLength(1);
    expect(t.db.models.get(first.id)?.displayName).toBe('Second name');
  });

  it('restores a soft-deleted custom model on upsert', () => {
    const provider = seedProvider(t.db);
    const created = t.db.models.upsert({
      providerId: provider.id,
      modelId: 'revived',
      displayName: 'Revived',
      capabilities: CAPABILITIES,
    });
    t.db.models.softDelete(created.id);
    expect(t.db.models.get(created.id)).toBeNull();

    const restored = t.db.models.upsert({
      providerId: provider.id,
      modelId: 'revived',
      displayName: 'Revived again',
      capabilities: CAPABILITIES,
    });

    expect(restored.id).toBe(created.id);
    expect(restored.displayName).toBe('Revived again');
    expect(t.db.models.get(created.id)).not.toBeNull();
  });

  it('finds a model by provider and provider-side model id', () => {
    const provider = seedProvider(t.db);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'ref-model',
      displayName: 'Referenced',
      capabilities: CAPABILITIES,
    });

    expect(t.db.models.findByRef(provider.id, 'ref-model')?.displayName).toBe('Referenced');
    expect(t.db.models.findByRef(provider.id, 'other-model')).toBeNull();
    expect(t.db.models.findByRef('other-provider', 'ref-model')).toBeNull();
  });

  it('prefers a custom row over a discovered row for the same reference', () => {
    const provider = seedProvider(t.db);
    t.db.models.replaceDiscovered(provider.id, [discovered(provider.id, 'shared-model')]);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'shared-model',
      displayName: 'User override',
      capabilities: CAPABILITIES,
    });

    const found = t.db.models.findByRef(provider.id, 'shared-model');
    expect(found?.source).toBe('custom');
    expect(found?.displayName).toBe('User override');
  });

  it('allows the same model id under different sources', () => {
    const provider = seedProvider(t.db);
    t.db.models.replaceDiscovered(provider.id, [discovered(provider.id, 'same-id')]);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'same-id',
      displayName: 'Custom same id',
      capabilities: CAPABILITIES,
    });

    expect(t.db.models.list(provider.id)).toHaveLength(2);
  });

  it('rejects a duplicate (provider, model, source) row', () => {
    const provider = seedProvider(t.db);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'unique-model',
      displayName: 'One',
      capabilities: CAPABILITIES,
    });

    expect(() =>
      t.db.sql.run(
        `INSERT INTO models
           (id, provider_id, model_id, display_name, source, capabilities_json, limits_json,
            supported_params_json, weirdness_supported, base_url_override, description,
            version, dirty, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 1, 1, ?, ?)`,
        [
          'custom:explicit-duplicate',
          provider.id,
          'unique-model',
          'Duplicate',
          'custom',
          JSON.stringify(CAPABILITIES),
          '{}',
          '[]',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      ),
    ).toThrow(DbError);
  });

  it('rejects a custom model for a provider that does not exist', () => {
    expect(() =>
      t.db.models.upsert({
        providerId: 'missing-provider',
        modelId: 'm',
        displayName: 'M',
        capabilities: CAPABILITIES,
      }),
    ).toThrow(DbError);
  });

  it('rejects an empty model id', () => {
    const provider = seedProvider(t.db);
    expect(() =>
      t.db.models.upsert({
        providerId: provider.id,
        modelId: '   ',
        displayName: 'Blank',
        capabilities: CAPABILITIES,
      }),
    ).toThrow(DbError);
  });

  it('filters the list by provider', () => {
    const first = seedProvider(t.db, 'First provider');
    const second = seedProvider(t.db, 'Second provider');
    t.db.models.upsert({
      providerId: first.id,
      modelId: 'a',
      displayName: 'A',
      capabilities: CAPABILITIES,
    });
    t.db.models.upsert({
      providerId: second.id,
      modelId: 'b',
      displayName: 'B',
      capabilities: CAPABILITIES,
    });

    expect(t.db.models.list()).toHaveLength(2);
    expect(t.db.models.list(first.id).map((model) => model.modelId)).toEqual(['a']);
  });

  it('persists discovered models and prunes the ones that disappeared', () => {
    const provider = seedProvider(t.db);
    t.db.models.replaceDiscovered(provider.id, [
      discovered(provider.id, 'keep-a'),
      discovered(provider.id, 'keep-b'),
      discovered(provider.id, 'drop-me'),
    ]);
    expect(t.db.models.list(provider.id).map((model) => model.modelId)).toEqual([
      'drop-me',
      'keep-a',
      'keep-b',
    ]);

    t.db.models.replaceDiscovered(provider.id, [
      discovered(provider.id, 'keep-a'),
      discovered(provider.id, 'keep-b'),
    ]);

    expect(t.db.models.list(provider.id).map((model) => model.modelId)).toEqual([
      'keep-a',
      'keep-b',
    ]);
    expect(t.db.models.get(`disc:${provider.id}:drop-me`)).toBeNull();
  });

  it('keeps discovered rows clean across a restart', () => {
    const provider = seedProvider(t.db);
    t.db.models.replaceDiscovered(provider.id, [discovered(provider.id, 'survivor')]);
    t.reopen();

    expect(t.db.models.list(provider.id).map((model) => model.modelId)).toEqual(['survivor']);
  });

  it('clears discovered models but not custom ones', () => {
    const provider = seedProvider(t.db);
    t.db.models.replaceDiscovered(provider.id, [discovered(provider.id, 'disc-1')]);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'custom-1',
      displayName: 'Custom',
      capabilities: CAPABILITIES,
    });

    t.db.models.clearDiscovered(provider.id);

    expect(t.db.models.list(provider.id).map((model) => model.modelId)).toEqual(['custom-1']);
  });

  it('soft deletes a model', () => {
    const provider = seedProvider(t.db);
    const model = t.db.models.upsert({
      providerId: provider.id,
      modelId: 'removable',
      displayName: 'Removable',
      capabilities: CAPABILITIES,
    });

    t.db.models.softDelete(model.id);

    expect(t.db.models.get(model.id)).toBeNull();
    expect(t.db.models.list()).toEqual([]);
    const row = t.db.sql.get<Record<string, unknown>>('SELECT * FROM models WHERE id = ?', [model.id]);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.dirty).toBe(1);
  });

  it('migrates capability defaults for a legacy row', () => {
    const provider = seedProvider(t.db);
    t.db.models.upsert({
      providerId: provider.id,
      modelId: 'legacy',
      displayName: 'Legacy',
      capabilities: CAPABILITIES,
    });
    t.db.sql.run(
      `UPDATE models SET capabilities_json = '{}', limits_json = 'not json', supported_params_json = '["temperature","bogus"]' WHERE provider_id = ?`,
      [provider.id],
    );

    const model = t.db.models.findByRef(provider.id, 'legacy');
    expect(model?.capabilities).toEqual({
      chat: true,
      streaming: true,
      imageInput: false,
      toolCalling: false,
      imageOutput: false,
      imageEditing: false,
      videoInput: false,
      videoOutput: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
    });
    expect(model?.limits).toEqual({});
    expect(model?.supportedParams).toEqual(['temperature']);
  });
});
