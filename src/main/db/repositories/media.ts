/**
 * Generated media and generation-job repositories.
 *
 * Both are local-only: no `dirty`, no `version`, no tombstones, because generated
 * media is never pushed to the cloud. Reads are tolerant (a corrupt `params_json`
 * becomes `{}` rather than failing a listing) and writes are explicit about every
 * column, so the schema is the only source of truth about what a row holds.
 */
import type {
  GenerationJobRepository,
  JobPatch,
  MediaListFilter,
  MediaRepository,
  NewJobInput,
  NewMediaInput,
  SqlValue,
} from '../../../shared/repository-contract';
import type { GenerationJob, GenerationJobStatus, GenerationMedia, MediaKind, MediaParams } from '../../../shared/media';
import { JOB_STATUSES } from '../../../shared/media';
import { bool, isRow, jsonOrNull, newId, nowIso, nullableNum, nullableStr, num, parseJson, parseJsonObject, pickOneOf, str, stringArray } from '../codec';
import type { DbRow } from '../codec';
import { DbError } from '../errors';
import { boundedInt } from '../codec';
import { BaseRepository } from './base';

const MEDIA_COLUMNS = `id, kind, provider_id, model_id, prompt, negative_prompt, params_json,
  width, height, duration_ms, bytes, sha256, mime, relative_path, conversation_id, message_id,
  job_id, provider_job_id, created_at`;

const JOB_COLUMNS = `id, task, provider_id, model_id, status, progress, prompt, params_json,
  remote_id, poll_url, error_code, error_message, retryable, attempts, next_poll_at, media_id,
  reference_ids, mask_media_id, conversation_id, message_id, created_at, updated_at, finished_at`;

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video'];

/** A JSON document of scalar values, when the stored one is still shaped that way. */
function toParams(value: unknown): MediaParams {
  const row = parseJsonObject(value);
  if (!row) return {};
  const params: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(row)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      params[key] = entry;
    } else if (entry === null) {
      params[key] = null;
    }
  }
  return params;
}

export function toGenerationMedia(row: DbRow): GenerationMedia {
  return {
    id: str(row.id),
    kind: pickOneOf(row.kind, MEDIA_KINDS, 'image'),
    providerId: str(row.provider_id),
    modelId: str(row.model_id),
    prompt: str(row.prompt),
    negativePrompt: nullableStr(row.negative_prompt),
    params: toParams(row.params_json),
    width: nullableNum(row.width),
    height: nullableNum(row.height),
    durationMs: nullableNum(row.duration_ms),
    bytes: num(row.bytes),
    sha256: str(row.sha256),
    mime: str(row.mime, 'application/octet-stream'),
    relativePath: str(row.relative_path),
    conversationId: nullableStr(row.conversation_id),
    messageId: nullableStr(row.message_id),
    jobId: nullableStr(row.job_id),
    providerJobId: nullableStr(row.provider_job_id),
    createdAt: str(row.created_at),
  };
}

