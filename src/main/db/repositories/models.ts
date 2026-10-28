/**
 * Model repository: custom models plus the persisted result of provider model
 * discovery.
 *
 * `UNIQUE (provider_id, model_id, source)` is what keeps "the same model" from
 * existing twice within one source. Custom rows deliberately win a lookup by
 * reference (`findByRef`), because the user's explicit configuration must beat a
 * stale discovery snapshot. Ids are deterministic — `custom:<provider>:<model>`
 * and `disc:<provider>:<model>` — so rediscovery updates the existing row rather
 * than creating a new identity every time.
 */
import type { CustomModelRepository, WriteOptions } from '../../../shared/repository-contract';
import type {
  CustomModelInput,
  GenParamKey,
  Id,
  ModelCapabilities,
  ModelDescriptor,
  ModelLimits,
  ModelSource,
} from '../../../shared/types';
import { nowIso, type DbRow } from '../codec';
import { DbError } from '../errors';
import { toModelDescriptor } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

const MODEL_COLUMNS = `id, provider_id, model_id, display_name, source, capabilities_json, limits_json,
  supported_params_json, weirdness_supported, base_url_override, description,
  version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at`;

interface ModelRowInput {
  id: string;
  providerId: Id;
  modelId: string;
  displayName: string;
  source: ModelSource;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  supportedParams: GenParamKey[];
  weirdnessSupported: boolean;
  baseUrlOverride: string | null;
  description: string;
  dirty: number;
}

export class SqliteModelRepository extends BaseRepository implements CustomModelRepository {
  list(providerId?: Id): ModelDescriptor[] {
    const rows =
      providerId === undefined
        ? this.sql.query<DbRow>(
            `SELECT ${MODEL_COLUMNS} FROM models
              WHERE deleted_at IS NULL
              ORDER BY display_name COLLATE NOCASE ASC, model_id ASC`,
          )
        : this.sql.query<DbRow>(
            `SELECT ${MODEL_COLUMNS} FROM models
              WHERE deleted_at IS NULL AND provider_id = ?
              ORDER BY display_name COLLATE NOCASE ASC, model_id ASC`,
            [providerId],
          );
    return rows.map((row) => toModelDescriptor(row));
  }

