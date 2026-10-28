import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@main/db/index';
import { TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

function rawMessage(id: string): Record<string, unknown> | null {
  return t.db.sql.get<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', [id]);
}

describe('messages', () => {
  it('assigns a monotonic per-conversation seq starting at 1', () => {
    const conversation = t.db.conversations.create({ title: 'Seq' });

    const first = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'first',
    });
    const second = t.db.messages.append({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'second',
    });
    const third = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'third',
    });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(t.db.messages.listByConversation(conversation.id).map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps seq independent per conversation', () => {
    const left = t.db.conversations.create({ title: 'Left' });
    const right = t.db.conversations.create({ title: 'Right' });

    const leftFirst = t.db.messages.append({
      conversationId: left.id,
      role: 'user',
      content: 'L1',
    });
    const rightFirst = t.db.messages.append({
      conversationId: right.id,
      role: 'user',
      content: 'R1',
    });
    const leftSecond = t.db.messages.append({
      conversationId: left.id,
      role: 'user',
      content: 'L2',
    });

    expect([leftFirst.seq, rightFirst.seq, leftSecond.seq]).toEqual([1, 1, 2]);
  });

  it('computes seq inside the writing transaction for interleaved appends', () => {
    const left = t.db.conversations.create({ title: 'Left' });
    const right = t.db.conversations.create({ title: 'Right' });

    t.db.transaction(() => {
      t.db.messages.append({ conversationId: left.id, role: 'user', content: 'L1' });
      t.db.messages.append({ conversationId: right.id, role: 'user', content: 'R1' });
      t.db.messages.append({ conversationId: left.id, role: 'assistant', content: 'L2' });
      t.db.messages.append({ conversationId: right.id, role: 'assistant', content: 'R2' });
      t.db.messages.append({ conversationId: left.id, role: 'user', content: 'L3' });
    });

    const leftSeq = t.db.messages.listByConversation(left.id).map((message) => message.seq);
    const rightSeq = t.db.messages.listByConversation(right.id).map((message) => message.seq);
    expect(leftSeq).toEqual([1, 2, 3]);
    expect(rightSeq).toEqual([1, 2]);
  });

  it('persists role, status, usage, error and model reference', () => {
    const conversation = t.db.conversations.create({ title: 'Fields' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'partial',
      status: 'streaming',
      modelRef: { providerId: 'provider-1', modelId: 'deepseek-chat' },
    });

    expect(message.role).toBe('assistant');
    expect(message.status).toBe('streaming');
    expect(message.modelRef).toEqual({ providerId: 'provider-1', modelId: 'deepseek-chat' });

    const updated = t.db.messages.update(message.id, {
      content: 'complete answer',
      status: 'complete',
      usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
      error: null,
    });

    expect(updated.content).toBe('complete answer');
    expect(updated.status).toBe('complete');
    expect(updated.usage).toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 });
    expect(updated.error).toBeNull();
    expect(rawMessage(message.id)?.version).toBe(2);
  });

  it('stores an error shape on a failed assistant turn', () => {
    const conversation = t.db.conversations.create({ title: 'Failure' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'error',
    });

    const updated = t.db.messages.update(message.id, {
      error: { code: 'rate_limited', message: 'Slow down', retryable: true, status: 429 },
    });

    expect(updated.error).toEqual({
      code: 'rate_limited',
      message: 'Slow down',
      retryable: true,
      status: 429,
    });
  });

  it('defaults the status to complete', () => {
    const conversation = t.db.conversations.create({ title: 'Default status' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'hi',
    });
    expect(message.status).toBe('complete');
  });

  it('rejects an append to a missing conversation', () => {
    expect(() =>
      t.db.messages.append({ conversationId: 'missing', role: 'user', content: 'hi' }),
    ).toThrow(DbError);
  });

  it('rejects an append to a soft-deleted conversation', () => {
    const conversation = t.db.conversations.create({ title: 'Gone' });
    t.db.conversations.softDelete(conversation.id);

    expect(() =>
      t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'hi' }),
    ).toThrow(DbError);
  });

  it('returns null and rejects updates for unknown messages', () => {
    expect(t.db.messages.get('missing')).toBeNull();
    expect(() => t.db.messages.update('missing', { content: 'x' })).toThrow(DbError);
  });

  it('counts and hard-deletes messages by conversation', () => {
    const conversation = t.db.conversations.create({ title: 'Delete by conversation' });
    t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'one' });
    t.db.messages.append({ conversationId: conversation.id, role: 'assistant', content: 'two' });
    expect(t.db.messages.countByConversation(conversation.id)).toBe(2);

    t.db.messages.deleteByConversation(conversation.id);

    expect(t.db.messages.countByConversation(conversation.id)).toBe(0);
    expect(t.db.messages.listByConversation(conversation.id)).toEqual([]);
  });

  it('refuses a duplicate (conversation_id, seq) pair', () => {
    const conversation = t.db.conversations.create({ title: 'Unique seq' });
    t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'first' });

    expect(() =>
      t.db.sql.run(
        `INSERT INTO messages (id, conversation_id, role, content, seq, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'duplicate-seq',
          conversation.id,
          'user',
          'duplicate',
          1,
          'complete',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      ),
    ).toThrow(DbError);
  });

  it('rejects an unknown role through the schema constraint', () => {
    const conversation = t.db.conversations.create({ title: 'Bad role' });
    expect(() =>
      t.db.sql.run(
        `INSERT INTO messages (id, conversation_id, role, content, seq, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['bad-role', conversation.id, 'wizard', 'hi', 99, 'complete', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ),
    ).toThrow(DbError);
  });

  it('marks a locally appended message as dirty for the outbox', () => {
    const conversation = t.db.conversations.create({ title: 'Dirty' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'queue me',
    });
    expect(rawMessage(message.id)?.dirty).toBe(1);

    const remoteStyle = t.db.messages.append(
      { conversationId: conversation.id, role: 'assistant', content: 'from server' },
      { dirty: false },
    );
    expect(rawMessage(remoteStyle.id)?.dirty).toBe(0);
  });
});
