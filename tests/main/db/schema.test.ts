import { existsSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError, openDatabase } from '@main/db/index';
import { PAST, TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

describe('schema and connection', () => {
  it('creates the full schema on a fresh file and records version 1', () => {
    expect(t.db.migrations.version()).toBe(1);

    const history = t.db.migrations.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe(1);
    expect(history[0]?.name).toBe('initial-schema');
    expect(history[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('creates every table the repositories need', () => {
    const rows = t.db.sql.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      'agents',
      'app_settings',
      'conversations',
      'messages',
      'models',
      'providers',
      'schema_migrations',
      'sync_conflicts',
      'sync_meta',
    ]);
  });

  it('applies the WAL, foreign-key, busy-timeout and synchronous pragmas', () => {
    expect(t.db.sql.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(t.db.sql.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(t.db.sql.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
    // synchronous = NORMAL is the numeric value 1.
    expect(t.db.sql.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous).toBe(1);
  });

  it('is a no-op when the migration runner runs again on an up-to-date file', () => {
    expect(t.db.migrations.version()).toBe(1);
    t.db.close();

    const reopened = openDatabase(t.filePath);
    try {
      expect(reopened.migrations.version()).toBe(1);
      expect(reopened.migrations.history()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('preserves rows across a close and re-open', () => {
    const conversation = t.db.conversations.create({ title: 'Survives a restart' });
    t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'Still here?',
    });

    t.reopen();

    const restored = t.db.conversations.get(conversation.id);
    expect(restored?.title).toBe('Survives a restart');
    const messages = t.db.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Still here?');
  });

  it('rejects a database whose schema is newer than this build understands', () => {
    t.db.sql.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
      99,
      'from-a-future-build',
      PAST,
    ]);
    t.db.close();

    expect(() => openDatabase(t.filePath)).toThrow(DbError);
  });

  it('enforces the message -> conversation foreign key', () => {
    expect(() =>
      t.db.sql.run(
        `INSERT INTO messages (id, conversation_id, role, content, seq, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['m-orphan', 'missing-conversation', 'user', 'hi', 1, 'complete', PAST, PAST],
      ),
    ).toThrow(DbError);
  });

  it('cascades a hard conversation delete to its messages', () => {
    const conversation = t.db.conversations.create({ title: 'Cascade' });
    t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'one' });
    expect(t.db.messages.countByConversation(conversation.id)).toBe(1);

    t.db.sql.run('DELETE FROM conversations WHERE id = ?', [conversation.id]);

    expect(t.db.messages.countByConversation(conversation.id)).toBe(0);
  });

  it('checkpoints the write-ahead log', () => {
    t.db.conversations.create({ title: 'WAL write' });
    const walPath = `${t.filePath}-wal`;
    expect(existsSync(walPath)).toBe(true);

    t.db.checkpoint();

    expect(statSync(walPath).size).toBe(0);
  });

  it('throws a DbError after close and tolerates a second close', () => {
    t.db.close();
    expect(() => t.db.sql.get('SELECT 1')).toThrow(DbError);
    expect(() => t.db.close()).not.toThrow();
  });
});
