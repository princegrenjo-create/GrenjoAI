import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@main/db/index';
import { FUTURE, PAST, seedProvider, TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

function rawRow(table: string, id: string): Record<string, unknown> | null {
  return t.db.sql.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

describe('sync outbox', () => {
  it('lists every dirty row across entities with its payload', () => {
    const conversation = t.db.conversations.create({ title: 'Queued' });
    const agent = t.db.agents.create({ name: 'Helper', systemPrompt: 'Help.' });
    const provider = seedProvider(t.db);

    const pending = t.db.sync.pending(50);

    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((row) => row.entity))).toEqual(
      new Set(['conversation', 'agent', 'provider']),
    );
    const conversationRow = pending.find((row) => row.entity === 'conversation');
    expect(conversationRow?.entityId).toBe(conversation.id);
    expect(conversationRow?.version).toBe(1);
    expect(conversationRow?.op).toBe('upsert');
    expect(conversationRow?.payload).toMatchObject({ id: conversation.id, title: 'Queued' });
    expect(pending.find((row) => row.entity === 'agent')?.entityId).toBe(agent.id);
    expect(pending.find((row) => row.entity === 'provider')?.entityId).toBe(provider.id);
  });

  it('honours the limit and rejects a zero limit', () => {
    t.db.conversations.create({ title: 'One' });
    t.db.conversations.create({ title: 'Two' });

    expect(t.db.sync.pending(1)).toHaveLength(1);
    expect(t.db.sync.pending(0)).toEqual([]);
  });

  it('counts pending rows without a limit', () => {
    t.db.conversations.create({ title: 'One' });
    const second = t.db.conversations.create({ title: 'Two' });
    t.db.conversations.softDelete(second.id);

    expect(t.db.sync.pendingCount()).toBe(2);
  });

  it('reports a soft delete as a delete operation with its tombstone', () => {
    const conversation = t.db.conversations.create({ title: 'Delete on the server too' });
    t.db.conversations.softDelete(conversation.id);

    const rows = t.db.sync.pending(10).filter((row) => row.entity === 'conversation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.op).toBe('delete');
    expect(rows[0]?.payload).toMatchObject({ id: conversation.id });
  });

  it('includes the settings document as a pending row', () => {
    t.db.settings.patch({ general: { theme: 'light' } });

    const rows = t.db.sync.pending(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity).toBe('settings');
    expect(rows[0]?.entityId).toBe('app-settings');
    expect(rows[0]?.payload).toMatchObject({ settings: { general: { theme: 'light' } } });
  });
});

describe('sync push state', () => {
  it('clears the dirty flag only when the pushed version is still current', () => {
    const conversation = t.db.conversations.create({ title: 'Pushed' });
    expect(t.db.sync.pendingCount()).toBe(1);

    t.db.sync.markPushed('conversation', conversation.id, 1);

    expect(t.db.sync.pendingCount()).toBe(0);
    expect(rawRow('conversations', conversation.id)?.dirty).toBe(0);

    const stale = t.db.conversations.create({ title: 'Changed mid-push' });
    t.db.sync.markPushed('conversation', stale.id, 99);

    expect(t.db.sync.pendingCount()).toBe(1);
    expect(rawRow('conversations', stale.id)?.dirty).toBe(1);
  });

  it('records a failure with attempts and defers the row', () => {
    const conversation = t.db.conversations.create({ title: 'Fails' });

    t.db.sync.markFailed('conversation', conversation.id, 'network down', FUTURE);

    expect(t.db.sync.pending(10)).toEqual([]);
    expect(t.db.sync.pendingCount()).toBe(1);
    const row = rawRow('conversations', conversation.id);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('network down');
    expect(row?.next_attempt_at).toBe(FUTURE);
    // The UI shows a failed row as an error rather than pending.
    expect(t.db.conversations.get(conversation.id)?.syncState).toBe('error');
  });

  it('increments attempts on repeated failures and retries immediately with retryNow', () => {
    const conversation = t.db.conversations.create({ title: 'Retry me' });
    t.db.sync.markFailed('conversation', conversation.id, 'first', PAST);
    t.db.sync.markFailed('conversation', conversation.id, 'second', PAST);

    expect(rawRow('conversations', conversation.id)?.attempts).toBe(2);
    expect(t.db.sync.pending(10)).toHaveLength(1);

    t.db.sync.retryNow('conversation', conversation.id);

    const row = rawRow('conversations', conversation.id);
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
    expect(row?.next_attempt_at).toBeNull();
    expect(t.db.sync.pending(10)).toHaveLength(1);
  });

  it('does not resurrect a clean row with retryNow', () => {
    const conversation = t.db.conversations.create({ title: 'Clean' }, { dirty: false });
    t.db.sync.retryNow('conversation', conversation.id);
    expect(rawRow('conversations', conversation.id)?.dirty).toBe(0);
  });
});

describe('applyRemote', () => {
  it('applies a newer remote record over a clean local row', () => {
    const local = t.db.conversations.create({ title: 'Local title' }, { dirty: false });

    const result = t.db.sync.applyRemote('conversation', {
      id: local.id,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: {
        title: 'Server title',
        createdAt: local.createdAt,
        agentId: null,
        providerId: null,
        modelId: null,
        systemPrompt: null,
        paramsOverride: null,
      },
    });

    expect(result).toBe('applied');
    const applied = t.db.conversations.get(local.id);
    expect(applied?.title).toBe('Server title');
    expect(applied?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(applied?.createdAt).toBe(local.createdAt);
    expect(applied?.syncState).toBe('synced');
    // A remote apply must never echo back to the server.
    expect(rawRow('conversations', local.id)?.dirty).toBe(0);
    expect(rawRow('conversations', local.id)?.version).toBe(2);
    expect(t.db.sync.pendingCount()).toBe(0);
  });

  it('reports a conflict instead of overwriting a dirty local row', () => {
    const local = t.db.conversations.create({ title: 'My local edit' });

    const result = t.db.sync.applyRemote('conversation', {
      id: local.id,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Remote edit' },
    });

    expect(result).toBe('conflict');
    expect(t.db.conversations.get(local.id)?.title).toBe('My local edit');
    expect(rawRow('conversations', local.id)?.version).toBe(1);
    expect(rawRow('conversations', local.id)?.dirty).toBe(1);
  });

  it('ignores a duplicate record with the same version', () => {
    const local = t.db.conversations.create({ title: 'Already synced' }, { dirty: false });

    const result = t.db.sync.applyRemote('conversation', {
      id: local.id,
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Ignored title' },
    });

    expect(result).toBe('ignored');
    expect(t.db.conversations.get(local.id)?.title).toBe('Already synced');
  });

  it('ignores an older record', () => {
    const local = t.db.conversations.create({ title: 'Current' }, { dirty: false });
    t.db.conversations.update(local.id, { title: 'Current v2' }, { dirty: false });

    const result = t.db.sync.applyRemote('conversation', {
      id: local.id,
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Ancient title' },
    });

    expect(result).toBe('ignored');
    expect(t.db.conversations.get(local.id)?.title).toBe('Current v2');
  });

  it('inserts a record that does not exist locally and keeps it clean', () => {
    const result = t.db.sync.applyRemote('conversation', {
      id: 'remote-conversation',
      version: 3,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: {
        title: 'Created elsewhere',
        createdAt: '2026-01-15T00:00:00.000Z',
      },
    });

    expect(result).toBe('applied');
    const inserted = t.db.conversations.get('remote-conversation');
    expect(inserted?.title).toBe('Created elsewhere');
    expect(inserted?.createdAt).toBe('2026-01-15T00:00:00.000Z');
    expect(inserted?.syncState).toBe('synced');
    expect(rawRow('conversations', 'remote-conversation')?.dirty).toBe(0);
    expect(rawRow('conversations', 'remote-conversation')?.version).toBe(3);
  });

  it('is idempotent: applying the same record twice changes nothing the second time', () => {
    const remote = {
      id: 'idempotent-conversation',
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Only once' },
    };

    expect(t.db.sync.applyRemote('conversation', remote)).toBe('applied');
    expect(t.db.sync.applyRemote('conversation', remote)).toBe('ignored');
    expect(t.db.sync.pendingCount()).toBe(0);
    expect(t.db.conversations.count()).toBe(1);
  });

  it('applies a remote message into its conversation', () => {
    const conversation = t.db.conversations.create({ title: 'Remote messages' }, { dirty: false });

    const result = t.db.sync.applyRemote('message', {
      id: 'remote-message',
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'hello from the server',
        seq: 1,
        status: 'complete',
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      },
    });

    expect(result).toBe('applied');
    const messages = t.db.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('hello from the server');
    expect(messages[0]?.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(messages[0]?.seq).toBe(1);
    expect(rawRow('messages', 'remote-message')?.dirty).toBe(0);
  });

  it('applies a remote settings document', () => {
    const result = t.db.sync.applyRemote('settings', {
      id: 'app-settings',
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { settings: { general: { theme: 'light' }, sync: { enabled: true } } },
    });

    expect(result).toBe('applied');
    const settings = t.db.settings.get();
    expect(settings.general.theme).toBe('light');
    expect(settings.sync.enabled).toBe(true);
    expect(rawRow('app_settings', 'app-settings')?.dirty).toBe(0);
  });

  it('ignores a settings record for an unknown row id', () => {
    const result = t.db.sync.applyRemote('settings', {
      id: 'some-other-settings',
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { settings: {} },
    });
    expect(result).toBe('ignored');
  });

  it('rejects an invalid remote version and a non-object payload', () => {
    expect(() =>
      t.db.sync.applyRemote('conversation', {
        id: 'x',
        version: 0,
        updatedAt: '2026-02-01T00:00:00.000Z',
        deletedAt: null,
        payload: {},
      }),
    ).toThrow(DbError);

    expect(() =>
      t.db.sync.applyRemote('conversation', {
        id: 'x',
        version: 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
        deletedAt: null,
        payload: 'not an object',
      }),
    ).toThrow(DbError);
  });

  it('applies a remote tombstone as a soft delete', () => {
    const local = t.db.conversations.create({ title: 'Deleted on the server' }, { dirty: false });

    const result = t.db.sync.applyRemote('conversation', {
      id: local.id,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
      payload: { title: 'Deleted on the server' },
    });

    expect(result).toBe('applied');
    expect(t.db.conversations.get(local.id)).toBeNull();
    expect(rawRow('conversations', local.id)?.deleted_at).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('applyRemote cross-device ordering', () => {
  /**
   * `version` is a per-device counter: every local mutation bumps it, including
   * each streaming flush of one assistant message. Two devices therefore hold
   * unrelated version numbers for the same record, so "remote newer" must also
   * consider `updated_at`. These fixtures set the local row's version and
   * timestamp directly, because the repository clock can only move forward.
   */
  function seedLocalRow(options: { version: number; updatedAt: string; dirty: number }): string {
    const conversation = t.db.conversations.create({ title: 'Local older content' });
    t.db.sql.run('UPDATE conversations SET version = ?, updated_at = ?, dirty = ? WHERE id = ?', [
      options.version,
      options.updatedAt,
      options.dirty,
      conversation.id,
    ]);
    return conversation.id;
  }

  it('reports conflict when the remote is newer only by updated_at and the local row is dirty', () => {
    const localId = seedLocalRow({ version: 5, updatedAt: '2026-01-01T00:00:00.000Z', dirty: 1 });

    const result = t.db.sync.applyRemote('conversation', {
      id: localId,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Remote newer content' },
    });

    expect(result).toBe('conflict');
    expect(t.db.conversations.get(localId)?.title).toBe('Local older content');
    const row = rawRow('conversations', localId);
    expect(row?.version).toBe(5);
    expect(row?.updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.dirty).toBe(1);
  });

  it('applies a remote that is newer only by updated_at over a clean local row', () => {
    const localId = seedLocalRow({ version: 5, updatedAt: '2026-01-01T00:00:00.000Z', dirty: 0 });
    const createdAtBeforeApply = rawRow('conversations', localId)?.created_at;

    const result = t.db.sync.applyRemote('conversation', {
      id: localId,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Remote newer content', createdAt: '2025-12-31T00:00:00.000Z' },
    });

    expect(result).toBe('applied');
    const applied = t.db.conversations.get(localId);
    expect(applied?.title).toBe('Remote newer content');
    expect(applied?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    const row = rawRow('conversations', localId);
    expect(row?.version).toBe(2);
    expect(row?.dirty).toBe(0);
    // Local creation history is not rewritten by a pull.
    expect(row?.created_at).toBe(createdAtBeforeApply);
  });

  it('ignores a remote that is older on both version and updated_at', () => {
    const localId = seedLocalRow({ version: 5, updatedAt: '2026-02-01T00:00:00.000Z', dirty: 0 });

    const result = t.db.sync.applyRemote('conversation', {
      id: localId,
      version: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Remote older content' },
    });

    expect(result).toBe('ignored');
    expect(t.db.conversations.get(localId)?.title).toBe('Local older content');
    const row = rawRow('conversations', localId);
    expect(row?.version).toBe(5);
    expect(row?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(row?.dirty).toBe(0);
  });

  it('ignores a duplicate with the same version and the same updated_at', () => {
    const localId = seedLocalRow({ version: 3, updatedAt: '2026-03-01T00:00:00.000Z', dirty: 0 });

    const result = t.db.sync.applyRemote('conversation', {
      id: localId,
      version: 3,
      updatedAt: '2026-03-01T00:00:00.000Z',
      deletedAt: null,
      payload: { title: 'Remote duplicate content' },
    });

    expect(result).toBe('ignored');
    expect(t.db.conversations.get(localId)?.title).toBe('Local older content');
    expect(rawRow('conversations', localId)?.version).toBe(3);
  });

  it('applies a tombstone that is newer only by updated_at over a clean local row', () => {
    const localId = seedLocalRow({ version: 5, updatedAt: '2026-01-01T00:00:00.000Z', dirty: 0 });

    const result = t.db.sync.applyRemote('conversation', {
      id: localId,
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
      payload: { title: 'Deleted on another device' },
    });

    expect(result).toBe('applied');
    expect(t.db.conversations.get(localId)).toBeNull();
    const row = rawRow('conversations', localId);
    expect(row?.deleted_at).toBe('2026-02-01T00:00:00.000Z');
    expect(row?.dirty).toBe(0);
  });
});

describe('conflicts', () => {
  it('records, lists and counts an unresolved conflict', () => {
    const conversation = t.db.conversations.create({ title: 'Conflict' });

    t.db.sync.recordConflict({
      entity: 'conversation',
      entityId: conversation.id,
      localRevision: 1,
      remoteRevision: 2,
      summary: 'title changed on both sides',
      remotePayload: { title: 'Server title' },
    });

    expect(t.db.sync.conflictCount()).toBe(1);
    const conflicts = t.db.sync.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.entity).toBe('conversation');
    expect(conflicts[0]?.entityId).toBe(conversation.id);
    expect(conflicts[0]?.localRevision).toBe(1);
    expect(conflicts[0]?.remoteRevision).toBe(2);
    expect(conflicts[0]?.resolution).toBe('unresolved');
    expect(conflicts[0]?.summary).toBe('title changed on both sides');
    // The conversation itself reports the conflict state.
    expect(t.db.conversations.get(conversation.id)?.syncState).toBe('conflict');
  });

  it('keeps only one unresolved conflict per row across repeated pulls', () => {
    const conversation = t.db.conversations.create({ title: 'Recurring conflict' });

    t.db.sync.recordConflict({
      entity: 'conversation',
      entityId: conversation.id,
      localRevision: 1,
      remoteRevision: 2,
      summary: 'first detection',
      remotePayload: { title: 'Server v2' },
    });
    t.db.sync.recordConflict({
      entity: 'conversation',
      entityId: conversation.id,
      localRevision: 1,
      remoteRevision: 3,
      summary: 'second detection',
      remotePayload: { title: 'Server v3' },
    });

    expect(t.db.sync.conflictCount()).toBe(1);
    const conflict = t.db.sync.conflicts()[0];
    expect(conflict?.remoteRevision).toBe(3);
    expect(conflict?.summary).toBe('second detection');
  });

  it('keeps the local version when the user keeps local', () => {
    const conversation = t.db.conversations.create({ title: 'Local wins' });
    t.db.sync.recordConflict({
      entity: 'conversation',
      entityId: conversation.id,
      localRevision: 1,
      remoteRevision: 5,
      summary: 'both edited',
      remotePayload: { title: 'Remote loses' },
    });
    const conflictId = t.db.sync.conflicts()[0]?.id ?? -1;

    t.db.sync.resolveConflict(conflictId, 'kept_local');

    expect(t.db.sync.conflictCount()).toBe(0);
    expect(t.db.conversations.get(conversation.id)?.title).toBe('Local wins');
    expect(t.db.conversations.get(conversation.id)?.syncState).toBe('pending');
    // The local row now outranks the remote revision so the next push wins.
    expect(rawRow('conversations', conversation.id)?.version).toBe(6);
    expect(rawRow('conversations', conversation.id)?.dirty).toBe(1);
  });

  it('applies the remote payload when the user keeps remote', () => {
    const conversation = t.db.conversations.create({ title: 'Remote wins' });
    t.db.sync.recordConflict({
      entity: 'conversation',
      entityId: conversation.id,
      localRevision: 1,
      remoteRevision: 4,
      summary: 'both edited',
      remotePayload: {
        title: 'Server wins',
        agentId: null,
        providerId: null,
        modelId: null,
        systemPrompt: null,
        paramsOverride: null,
      },
    });
    const conflictId = t.db.sync.conflicts()[0]?.id ?? -1;

    t.db.sync.resolveConflict(conflictId, 'kept_remote');

    expect(t.db.sync.conflictCount()).toBe(0);
    expect(t.db.conversations.get(conversation.id)?.title).toBe('Server wins');
    expect(t.db.conversations.get(conversation.id)?.syncState).toBe('synced');
    expect(rawRow('conversations', conversation.id)?.version).toBe(4);
    expect(rawRow('conversations', conversation.id)?.dirty).toBe(0);
  });

  it('rejects a resolution for an unknown conflict', () => {
    expect(() => t.db.sync.resolveConflict(9999, 'kept_local')).toThrow(DbError);
  });
});

describe('sync metadata', () => {
  it('stores, overwrites and deletes a metadata key', () => {
    expect(t.db.sync.meta.get('cursor')).toBeNull();

    t.db.sync.meta.set('cursor', '42');
    expect(t.db.sync.meta.get('cursor')).toBe('42');

    t.db.sync.meta.set('cursor', '43');
    expect(t.db.sync.meta.get('cursor')).toBe('43');

    t.db.sync.meta.delete('cursor');
    expect(t.db.sync.meta.get('cursor')).toBeNull();
  });

  it('survives a restart', () => {
    t.db.sync.meta.set('last_synced_at', '2026-02-01T00:00:00.000Z');
    t.reopen();
    expect(t.db.sync.meta.get('last_synced_at')).toBe('2026-02-01T00:00:00.000Z');
  });
});
