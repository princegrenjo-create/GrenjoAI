/**
 * Provider repository.
 *
 * This table holds provider *configuration*, never a credential: there is no
 * key column and no ciphertext column. `key_fingerprint` records only the first
 * eight hex characters of `sha256(key)` so the UI can show that a key changed,
 * and `key_updated_at` records when. Both are written by `recordKeyState` after
 * the credential service has already stored the key in the OS credential store.
 * `hasKey` is derived from the fingerprint on read, so a cleared key cannot
 * leave a stale "configured" flag behind.
 */
import { PROVIDER_PRESETS } from '../../../shared/defaults';
import type { ProviderRepository, WriteOptions } from '../../../shared/repository-contract';
import type { Id, ProviderConfig, ProviderInput } from '../../../shared/types';
import { newId, nowIso, type DbRow } from '../codec';
import { DbError } from '../errors';
import { toProviderConfig } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

const PROVIDER_COLUMNS = `id, kind, name, base_url, enabled, key_fingerprint, key_updated_at,
  version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at`;

export class SqliteProviderRepository extends BaseRepository implements ProviderRepository {
  list(): ProviderConfig[] {
    const rows = this.sql.query<DbRow>(
      `SELECT ${PROVIDER_COLUMNS}
         FROM providers
        WHERE deleted_at IS NULL
        ORDER BY name COLLATE NOCASE ASC, created_at ASC`,
    );
    return rows.map((row) => toProviderConfig(row));
  }

  get(id: Id): ProviderConfig | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row === null ? null : toProviderConfig(row);
  }

  create(input: ProviderInput, options?: WriteOptions): ProviderConfig {
    const id = input.id !== undefined && input.id.trim().length > 0 ? input.id : newId();
    const preset = PROVIDER_PRESETS[input.kind];
    const now = nowIso();
    this.sql.run(
      `INSERT INTO providers
         (id, kind, name, base_url, enabled, key_fingerprint, key_updated_at,
          version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, 0, NULL, NULL, ?, ?, NULL)`,
      [
        id,
        input.kind,
        input.name.trim().length > 0 ? input.name.trim() : preset.defaultName,
        input.baseUrl.trim().length > 0 ? input.baseUrl.trim() : preset.defaultBaseUrl,
        input.enabled === false ? 0 : 1,
        dirtyFlag(options),
        now,
        now,
      ],
    );
    return this.require(id);
  }

  update(id: Id, input: ProviderInput, options?: WriteOptions): ProviderConfig {
    const current = this.require(id);
    const preset = PROVIDER_PRESETS[input.kind];
    const enabled = input.enabled !== undefined ? input.enabled : current.enabled;

    this.sql.run(
      `UPDATE providers
          SET kind = ?, name = ?, base_url = ?, enabled = ?,
              version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ?`,
      [
        input.kind,
        input.name.trim().length > 0 ? input.name.trim() : preset.defaultName,
        input.baseUrl.trim().length > 0 ? input.baseUrl.trim() : preset.defaultBaseUrl,
        enabled ? 1 : 0,
        nowIso(),
        dirtyFlag(options),
        id,
      ],
    );
    return this.require(id);
  }

  recordKeyState(id: Id, fingerprint: string | null, updatedAt: string | null): void {
    this.sql.run(
      `UPDATE providers
          SET key_fingerprint = ?, key_updated_at = ?,
              version = version + 1, updated_at = ?, dirty = 1
        WHERE id = ? AND deleted_at IS NULL`,
      [fingerprint, updatedAt, nowIso(), id],
    );
  }

  softDelete(id: Id, options?: WriteOptions): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE providers
          SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [now, now, dirtyFlag(options), id],
    );
  }

  private require(id: Id): ProviderConfig {
    const provider = this.get(id);
    if (provider === null) {
      throw new DbError(`Provider ${id} does not exist.`, 'not_found');
    }
    return provider;
  }
}
