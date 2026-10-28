/**
 * Sync repository: durable outbox, remote apply and conflict records.
 *
 * The row is the queue entry. A local write sets `dirty = 1`; `markPushed`
 * clears it only when the row still has the version that was pushed, so a write
 * that raced the push is not silently marked as synchronised. A failure records
 * `attempts` / `next_attempt_at` / `last_error` on the same row, which is what
 * makes the sync resumable after an interruption without a second log that can
 * diverge from the data.
 *
 * `applyRemote` never overwrites a dirty local row: a remote record that is
 * newer — a greater `version` OR a later `updated_at`, see `isRemoteNewer` —
 * than a locally-modified row becomes a conflict the user resolves. A remote
 * apply writes `dirty = 0`, because echoing a server record straight back to the
 * server would loop forever.
 */
import type {
  RemoteApplyResult,
  RemoteEntity,
  SqlValue,
  SyncMetaStore,
  SyncPendingRow,
  SyncRepository,
} from '../../../shared/repository-contract';
import { normaliseSettings } from '../../../shared/settings';
import type { SyncConflict, SyncEntityKind } from '../../../shared/types';
import { bool, boundedInt, isRow, jsonOrNull, nullableStr, nowIso, num, parseJson, str, type DbRow } from '../codec';
import { DEFAULT_CONVERSATION_TITLE, SETTINGS_ROW_ID } from '../constants';
import {
  SYNC_ENTITY_KINDS,
  toAppErrorShape,
  toConflictResolution,
  toGenerationParams,
  toGenParamKeys,
  toMessageRole,
  toMessageStatus,
  toModelCapabilities,
  toModelLimits,
  toModelRef,
  toModelSource,
  toProviderKind,
  toSeq,
  toSyncEntityKind,
  toTokenUsage,
} from '../domain-codec';
import { DbError } from '../errors';
import type { DbContext } from '../connection';
import { syncPayloadFor, toSyncConflict } from '../rows';
import { BaseRepository } from './base';

const MAX_PENDING_LIMIT = 1000;
const MAX_ERROR_LENGTH = 500;

function tableFor(entity: SyncEntityKind): string {
  switch (entity) {
    case 'conversation':
      return 'conversations';
    case 'message':
      return 'messages';
    case 'agent':
      return 'agents';
    case 'model':
      return 'models';
    case 'provider':
      return 'providers';
    case 'settings':
      return 'app_settings';
    default:
      throw new DbError('Unsupported sync entity kind.', 'validation');
  }
}

interface PendingCandidate {
  readonly row: DbRow;
  readonly entity: SyncEntityKind;
}

/**
 * Cross-device ordering.
 *
 * `version` alone cannot decide whether a remote record is newer: it is a
 * per-device counter. Every local mutation bumps it — including each streaming
 * flush of one assistant message — so two devices hold unrelated numbers for the
 * same record, and the device that streamed more can carry a higher version with
 * older content. The one signal that does compare across devices is
 * `updated_at`.
 *
 * A remote record is newer when EITHER signal is greater: `version` catches a
 * device whose clock lags, `updated_at` catches a record written later whose
 * counter is lower (for example after the other device pushed at version 2).
 * Requiring both would ignore the lagger's newer content; using only `version`
 * is the defect this replaces.
 *
 * Both timestamps are ISO-8601 UTC strings written by `toISOString()`:
 * fixed-width (24 characters, four-digit year, millisecond precision, always
 * `Z`), so lexicographic order is chronological order. Comparing the strings
 * avoids a Date round-trip and cannot throw; an empty or malformed value simply
 * never counts as newer, which degrades to the version comparison rather than
 * corrupting the decision.
 */
function isRemoteNewer(
  remoteVersion: number,
  localVersion: number,
  remoteUpdatedAt: string,
  localUpdatedAt: string,
): boolean {
  if (remoteVersion > localVersion) return true;
  return remoteUpdatedAt.length > 0 && remoteUpdatedAt > localUpdatedAt;
}

