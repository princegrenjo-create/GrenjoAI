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

describe('transactions', () => {
  it('rolls back every write when the callback throws', () => {
    const existing = t.db.conversations.create({ title: 'Before' });

    expect(() =>
      t.db.transaction(() => {
        t.db.conversations.create({ title: 'Inside' });
        throw new Error('abort');
      }),
    ).toThrow('abort');

    expect(t.db.conversations.count()).toBe(1);
    expect(t.db.conversations.list()).toHaveLength(1);
    expect(t.db.conversations.get(existing.id)?.title).toBe('Before');
    expect(t.db.migrations.version()).toBe(1);
  });

  it('rethrows the original error type', () => {
    expect(() =>
      t.db.transaction(() => {
        throw new DbError('validation failure', 'validation');
      }),
    ).toThrow(DbError);
  });

  it('returns the callback value on commit', () => {
    const value = t.db.transaction(() => {
      t.db.conversations.create({ title: 'Committed' });
      return 'result';
    });
    expect(value).toBe('result');
    expect(t.db.conversations.count()).toBe(1);
  });

  it('commits a nested transaction as part of its parent', () => {
    const conversationId = t.db.transaction(() => {
      const conversation = t.db.conversations.create({ title: 'Outer' });
      t.db.transaction(() => {
        t.db.messages.append({
          conversationId: conversation.id,
          role: 'user',
          content: 'nested',
        });
        t.db.transaction(() => {
          t.db.messages.append({
            conversationId: conversation.id,
            role: 'assistant',
            content: 'deeper',
          });
        });
      });
      return conversation.id;
    });

    expect(t.db.messages.listByConversation(conversationId)).toHaveLength(2);
  });

  it('rolls back only the failing nested transaction, not the outer one', () => {
    const conversationId = t.db.transaction(() => {
      const conversation = t.db.conversations.create({ title: 'Outer survives' });
      expect(() =>
        t.db.transaction(() => {
          t.db.messages.append({
            conversationId: conversation.id,
            role: 'user',
            content: 'must not survive',
          });
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      return conversation.id;
    });

    expect(t.db.conversations.get(conversationId)?.title).toBe('Outer survives');
    expect(t.db.messages.countByConversation(conversationId)).toBe(0);
  });

  it('undoes a nested commit when the outer transaction fails', () => {
    expect(() =>
      t.db.transaction(() => {
        const conversation = t.db.conversations.create({ title: 'Doomed' });
        t.db.transaction(() => {
          t.db.messages.append({
            conversationId: conversation.id,
            role: 'user',
            content: 'doomed too',
          });
        });
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');

    expect(t.db.conversations.count()).toBe(0);
    const messageRows = t.db.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages');
    expect(messageRows?.n).toBe(0);
  });

  it('does not leave a half-written message seq behind after a rollback', () => {
    const conversation = t.db.conversations.create({ title: 'Seq' });

    expect(() =>
      t.db.transaction(() => {
        t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'first' });
        throw new Error('abort after append');
      }),
    ).toThrow('abort after append');

    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'second attempt',
    });
    expect(message.seq).toBe(1);
  });

  it('re-enters from a repository call made inside a transaction', () => {
    const conversationId = t.db.transaction(() => {
      const conversation = t.db.conversations.create({ title: 'Append inside tx' });
      // `append` opens its own transaction; it must nest, not fail.
      t.db.messages.append({
        conversationId: conversation.id,
        role: 'user',
        content: 'nested append',
      });
      return conversation.id;
    });

    expect(t.db.messages.countByConversation(conversationId)).toBe(1);
  });
});
