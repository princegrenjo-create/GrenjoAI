/**
 * Conversation repository.
 *
 * Search is `LIKE`-based rather than FTS5: the corpus is small, FTS needs a
 * shadow table and triggers that can drift from the content, and `LIKE` is
 * case-insensitive for ASCII out of the box. The search term is escaped so a
 * literal `%` or `_` in the query cannot turn into a wildcard.
 *
 * Soft delete keeps the row and its `deleted_at`, which is what lets a deletion
 * synchronise. `list`/`get`/`count` exclude it; the tombstone stays `dirty = 1`
 * until the push succeeds.
 */
import type {
  ConversationListOptions,
  ConversationRepository,
  SqlValue,
  WriteOptions,
} from '../../../shared/repository-contract';
import type { Conversation, ConversationCreateInput, ConversationPatch, Id } from '../../../shared/types';
import { boundedInt, escapeLike, jsonOrNull, newId, nowIso, type DbRow } from '../codec';
import { DEFAULT_CONVERSATION_TITLE } from '../constants';
import { DbError } from '../errors';
import { toConversation } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

/** Derived view columns every conversation read shares. */
const CONVERSATION_COLUMNS = `c.*,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count,
  (SELECT COUNT(*) FROM sync_conflicts sc
     WHERE sc.entity = 'conversation' AND sc.entity_id = c.id AND sc.resolution = 'unresolved') AS has_conflict`;

const DEFAULT_LIST_LIMIT = 200;

function normaliseTitle(title: string | undefined): string {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  return trimmed.length === 0 ? DEFAULT_CONVERSATION_TITLE : trimmed;
}

export class SqliteConversationRepository extends BaseRepository implements ConversationRepository {
  list(options: ConversationListOptions = {}): Conversation[] {
    const limit = boundedInt(options.limit, DEFAULT_LIST_LIMIT, 1, 1000);
    const offset = boundedInt(options.offset, 0, 0, 1_000_000);
    const term = typeof options.search === 'string' ? options.search.trim() : '';
    const pattern = term.length === 0 ? null : `%${escapeLike(term)}%`;

    const rows = this.sql.query<DbRow>(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM conversations c
        WHERE c.deleted_at IS NULL
          AND (? IS NULL
               OR c.title LIKE ? ESCAPE '\\'
               OR EXISTS (
                    SELECT 1 FROM messages sm
                     WHERE sm.conversation_id = c.id
                       AND sm.deleted_at IS NULL
                       AND sm.content LIKE ? ESCAPE '\\'
                  ))
        ORDER BY c.updated_at DESC, c.created_at DESC, c.id ASC
        LIMIT ? OFFSET ?`,
      [pattern, pattern, pattern, limit, offset],
    );
    return rows.map((row) => toConversation(row));
  }

  get(id: Id): Conversation | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = ? AND c.deleted_at IS NULL`,
      [id],
    );
    return row === null ? null : toConversation(row);
  }

  create(input: ConversationCreateInput, options?: WriteOptions): Conversation {
    const id = newId();
    const now = nowIso();
    this.sql.run(
      `INSERT INTO conversations
         (id, title, agent_id, provider_id, model_id, system_prompt, params_override_json,
          version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, NULL, ?, ?, NULL)`,
      [
        id,
        normaliseTitle(input.title),
        input.agentId ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        input.systemPrompt ?? null,
        null,
        dirtyFlag(options),
        now,
        now,
      ],
    );
    return this.require(id);
  }

  update(id: Id, patch: ConversationPatch, options?: WriteOptions): Conversation {
    this.require(id);

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    if (patch.title !== undefined) {
      assignments.push('title = ?');
      params.push(normaliseTitle(patch.title));
    }
    if (patch.agentId !== undefined) {
      assignments.push('agent_id = ?');
      params.push(patch.agentId);
    }
    if (patch.providerId !== undefined) {
      assignments.push('provider_id = ?');
      params.push(patch.providerId);
    }
    if (patch.modelId !== undefined) {
      assignments.push('model_id = ?');
      params.push(patch.modelId);
    }
    if (patch.systemPrompt !== undefined) {
      assignments.push('system_prompt = ?');
      params.push(patch.systemPrompt);
    }
    if (patch.paramsOverride !== undefined) {
      assignments.push('params_override_json = ?');
      params.push(jsonOrNull(patch.paramsOverride));
    }
    assignments.push('version = version + 1', 'updated_at = ?', 'dirty = ?');
    params.push(nowIso(), dirtyFlag(options), id);

    this.sql.run(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, params);
    return this.require(id);
  }

  touch(id: Id, options?: WriteOptions): void {
    this.sql.run(
      `UPDATE conversations
          SET version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [nowIso(), dirtyFlag(options), id],
    );
  }

  softDelete(id: Id, options?: WriteOptions): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE conversations
          SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [now, now, dirtyFlag(options), id],
    );
  }

  restore(id: Id): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE conversations
          SET deleted_at = NULL, version = version + 1, updated_at = ?, dirty = 1
        WHERE id = ? AND deleted_at IS NOT NULL`,
      [now, id],
    );
  }

  count(): number {
    const row = this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL',
    );
    return row === null ? 0 : row.n;
  }

  autoTitle(id: Id, title: string): void {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    this.sql.run(
      `UPDATE conversations
          SET title = ?, version = version + 1, updated_at = ?, dirty = 1
        WHERE id = ?
          AND deleted_at IS NULL
          AND (title = ? OR title = '')`,
      [trimmed, nowIso(), id, DEFAULT_CONVERSATION_TITLE],
    );
  }

  private require(id: Id): Conversation {
    const conversation = this.get(id);
    if (conversation === null) {
      throw new DbError(`Conversation ${id} does not exist.`, 'not_found');
    }
    return conversation;
  }
}