export class SqliteSyncRepository extends BaseRepository implements SyncRepository {
  readonly meta: SyncMetaStore;

  constructor(ctx: DbContext) {
    super(ctx);
    this.meta = {
      get: (key) => this.metaGet(key),
      set: (key, value) => {
        this.metaSet(key, value);
      },
      delete: (key) => {
        this.metaDelete(key);
      },
    };
  }

  pending(limit: number): SyncPendingRow[] {
    const capped = boundedInt(limit, 0, 0, MAX_PENDING_LIMIT);
    if (capped === 0) return [];
    const now = nowIso();

    const candidates: PendingCandidate[] = [];
    for (const entity of SYNC_ENTITY_KINDS) {
      const table = tableFor(entity);
      const rows = this.sql.query<DbRow>(
        `SELECT * FROM ${table}
          WHERE dirty = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY updated_at ASC, id ASC
          LIMIT ?`,
        [now, capped],
      );
      for (const row of rows) candidates.push({ row, entity });
    }

    candidates.sort((left, right) => {
      const byUpdatedAt = str(left.row.updated_at).localeCompare(str(right.row.updated_at));
      if (byUpdatedAt !== 0) return byUpdatedAt;
      const byEntity = left.entity.localeCompare(right.entity);
      if (byEntity !== 0) return byEntity;
      return str(left.row.id).localeCompare(str(right.row.id));
    });

    return candidates.slice(0, capped).map(({ row, entity }) => ({
      entity,
      entityId: str(row.id),
      version: num(row.version, 1),
      op: nullableStr(row.deleted_at) !== null ? 'delete' : 'upsert',
      payload: syncPayloadFor(entity, row),
    }));
  }

  pendingCount(): number {
    let total = 0;
    for (const entity of SYNC_ENTITY_KINDS) {
      const row = this.sql.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${tableFor(entity)} WHERE dirty = 1`,
      );
      total += row === null ? 0 : num(row.n);
    }
    return total;
  }

  markPushed(entity: SyncEntityKind, entityId: string, pushedVersion: number): void {
    // The version guard is the whole point: if a local write landed while the
    // push was in flight, the row is newer than what the server accepted and
    // must stay queued.
    this.sql.run(
      `UPDATE ${tableFor(entity)}
          SET dirty = 0, attempts = 0, next_attempt_at = NULL, last_error = NULL
        WHERE id = ? AND dirty = 1 AND version = ?`,
      [entityId, pushedVersion],
    );
  }

  markFailed(
    entity: SyncEntityKind,
    entityId: string,
    error: string,
    nextAttemptAt: string,
  ): void {
    this.sql.run(
      `UPDATE ${tableFor(entity)}
          SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, dirty = 1
        WHERE id = ?`,
      [nextAttemptAt, error.slice(0, MAX_ERROR_LENGTH), entityId],
    );
  }

  retryNow(entity: SyncEntityKind, entityId: string): void {
    this.sql.run(
      `UPDATE ${tableFor(entity)}
          SET attempts = 0, next_attempt_at = NULL, last_error = NULL, dirty = 1
        WHERE id = ? AND (dirty = 1 OR last_error IS NOT NULL)`,
      [entityId],
    );
  }

  /**
   * Applies a server record. A `conflict` result writes nothing and does not
   * create the conflict row itself: recording is the caller's job via
   * `recordConflict`, because only the sync engine knows a useful summary.
   */
  applyRemote(entity: SyncEntityKind, remote: RemoteEntity): RemoteApplyResult {
    return this.applyRemoteInternal(entity, remote, false);
  }

  recordConflict(input: {
    entity: SyncEntityKind;
    entityId: string;
    localRevision: number;
    remoteRevision: number;
    summary: string;
    remotePayload: unknown;
  }): void {
    tableFor(input.entity);
    if (!Number.isInteger(input.localRevision) || input.localRevision < 0) {
      throw new DbError('A conflict record has an invalid local revision.', 'validation');
    }
    if (!Number.isInteger(input.remoteRevision) || input.remoteRevision < 0) {
      throw new DbError('A conflict record has an invalid remote revision.', 'validation');
    }

    const detectedAt = nowIso();
    const remotePayloadJson = jsonOrNull(input.remotePayload);
    const existing = this.sql.get<{ id: number }>(
      `SELECT id FROM sync_conflicts
        WHERE entity = ? AND entity_id = ? AND resolution = 'unresolved'
        ORDER BY id DESC
        LIMIT 1`,
      [input.entity, input.entityId],
    );
    if (existing !== null) {
      // One unresolved conflict per row: a repeated pull must not grow the list.
      this.sql.run(
        `UPDATE sync_conflicts
            SET local_revision = ?, remote_revision = ?, detected_at = ?, summary = ?,
                remote_payload_json = ?
          WHERE id = ?`,
        [
          input.localRevision,
          input.remoteRevision,
          detectedAt,
          input.summary,
          remotePayloadJson,
          existing.id,
        ],
      );
      return;
    }

    this.sql.run(
      `INSERT INTO sync_conflicts
         (entity, entity_id, local_revision, remote_revision, detected_at, resolution, summary, remote_payload_json)
       VALUES (?, ?, ?, ?, ?, 'unresolved', ?, ?)`,
      [
        input.entity,
        input.entityId,
        input.localRevision,
        input.remoteRevision,
        detectedAt,
        input.summary,
        remotePayloadJson,
      ],
    );
  }

  /** Unresolved conflicts only; a resolved row is history, not UI work. */
  conflicts(): SyncConflict[] {
    const rows = this.sql.query<DbRow>(
      `SELECT * FROM sync_conflicts
        WHERE resolution = 'unresolved'
        ORDER BY detected_at DESC, id DESC`,
    );
    return rows.map((row) => toSyncConflict(row));
  }

  conflictCount(): number {
    const row = this.sql.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolution = 'unresolved'`,
    );
    return row === null ? 0 : num(row.n);
  }

