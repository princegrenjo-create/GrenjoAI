import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@main/db/index';
import { TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

const EXPECTED_PROVIDER_COLUMNS = [
  'attempts',
  'base_url',
  'created_at',
  'deleted_at',
  'dirty',
  'enabled',
  'id',
  'key_fingerprint',
  'key_updated_at',
  'kind',
  'last_error',
  'name',
  'next_attempt_at',
  'updated_at',
  'version',
];

describe('providers', () => {
  it('creates a provider with the preset defaults', () => {
    const provider = t.db.providers.create({
      kind: 'deepseek',
      name: '',
      baseUrl: '',
    });

    expect(provider.kind).toBe('deepseek');
    expect(provider.name).toBe('DeepSeek');
    expect(provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(provider.enabled).toBe(true);
    expect(provider.hasKey).toBe(false);
    expect(provider.keyFingerprint).toBeNull();
    expect(provider.keyUpdatedAt).toBeNull();
    expect(provider.supportsModelDiscovery).toBe(true);
    expect(provider.supportedParams).toContain('temperature');
  });

  it('lists, reads and orders providers by name', () => {
    t.db.providers.create({ kind: 'openai', name: 'zeta', baseUrl: 'https://z.test' });
    const alpha = t.db.providers.create({
      kind: 'anthropic',
      name: 'Alpha',
      baseUrl: 'https://a.test',
      enabled: false,
    });

    expect(t.db.providers.list().map((provider) => provider.name)).toEqual(['Alpha', 'zeta']);
    expect(t.db.providers.get(alpha.id)?.enabled).toBe(false);
    expect(t.db.providers.get('missing')).toBeNull();
  });

  it('updates configuration without touching the key state', () => {
    const provider = t.db.providers.create({
      kind: 'openai',
      name: 'Original',
      baseUrl: 'https://api.openai.com/v1',
    });
    t.db.providers.recordKeyState(provider.id, 'abcd1234', '2026-01-01T00:00:00.000Z');

    const updated = t.db.providers.update(provider.id, {
      kind: 'openai-compatible',
      name: 'Renamed',
      baseUrl: 'https://gateway.test/v1',
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.baseUrl).toBe('https://gateway.test/v1');
    expect(updated.kind).toBe('openai-compatible');
    expect(updated.enabled).toBe(true);
    expect(updated.keyFingerprint).toBe('abcd1234');
    expect(updated.hasKey).toBe(true);
  });

  it('rejects an update for an unknown provider', () => {
    expect(() =>
      t.db.providers.update('missing', { kind: 'openai', name: 'x', baseUrl: 'https://x.test' }),
    ).toThrow(DbError);
  });

  it('records key presence as a fingerprint, never the key', () => {
    const provider = t.db.providers.create({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(provider.hasKey).toBe(false);

    t.db.providers.recordKeyState(provider.id, '9f2c1a7b', '2026-03-04T05:06:07.000Z');

    const withKey = t.db.providers.get(provider.id);
    expect(withKey?.hasKey).toBe(true);
    expect(withKey?.keyFingerprint).toBe('9f2c1a7b');
    expect(withKey?.keyUpdatedAt).toBe('2026-03-04T05:06:07.000Z');

    t.db.providers.recordKeyState(provider.id, null, null);

    const cleared = t.db.providers.get(provider.id);
    expect(cleared?.hasKey).toBe(false);
    expect(cleared?.keyFingerprint).toBeNull();
    expect(cleared?.keyUpdatedAt).toBeNull();
  });

  it('soft deletes and hides a provider', () => {
    const provider = t.db.providers.create({
      kind: 'gemini',
      name: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });

    t.db.providers.softDelete(provider.id);

    expect(t.db.providers.get(provider.id)).toBeNull();
    expect(t.db.providers.list()).toEqual([]);
    const row = t.db.sql.get<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?', [
      provider.id,
    ]);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.dirty).toBe(1);
  });

  it('stores no key material: the table has exactly the non-secret columns', () => {
    const provider = t.db.providers.create({
      kind: 'openai-compatible',
      name: 'Local gateway',
      baseUrl: 'https://gateway.test/v1',
    });
    t.db.providers.recordKeyState(provider.id, 'deadbeef', '2026-01-01T00:00:00.000Z');

    const row = t.db.sql.get<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?', [
      provider.id,
    ]);
    expect(row).not.toBeNull();

    const columns = Object.keys(row ?? {}).sort();
    expect(columns).toEqual(EXPECTED_PROVIDER_COLUMNS);

    for (const column of columns) {
      expect(column.toLowerCase()).not.toMatch(/secret|token|credential|password|api_?key|ciphertext/);
    }

    // Dump every stored value: none may be key-shaped, even after a key exists.
    const storedStrings = Object.values(row ?? {}).filter(
      (value): value is string => typeof value === 'string',
    );
    for (const value of storedStrings) {
      expect(value).not.toMatch(/sk-|AIza|sk-ant-|Bearer /);
    }
  });

  it('prevents a second provider with the same explicit id', () => {
    const provider = t.db.providers.create({
      id: 'fixed-provider-id',
      kind: 'openai',
      name: 'Fixed',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(provider.id).toBe('fixed-provider-id');

    expect(() =>
      t.db.providers.create({
        id: 'fixed-provider-id',
        kind: 'openai',
        name: 'Duplicate',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toThrow(DbError);
  });
});
