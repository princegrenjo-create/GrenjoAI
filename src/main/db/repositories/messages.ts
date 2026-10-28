/**
 * Message repository.
 *
 * `seq` is the per-conversation ordering key and is computed inside the writing
 * transaction as `COALESCE(MAX(seq), 0) + 1`. It is never taken from a cached
 * counter: the counter would survive a failed write and skip a number, and two
 * writes in the same tick must not agree on the same value. The
 * `UNIQUE (conversation_id, seq)` constraint is the backstop if the invariant is
 * ever broken.
 *
 * Streaming is intentionally not modelled as many tiny rows: the caller appends
 * once with `status: 'streaming'` and updates `content`/`status` as the stream
 * advances, so one assistant turn stays one row.
 */
import type {
  AppendMessageInput,
  MessagePatch,
  MessageRepository,
  SqlValue,
  WriteOptions,
} from '../../../shared/repository-contract';
import type { ChatMessage, Id } from '../../../shared/types';
import { jsonOrNull, newId, nowIso, type DbRow } from '../codec';
import { DbError } from '../errors';
import { toChatMessage } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

const MESSAGE_COLUMNS = `id, conversation_id, role, content, seq, status, error_json, usage_json, model_json,
  attachments, version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at`;

export class SqliteMessageRepository extends BaseRepository implements MessageRepository {
  listByConversation(conversationId: Id): ChatMessage[] {
    const rows = this.sql.query<DbRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages
        WHERE conversation_id = ? AND deleted_at IS NULL
        ORDER BY seq ASC`,
      [conversationId],
    );
    return rows.map((row) => toChatMessage(row));
  }

  get(id: Id): ChatMessage | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row === null ? null : toChatMessage(row);
  }

  append(input: AppendMessageInput, options?: WriteOptions): ChatMessage {
    return this.transaction(() => {
      const conversation = this.sql.get<{ id: string }>(
        'SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL',
        [input.conversationId],
      );
      if (conversation === null) {
        throw new DbError(`Conversation ${input.conversationId} does not exist.`, 'not_found');
      }

      const seqRow = this.sql.get<{ next_seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?',
        [input.conversationId],
      );
      const seq = seqRow === null ? 1 : Math.max(1, seqRow.next_seq);

      const id = newId();
      const now = nowIso();
      // Attachment metadata is JSON, never bytes: history stays small and the
      // profile folder stays movable. `[]` is the explicit default, matching the
      // column default migration 2 installs.
      const attachments = JSON.stringify(input.attachments ?? []);
      this.sql.run(
        `INSERT INTO messages
           (id, conversation_id, role, content, seq, status, error_json, usage_json, model_json,
            attachments, version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, 0, NULL, NULL, ?, ?, NULL)`,
        [
          id,
          input.conversationId,
          input.role,
          input.content,
          seq,
          input.status ?? 'complete',
          jsonOrNull(input.modelRef ?? null),
          attachments,
          dirtyFlag(options),
          now,
          now,
        ],
      );

      const created = this.get(id);
      if (created === null) {
        throw new DbError('The appended message could not be read back.', 'storage');
      }
      return created;
    });
  }

  update(id: Id, patch: MessagePatch, options?: WriteOptions): ChatMessage {
    if (this.get(id) === null) {
      throw new DbError(`Message ${id} does not exist.`, 'not_found');
    }

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    if (patch.content !== undefined) {
      assignments.push('content = ?');
      params.push(patch.content);
    }
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      params.push(patch.status);
    }
    if (patch.error !== undefined) {
      assignments.push('error_json = ?');
      params.push(jsonOrNull(patch.error));
    }
    if (patch.usage !== undefined) {
      assignments.push('usage_json = ?');
      params.push(jsonOrNull(patch.usage));
    }
    if (patch.attachments !== undefined) {
      assignments.push('attachments = ?');
      params.push(JSON.stringify(patch.attachments));
    }
    assignments.push('version = version + 1', 'updated_at = ?', 'dirty = ?');
    params.push(nowIso(), dirtyFlag(options), id);

    this.sql.run(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`, params);

    const updated = this.get(id);
    if (updated === null) {
      throw new DbError(`Message ${id} disappeared while updating.`, 'storage');
    }
    return updated;
  }

  deleteByConversation(conversationId: Id): void {
    this.sql.run('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
  }

  countByConversation(conversationId: Id): number {
    const row = this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND deleted_at IS NULL',
      [conversationId],
    );
    return row === null ? 0 : row.n;
  }
}