  get(id: Id): ModelDescriptor | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${MODEL_COLUMNS} FROM models WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row === null ? null : toModelDescriptor(row);
  }

  findByRef(providerId: Id, modelId: string): ModelDescriptor | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${MODEL_COLUMNS} FROM models
        WHERE provider_id = ? AND model_id = ? AND deleted_at IS NULL
        ORDER BY CASE source WHEN 'custom' THEN 0 WHEN 'discovered' THEN 1 ELSE 2 END,
                 updated_at DESC
        LIMIT 1`,
      [providerId, modelId],
    );
    return row === null ? null : toModelDescriptor(row);
  }

  upsert(input: CustomModelInput, options?: WriteOptions): ModelDescriptor {
    const modelId = input.modelId.trim();
    if (modelId.length === 0) {
      throw new DbError('A custom model needs a modelId.', 'validation');
    }
    const provider = this.sql.get<{ id: string }>(
      'SELECT id FROM providers WHERE id = ? AND deleted_at IS NULL',
      [input.providerId],
    );
    if (provider === null) {
      throw new DbError(`Provider ${input.providerId} does not exist.`, 'not_found');
    }

    const id = this.resolveUpsertId(input, modelId);
    this.writeModel({
      id,
      providerId: input.providerId,
      modelId,
      displayName:
        input.displayName.trim().length > 0 ? input.displayName.trim() : modelId,
      source: 'custom',
      capabilities: input.capabilities,
      limits: input.limits ?? {},
      supportedParams: input.supportedParams ?? [],
      weirdnessSupported: input.weirdnessSupported === true,
      baseUrlOverride: input.baseUrlOverride ?? null,
      description: input.description ?? '',
      dirty: dirtyFlag(options),
    });
    return this.require(id);
  }

  softDelete(id: Id, options?: WriteOptions): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE models
          SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [now, now, dirtyFlag(options), id],
    );
  }

  replaceDiscovered(providerId: Id, models: ModelDescriptor[]): void {
    this.transaction(() => {
      const kept = new Set<string>();
      for (const model of models) {
        const modelId = model.modelId.trim();
        if (modelId.length === 0) continue;
        // A discovered row's identity is provider + provider-side model id. A
        // caller-supplied id is honoured only when it carries that identity, so
        // one provider's snapshot can never rewrite another provider's row.
        const suppliedId = model.id.trim();
        const id =
          suppliedId.length > 0 && suppliedId.startsWith(`disc:${providerId}:`)
            ? suppliedId
            : `disc:${providerId}:${modelId}`;
        kept.add(id);
        this.writeModel({
          id,
          providerId,
          modelId,
          displayName:
            model.displayName.trim().length > 0 ? model.displayName.trim() : modelId,
          source: 'discovered',
          capabilities: model.capabilities,
          limits: model.limits,
          supportedParams: model.supportedParams,
          weirdnessSupported: model.weirdnessSupported,
          baseUrlOverride: model.baseUrlOverride,
          description: model.description,
          dirty: 1,
        });
      }

      const existing = this.sql.query<{ id: string }>(
        `SELECT id FROM models
          WHERE provider_id = ? AND source = 'discovered' AND deleted_at IS NULL`,
        [providerId],
      );
      const now = nowIso();
      for (const row of existing) {
        if (kept.has(row.id)) continue;
        this.sql.run(
          `UPDATE models
              SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = 1
            WHERE id = ? AND deleted_at IS NULL`,
          [now, now, row.id],
        );
      }
    });
  }

  clearDiscovered(providerId: Id): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE models
          SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = 1
        WHERE provider_id = ? AND source = 'discovered' AND deleted_at IS NULL`,
      [now, now, providerId],
    );
  }

  private resolveUpsertId(input: CustomModelInput, modelId: string): string {
    const explicit = input.id !== undefined && input.id.trim().length > 0 ? input.id.trim() : null;
    if (explicit !== null) return explicit;

    const existing = this.sql.get<{ id: string }>(
      `SELECT id FROM models
        WHERE provider_id = ? AND model_id = ? AND source = 'custom'
        ORDER BY (deleted_at IS NULL) DESC
        LIMIT 1`,
      [input.providerId, modelId],
    );
    return existing === null ? `custom:${input.providerId}:${modelId}` : existing.id;
  }

  private writeModel(row: ModelRowInput): void {
    const now = nowIso();
    const capabilitiesJson = JSON.stringify(row.capabilities);
    const limitsJson = JSON.stringify(row.limits);
    const supportedJson = JSON.stringify(row.supportedParams);
    const weirdness = row.weirdnessSupported ? 1 : 0;

    const exists = this.sql.get<{ id: string }>('SELECT id FROM models WHERE id = ?', [row.id]);
    if (exists === null) {
      this.sql.run(
        `INSERT INTO models
           (id, provider_id, model_id, display_name, source, capabilities_json, limits_json,
            supported_params_json, weirdness_supported, base_url_override, description,
            version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, NULL, ?, ?, NULL)`,
        [
          row.id,
          row.providerId,
          row.modelId,
          row.displayName,
          row.source,
          capabilitiesJson,
          limitsJson,
          supportedJson,
          weirdness,
          row.baseUrlOverride,
          row.description,
          row.dirty,
          now,
          now,
        ],
      );
      return;
    }

    this.sql.run(
      `UPDATE models
          SET provider_id = ?, model_id = ?, display_name = ?, source = ?, capabilities_json = ?,
              limits_json = ?, supported_params_json = ?, weirdness_supported = ?,
              base_url_override = ?, description = ?, version = version + 1, updated_at = ?,
              dirty = ?, deleted_at = NULL
        WHERE id = ?`,
      [
        row.providerId,
        row.modelId,
        row.displayName,
        row.source,
        capabilitiesJson,
        limitsJson,
        supportedJson,
        weirdness,
        row.baseUrlOverride,
        row.description,
        now,
        row.dirty,
        row.id,
      ],
    );
  }

  private require(id: Id): ModelDescriptor {
    const model = this.get(id);
    if (model === null) {
      throw new DbError(`Model ${id} does not exist.`, 'not_found');
    }
    return model;
  }
}
