import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

function rawSettingsRow(): Record<string, unknown> | null {
  return t.db.sql.get<Record<string, unknown>>('SELECT * FROM app_settings WHERE id = ?', [
    'app-settings',
  ]);
}

describe('settings', () => {
  it('returns the normalised defaults on a fresh database', () => {
    expect(t.db.settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(rawSettingsRow()).toBeNull();
  });

  it('persists a patch and reads it back', () => {
    const patched = t.db.settings.patch({
      general: { theme: 'light', reduceMotion: true },
      chat: { streaming: false },
    });

    expect(patched.general.theme).toBe('light');
    expect(patched.general.reduceMotion).toBe(true);
    expect(patched.chat.streaming).toBe(false);
    expect(t.db.settings.get()).toEqual(patched);
    expect(t.db.settings.get().advanced.logLevel).toBe('info');
  });

  it('deep-merges the generation parameter overrides instead of replacing them', () => {
    const patched = t.db.settings.patch({ defaults: { params: { temperature: 0.15 } } });

    expect(patched.defaults.params.temperature).toBe(0.15);
    expect(patched.defaults.params.topP).toBe(DEFAULT_SETTINGS.defaults.params.topP);
    expect(patched.defaults.params.maxOutputTokens).toBe(
      DEFAULT_SETTINGS.defaults.params.maxOutputTokens,
    );
  });

  it('normalises out-of-range values on write', () => {
    const patched = t.db.settings.patch({
      generation: { maxRetries: 99, requestTimeoutMs: 10, maxHistoryMessages: 0 },
      sync: { syncIntervalMs: 1 },
      weirdness: { bias: 42 },
    });

    expect(patched.generation.maxRetries).toBe(5);
    expect(patched.generation.requestTimeoutMs).toBe(1000);
    expect(patched.generation.maxHistoryMessages).toBe(1);
    expect(patched.sync.syncIntervalMs).toBe(15000);
    expect(patched.weirdness.bias).toBe(1);
    expect(t.db.settings.get()).toEqual(patched);
  });

  it('normalises a corrupt stored document to defaults', () => {
    t.db.settings.patch({ general: { theme: 'light' } });
    t.db.sql.run('UPDATE app_settings SET json = ? WHERE id = ?', [
      '{"general":{"theme":',
      'app-settings',
    ]);

    expect(t.db.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('normalises a partial stored document, keeping valid values', () => {
    t.db.sql.run(
      'INSERT INTO app_settings (id, json, version, dirty, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)',
      [
        'app-settings',
        '{"general":{"theme":"neon"},"generation":{"maxRetries":-9},"sync":{"enabled":true}}',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ],
    );

    const settings = t.db.settings.get();
    expect(settings.general.theme).toBe('dark');
    expect(settings.generation.maxRetries).toBe(0);
    expect(settings.sync.enabled).toBe(true);
    expect(settings.schemaVersion).toBe(DEFAULT_SETTINGS.schemaVersion);
  });

  it('replaces the whole document', () => {
    t.db.settings.patch({ general: { theme: 'light' } });
    const replacement = {
      ...DEFAULT_SETTINGS,
      general: { ...DEFAULT_SETTINGS.general, theme: 'system' as const },
      advanced: { ...DEFAULT_SETTINGS.advanced, logLevel: 'debug' as const },
    };

    const applied = t.db.settings.replace(replacement);

    expect(applied.general.theme).toBe('system');
    expect(applied.advanced.logLevel).toBe('debug');
    expect(t.db.settings.get()).toEqual(applied);
  });

  it('resets to the defaults', () => {
    t.db.settings.patch({ general: { theme: 'light' }, sync: { enabled: true } });

    const reset = t.db.settings.reset();

    expect(reset).toEqual(DEFAULT_SETTINGS);
    expect(t.db.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('survives a restart', () => {
    t.db.settings.patch({ general: { theme: 'light' }, defaults: { modelId: 'deepseek-chat' } });

    t.reopen();

    const settings = t.db.settings.get();
    expect(settings.general.theme).toBe('light');
    expect(settings.defaults.modelId).toBe('deepseek-chat');
  });

  it('bumps the sync version on every write and can be written clean', () => {
    t.db.settings.patch({ general: { theme: 'light' } });
    expect(rawSettingsRow()?.version).toBe(1);
    expect(rawSettingsRow()?.dirty).toBe(1);

    t.db.settings.patch({ general: { theme: 'dark' } });
    expect(rawSettingsRow()?.version).toBe(2);

    t.db.settings.replace(DEFAULT_SETTINGS, { dirty: false });
    expect(rawSettingsRow()?.dirty).toBe(0);
  });
});
