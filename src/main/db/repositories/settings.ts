/**
 * Settings repository.
 *
 * Settings live in one row (`id = 'app-settings'`) as a JSON document. The
 * document on disk is not trusted: `get()` always runs it through
 * `normaliseSettings`, so a hand-edited file, a half-written patch, or a corrupt
 * blob degrades to defaults and never produces a partially-typed `AppSettings`.
 * `normaliseSettings` and `mergeSettings` come from `src/shared/settings.ts` —
 * this layer does not reimplement any of that composition.
 */
import { DEFAULT_SETTINGS } from '../../../shared/defaults';
import type { SettingsRepository, WriteOptions } from '../../../shared/repository-contract';
import { mergeSettings, normaliseSettings } from '../../../shared/settings';
import type { AppSettings, AppSettingsPatch } from '../../../shared/types';
import { nowIso, type DbRow } from '../codec';
import { SETTINGS_ROW_ID } from '../constants';
import { toAppSettings } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

export class SqliteSettingsRepository extends BaseRepository implements SettingsRepository {
  get(): AppSettings {
    const row = this.sql.get<DbRow>('SELECT * FROM app_settings WHERE id = ?', [SETTINGS_ROW_ID]);
    return toAppSettings(row);
  }

  replace(settings: AppSettings, options?: WriteOptions): AppSettings {
    const normalised = normaliseSettings(settings);
    this.write(normalised, options);
    return normalised;
  }

  patch(patch: AppSettingsPatch, options?: WriteOptions): AppSettings {
    const merged = mergeSettings(this.get(), patch);
    this.write(merged, options);
    return merged;
  }

  reset(options?: WriteOptions): AppSettings {
    const defaults = normaliseSettings(DEFAULT_SETTINGS);
    this.write(defaults, options);
    return defaults;
  }

  private write(settings: AppSettings, options?: WriteOptions): void {
    const now = nowIso();
    this.sql.run(
      `INSERT INTO app_settings
         (id, json, version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
       VALUES (?, ?, 1, ?, 0, NULL, NULL, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET
         json = excluded.json,
         version = app_settings.version + 1,
         dirty = excluded.dirty,
         attempts = 0,
         next_attempt_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`,
      [SETTINGS_ROW_ID, JSON.stringify(settings), dirtyFlag(options), now, now],
    );
  }
}