export function toGenerationJob(row: DbRow): GenerationJob {
  return {
    id: str(row.id),
    task: pickOneOf(row.task, MEDIA_KINDS, 'image'),
    providerId: str(row.provider_id),
    modelId: str(row.model_id),
    status: pickOneOf<GenerationJobStatus>(row.status, JOB_STATUSES, 'queued'),
    progress: nullableNum(row.progress),
    prompt: str(row.prompt),
    params: toParams(row.params_json),
    remoteId: nullableStr(row.remote_id),
    pollUrl: nullableStr(row.poll_url),
    errorCode: nullableStr(row.error_code),
    errorMessage: nullableStr(row.error_message),
    retryable: bool(row.retryable),
    attempts: num(row.attempts),
    nextPollAt: nullableStr(row.next_poll_at),
    mediaId: nullableStr(row.media_id),
    referenceMediaIds: stringArray(parseJson(row.reference_ids)),
    maskMediaId: nullableStr(row.mask_media_id),
    conversationId: nullableStr(row.conversation_id),
    messageId: nullableStr(row.message_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    finishedAt: nullableStr(row.finished_at),
  };
}

export class SqliteMediaRepository extends BaseRepository implements MediaRepository {
  insert(input: NewMediaInput): GenerationMedia {
    if (input.relativePath.trim().length === 0) {
      throw new DbError('A media row needs a relative path.', 'storage');
    }
    const id = input.id ?? newId();
    const createdAt = input.createdAt ?? nowIso();
    this.sql.run(
      `INSERT INTO media (${MEDIA_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.providerId,
        input.modelId,
        input.prompt,
        input.negativePrompt ?? null,
        jsonOrNull(input.params),
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        input.bytes,
        input.sha256,
        input.mime,
        input.relativePath,
        input.conversationId ?? null,
        input.messageId ?? null,
        input.jobId ?? null,
        input.providerJobId ?? null,
        createdAt,
      ],
    );
    const created = this.get(id);
    if (!created) throw new DbError('The media row could not be read back after insert.', 'storage');
    return created;
  }

  get(id: string): GenerationMedia | null {
    const [row] = this.sql.query<DbRow>(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ?`, [id]);
    return row ? toGenerationMedia(row) : null;
  }

  list(filter: MediaListFilter = {}): GenerationMedia[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    const limit = boundedInt(filter.limit, 200, 1, 1000);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.sql.query<DbRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media ${where} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((row) => toGenerationMedia(row));
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.sql.run('DELETE FROM media WHERE id = ?', [id]);
    return true;
  }

  totalBytes(): number {
    const [row] = this.sql.query<DbRow>('SELECT COALESCE(SUM(bytes), 0) AS total FROM media');
    return row ? num(row.total) : 0;
  }
}

export class SqliteGenerationJobRepository extends BaseRepository implements GenerationJobRepository {
  insert(input: NewJobInput): GenerationJob {
    const id = input.id ?? newId();
    const now = nowIso();
    this.sql.run(
      `INSERT INTO generation_jobs (${JOB_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.task,
        input.providerId,
        input.modelId,
        'queued',
        null,
        input.prompt,
        jsonOrNull(input.params),
        null,
        null,
        null,
        null,
        0,
        0,
        now,
        null,
        jsonOrNull(input.referenceMediaIds ?? []),
        input.maskMediaId ?? null,
        input.conversationId ?? null,
        input.messageId ?? null,
        now,
        now,
        null,
      ],
    );
    const created = this.get(id);
    if (!created) throw new DbError('The job row could not be read back after insert.', 'storage');
    return created;
  }

  get(id: string): GenerationJob | null {
    const [row] = this.sql.query<DbRow>(`SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE id = ?`, [id]);
    return row ? toGenerationJob(row) : null;
  }

  update(id: string, patch: JobPatch): GenerationJob | null {
    const existing = this.get(id);
    if (!existing) return null;

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const set = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.status !== undefined) set('status', patch.status);
    if (patch.progress !== undefined) set('progress', patch.progress);
    if (patch.remoteId !== undefined) set('remote_id', patch.remoteId);
    if (patch.pollUrl !== undefined) set('poll_url', patch.pollUrl);
    if (patch.errorCode !== undefined) set('error_code', patch.errorCode);
    if (patch.errorMessage !== undefined) set('error_message', patch.errorMessage);
    if (patch.retryable !== undefined) set('retryable', patch.retryable ? 1 : 0);
    if (patch.attempts !== undefined) set('attempts', patch.attempts);
    if (patch.nextPollAt !== undefined) set('next_poll_at', patch.nextPollAt);
    if (patch.mediaId !== undefined) set('media_id', patch.mediaId);
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);

    set('updated_at', patch.updatedAt ?? nowIso());
    this.sql.run(`UPDATE generation_jobs SET ${assignments.join(', ')} WHERE id = ?`, [...params, id]);
    return this.get(id);
  }

  listActive(): GenerationJob[] {
    const rows = this.sql.query<DbRow>(
      `SELECT ${JOB_COLUMNS} FROM generation_jobs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC`,
    );
    return rows.map((row) => toGenerationJob(row));
  }

  listRecent(limit = 50): GenerationJob[] {
    const rows = this.sql.query<DbRow>(
      `SELECT ${JOB_COLUMNS} FROM generation_jobs ORDER BY created_at DESC LIMIT ?`,
      [boundedInt(limit, 50, 1, 500)],
    );
    return rows.map((row) => toGenerationJob(row));
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.sql.run('DELETE FROM generation_jobs WHERE id = ?', [id]);
    return true;
  }
}

/** True when the value is a usable row (used by tests that decode fixtures). */
export function isJobRow(value: unknown): boolean {
  return isRow(value);
}
