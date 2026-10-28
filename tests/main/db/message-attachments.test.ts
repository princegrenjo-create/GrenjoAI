/**
 * Message attachment persistence.
 *
 * The hard guarantee under test: a conversation written before attachments
 * existed keeps working, and an old message reads back as `attachments: []`
 * rather than `undefined`, `null` or a parse error. Corrupt JSON degrades the
 * same way, because a bad column value must not make history unreadable.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@shared/attachments';
import { openDatabase } from '@main/db/index';
import { SqliteConnection } from '@main/db/connection';
import { createSilentDbLogger } from '@main/db/log';
import { INITIAL_SCHEMA_SQL } from '@main/db/migrations/001-initial-schema';
import { LATEST_SCHEMA_VERSION, TestDatabase } from './helpers';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

const ATTACHMENT: MessageAttachment = {
  id: 'att-1',
  kind: 'image',
  name: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 1234,
  contentStatus: 'extracted',
  contentNote: null,
  extractedChars: null,
  sentToProvider: true,
  imageWidth: 640,
  imageHeight: 480,
  durationMs: null,
  createdAt: '2026-10-29T00:00:00.000Z',
};

describe('message attachments column', () => {
  it('stores attachment metadata as JSON and reads it back on the domain object', () => {
    const conversation = t.db.conversations.create({ title: 'Attachments' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'What is in this picture?',
      attachments: [ATTACHMENT],
    });

    expect(message.attachments).toEqual([ATTACHMENT]);

    const raw = t.db.sql.get<{ attachments: string }>(
      'SELECT attachments FROM messages WHERE id = ?',
      [message.id],
    );
    expect(typeof raw?.attachments).toBe('string');
    expect(JSON.parse(raw?.attachments ?? 'null')).toEqual([ATTACHMENT]);

    expect(t.db.messages.get(message.id)?.attachments).toEqual([ATTACHMENT]);
    expect(t.db.messages.listByConversation(conversation.id)[0]?.attachments).toEqual([ATTACHMENT]);
  });

  it('defaults to an empty list for a message appended without attachments', () => {
    const conversation = t.db.conversations.create({ title: 'No attachments' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'plain message',
    });
    expect(message.attachments).toEqual([]);

    const raw = t.db.sql.get<{ attachments: string }>(
      'SELECT attachments FROM messages WHERE id = ?',
      [message.id],
    );
    expect(raw?.attachments).toBe('[]');
  });

  it('updates attachments when a patch carries them, and leaves them alone otherwise', () => {
    const conversation = t.db.conversations.create({ title: 'Patch' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'first',
    });

    const withAttachment = t.db.messages.update(message.id, { attachments: [ATTACHMENT] });
    expect(withAttachment.attachments).toEqual([ATTACHMENT]);

    const contentOnly = t.db.messages.update(message.id, { content: 'edited' });
    expect(contentOnly.attachments).toEqual([ATTACHMENT]);

    const cleared = t.db.messages.update(message.id, { attachments: [] });
    expect(cleared.attachments).toEqual([]);
  });

  it('reads corrupt JSON as an empty list instead of failing the message', () => {
    const conversation = t.db.conversations.create({ title: 'Corrupt' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'survives a corrupt column',
    });
    t.db.sql.run('UPDATE messages SET attachments = ? WHERE id = ?', [
      '{not valid json',
      message.id,
    ]);

    const restored = t.db.messages.get(message.id);
    expect(restored?.attachments).toEqual([]);
    expect(restored?.content).toBe('survives a corrupt column');
  });

  it('skips corrupt entries and invalid kinds while keeping valid ones', () => {
    const conversation = t.db.conversations.create({ title: 'Mixed' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'mixed',
    });
    t.db.sql.run('UPDATE messages SET attachments = ? WHERE id = ?', [
      JSON.stringify([
        null,
        42,
        { id: 'ok', kind: 'text', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, contentStatus: 'extracted', sentToProvider: true },
        { kind: 'image', name: 'no id' },
      ]),
      message.id,
    ]);

    const restored = t.db.messages.get(message.id);
    expect(restored?.attachments).toHaveLength(1);
    expect(restored?.attachments[0]?.id).toBe('ok');
    expect(restored?.attachments[0]?.contentNote).toBeNull();
    expect(restored?.attachments[0]?.imageWidth).toBeNull();
  });
});

describe('migration 2 on an existing database', () => {
  it('adds the column to a database that already holds messages and defaults them to []', () => {
    const scratch: ScratchDir = scratchDir('attachments-migration');
    const filePath = path.join(scratch.path, 'pre-migration.db');

    // Build the schema exactly as version 1 left it, with one chat message.
    const connection = new SqliteConnection(filePath, { logger: createSilentDbLogger() });
    try {
      connection.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      connection.exec(INITIAL_SCHEMA_SQL);
      connection.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [1, 'initial-schema', '2026-10-01T00:00:00.000Z'],
      );
      connection.run(
        'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
        ['c-old', 'Old chat', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      );
      connection.run(
        `INSERT INTO messages (id, conversation_id, role, content, seq, status, created_at, updated_at)
         VALUES (?, ?, 'user', ?, 1, 'complete', ?, ?)`,
        [
          'm-old',
          'c-old',
          'A question written before attachments existed',
          '2026-10-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z',
        ],
      );
    } finally {
      connection.close();
    }

    const db = openDatabase(filePath);
    try {
      expect(db.migrations.version()).toBe(LATEST_SCHEMA_VERSION);
      expect(db.migrations.history().map((entry) => entry.name)).toContain('message-attachments');

      const restored = db.messages.get('m-old');
      expect(restored).not.toBeNull();
      expect(restored?.attachments).toEqual([]);
      expect(restored?.content).toBe('A question written before attachments existed');
      expect(restored?.role).toBe('user');
      expect(restored?.seq).toBe(1);

      const raw = db.sql.get<{ attachments: string }>(
        'SELECT attachments FROM messages WHERE id = ?',
        ['m-old'],
      );
      expect(raw?.attachments).toBe('[]');

      const appended = db.messages.append({
        conversationId: 'c-old',
        role: 'assistant',
        content: 'A reply written after the migration',
      });
      expect(appended.attachments).toEqual([]);
    } finally {
      db.close();
      scratch.cleanup();
    }
  });
});