  /**
   * `kept_local` re-queues the local row with a version above the remote one, so
   * the next push wins instead of conflicting forever.
   * `kept_remote` force-applies the payload that was recorded with the conflict.
   * A remote tombstone is carried in the payload's `deletedAt` when the sync
   * engine includes it; the conflict row itself stores only the version numbers.
   */
  resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): void {
    const row = this.sql.get<DbRow>('SELECT * FROM sync_conflicts WHERE id = ?', [id]);
    if (row === null) {
      throw new DbError(`Sync conflict ${id} does not exist.`, 'not_found');
    }
    if (toConflictResolution(row.resolution) !== 'unresolved') return;

    const entity = toSyncEntityKind(row.entity);
    if (entity === null) {
      throw new DbError('A stored sync conflict has an unknown entity kind.', 'storage');
    }
    const entityId = str(row.entity_id);
    const remoteRevision = num(row.remote_revision, 1);
    const payloadJson = nullableStr(row.remote_payload_json);

    this.transaction(() => {
      const updated = this.sql.run(
        `UPDATE sync_conflicts SET resolution = ? WHERE id = ? AND resolution = 'unresolved'`,
        [resolution, id],
      );
      if (updated.changes === 0) return;

      if (resolution === 'kept_local') {
        this.sql.run(
          `UPDATE ${tableFor(entity)}
              SET version = MAX(version + 1, ?), dirty = 1, attempts = 0,
                  next_attempt_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ?`,
          [remoteRevision + 1, nowIso(), entityId],
        );
        return;
      }

      if (payloadJson === null) return;
      const payload = parseJson(payloadJson);
      if (!isRow(payload)) return;

      this.applyRemoteInternal(
        entity,
        {
          id: entityId,
          version: remoteRevision,
          updatedAt: nowIso(),
          deletedAt: nullableStr(payload.deletedAt),
          payload,
        },
        true,
      );
    });
  }

  private applyRemoteInternal(
    entity: SyncEntityKind,
    remote: RemoteEntity,
    force: boolean,
  ): RemoteApplyResult {
    const table = tableFor(entity);
    if (typeof remote.id !== 'string' || remote.id.trim().length === 0) {
      throw new DbError('A remote record has no id.', 'validation');
    }
    if (!Number.isInteger(remote.version) || remote.version < 1) {
      throw new DbError('A remote record has an invalid version.', 'validation');
    }
    if (entity === 'settings' && remote.id !== SETTINGS_ROW_ID) {
      // Settings are one fixed row; a record for another id cannot be applied.
      return 'ignored';
    }
    const payload = remote.payload;
    if (!isRow(payload)) {
      throw new DbError('A remote record payload must be an object.', 'validation');
    }

    const local = this.sql.get<DbRow>(`SELECT * FROM ${table} WHERE id = ?`, [remote.id]);
    if (local !== null && !force) {
      const remoteIsNewer = isRemoteNewer(
        remote.version,
        num(local.version, 1),
        str(remote.updatedAt).trim(),
        str(local.updated_at),
      );
      // Same or older on both signals is an idempotent duplicate: relayed twice,
      // or already pushed and pulled back.
      if (!remoteIsNewer) return 'ignored';
      // Never overwrite unsynchronised local work. The caller records the
      // conflict; this layer writes nothing and leaves `dirty = 1` so the row
      // stays in the outbox until the user decides.
      if (bool(local.dirty, false)) return 'conflict';
    }

    this.writeRemote(entity, remote, payload, local);
    return 'applied';
  }

  private writeRemote(
    entity: SyncEntityKind,
    remote: RemoteEntity,
    payload: DbRow,
    local: DbRow | null,
  ): void {
    const table = tableFor(entity);
    const columns = this.remoteColumns(entity, payload, local);
    const candidateUpdatedAt = str(remote.updatedAt).trim();
    const updatedAt = candidateUpdatedAt.length > 0 ? candidateUpdatedAt : nowIso();
    const deletedAt = nullableStr(remote.deletedAt);

    if (local === null) {
      const candidateCreatedAt = str(payload.createdAt).trim();
      const createdAt = candidateCreatedAt.length > 0 ? candidateCreatedAt : updatedAt;
      const names = [
        'id',
        ...columns.map(([name]) => name),
        'version',
        'dirty',
        'attempts',
        'next_attempt_at',
        'last_error',
        'created_at',
        'updated_at',
        'deleted_at',
      ];
      const values: SqlValue[] = [
        remote.id,
        ...columns.map(([, value]) => value),
        remote.version,
        0,
        0,
        null,
        null,
        createdAt,
        updatedAt,
        deletedAt,
      ];
      this.sql.run(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        values,
      );
      return;
    }

    // A remote apply never touches `created_at`: the local creation time is the
    // one fact a pull must not rewrite.
    const assignments = [
      ...columns.map(([name]) => `${name} = ?`),
      'version = ?',
      'dirty = 0',
      'attempts = 0',
      'next_attempt_at = NULL',
      'last_error = NULL',
      'updated_at = ?',
      'deleted_at = ?',
    ];
    const values: SqlValue[] = [
      ...columns.map(([, value]) => value),
      remote.version,
      updatedAt,
      deletedAt,
      remote.id,
    ];
    this.sql.run(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`, values);
  }

  /** Column set per entity; names are code constants, values are always bound. */
  private remoteColumns(
    entity: SyncEntityKind,
    payload: DbRow,
    local: DbRow | null,
  ): ReadonlyArray<readonly [string, SqlValue]> {
    switch (entity) {
      case 'conversation': {
        const title = str(payload.title).trim();
        return [
          ['title', title.length > 0 ? title : DEFAULT_CONVERSATION_TITLE],
          ['agent_id', nullableStr(payload.agentId)],
          ['provider_id', nullableStr(payload.providerId)],
          ['model_id', nullableStr(payload.modelId)],
          ['system_prompt', nullableStr(payload.systemPrompt)],
          ['params_override_json', jsonOrNull(toGenerationParams(payload.paramsOverride))],
        ];
      }
      case 'message': {
        const conversationId = nullableStr(payload.conversationId);
        if (conversationId === null || conversationId.length === 0) {
          throw new DbError(
            'A remote message payload is missing conversationId.',
            'validation',
          );
        }
        const localSeq = local === null ? null : toSeq(local.seq);
        const seq = toSeq(payload.seq) ?? localSeq ?? this.nextSeqFor(conversationId);
        return [
          ['conversation_id', conversationId],
          ['role', toMessageRole(payload.role)],
          ['content', str(payload.content)],
          ['seq', seq],
          ['status', toMessageStatus(payload.status)],
          ['error_json', jsonOrNull(toAppErrorShape(payload.error))],
          ['usage_json', jsonOrNull(toTokenUsage(payload.usage))],
          ['model_json', jsonOrNull(toModelRef(payload.modelRef))],
        ];
      }
      case 'agent': {
        const name = str(payload.name).trim();
        return [
          ['name', name.length > 0 ? name : 'Agent'],
          ['description', str(payload.description)],
          ['provider_id', nullableStr(payload.providerId)],
          ['model_id', nullableStr(payload.modelId)],
          ['system_prompt', str(payload.systemPrompt)],
          ['params_json', jsonOrNull(toGenerationParams(payload.params) ?? {})],
        ];
      }
      case 'model': {
        const providerId = nullableStr(payload.providerId);
        const modelId = nullableStr(payload.modelId);
        if (providerId === null || providerId.length === 0) {
          throw new DbError('A remote model payload is missing providerId.', 'validation');
        }
        if (modelId === null || modelId.length === 0) {
          throw new DbError('A remote model payload is missing modelId.', 'validation');
        }
        const displayName = str(payload.displayName).trim();
        return [
          ['provider_id', providerId],
          ['model_id', modelId],
          ['display_name', displayName.length > 0 ? displayName : modelId],
          ['source', toModelSource(payload.source)],
          ['capabilities_json', JSON.stringify(toModelCapabilities(payload.capabilities))],
          ['limits_json', JSON.stringify(toModelLimits(payload.limits))],
          ['supported_params_json', JSON.stringify(toGenParamKeys(payload.supportedParams))],
          ['weirdness_supported', bool(payload.weirdnessSupported, false) ? 1 : 0],
          ['base_url_override', nullableStr(payload.baseUrlOverride)],
          ['description', str(payload.description)],
        ];
      }
      case 'provider': {
        const name = str(payload.name).trim();
        return [
          ['kind', toProviderKind(payload.kind)],
          ['name', name],
          ['base_url', str(payload.baseUrl)],
          ['enabled', bool(payload.enabled, true) ? 1 : 0],
          ['key_fingerprint', nullableStr(payload.keyFingerprint)],
          ['key_updated_at', nullableStr(payload.keyUpdatedAt)],
        ];
      }
      case 'settings': {
        const settingsSource = isRow(payload.settings) ? payload.settings : payload;
        return [['json', JSON.stringify(normaliseSettings(settingsSource))]];
      }
      default:
        throw new DbError('Unsupported sync entity kind.', 'validation');
    }
  }

  private nextSeqFor(conversationId: string): number {
    const row = this.sql.get<{ next_seq: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?',
      [conversationId],
    );
    return row === null ? 1 : Math.max(1, num(row.next_seq, 1));
  }

  private metaGet(key: string): string | null {
    const row = this.sql.get<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
    return row === null ? null : str(row.value);
  }

  private metaSet(key: string, value: string): void {
    this.sql.run(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  private metaDelete(key: string): void {
    this.sql.run('DELETE FROM sync_meta WHERE key = ?', [key]);
  }
}
