import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '@main/db/index';
import { TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  t.dispose();
});

function rawConversation(id: string): Record<string, unknown> | null {
  return t.db.sql.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
}

describe('conversations', () => {
  it('creates a conversation with a generated id, default title and pending sync state', () => {
    const conversation = t.db.conversations.create({});

    expect(conversation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(conversation.title).toBe('New chat');
    expect(conversation.messageCount).toBe(0);
    expect(conversation.syncState).toBe('pending');
    expect(conversation.createdAt).toMatch(/Z$/);
    expect(conversation.updatedAt).toMatch(/Z$/);
  });

  it('honours an explicit title and clears surrounding whitespace', () => {
    const conversation = t.db.conversations.create({ title: '  Plan the trip  ' });
    expect(conversation.title).toBe('Plan the trip');
  });

  it('marks a remote-style create as clean when dirty is false', () => {
    const conversation = t.db.conversations.create({ title: 'From server' }, { dirty: false });
    expect(conversation.syncState).toBe('synced');
    expect(rawConversation(conversation.id)?.dirty).toBe(0);
  });

  it('returns null for an unknown id', () => {
    expect(t.db.conversations.get('does-not-exist')).toBeNull();
  });

  it('updates the fields that were patched and ignores the ones that were not', () => {
    const created = t.db.conversations.create({ title: 'Original' });

    const updated = t.db.conversations.update(created.id, {
      title: 'Renamed',
      providerId: 'provider-1',
      modelId: 'gpt-4o',
      systemPrompt: 'Be terse.',
      paramsOverride: { temperature: 0.2, stop: ['END'], reasoningEffort: 'high' },
    });

    expect(updated.title).toBe('Renamed');
    expect(updated.providerId).toBe('provider-1');
    expect(updated.modelId).toBe('gpt-4o');
    expect(updated.systemPrompt).toBe('Be terse.');
    expect(updated.paramsOverride).toEqual({
      temperature: 0.2,
      stop: ['END'],
      reasoningEffort: 'high',
    });
    expect(updated.agentId).toBeNull();
  });

  it('clears a nullable field when the patch sets it to null', () => {
    const created = t.db.conversations.create({
      title: 'Nullable',
      systemPrompt: 'present',
    });

    const updated = t.db.conversations.update(created.id, { systemPrompt: null });
    expect(updated.systemPrompt).toBeNull();
  });

  it('rejects an update for an unknown conversation', () => {
    expect(() => t.db.conversations.update('nope', { title: 'x' })).toThrow(DbError);
  });

  it('touch bumps updated_at and the sync version without changing content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const created = t.db.conversations.create({ title: 'Stable' });
    const createdRow = rawConversation(created.id);

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    t.db.conversations.touch(created.id);

    const touched = t.db.conversations.get(created.id);
    expect(touched?.title).toBe('Stable');
    expect(touched?.updatedAt).toBe('2026-01-01T00:00:05.000Z');
    expect(touched?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rawConversation(created.id)?.version).toBe(Number(createdRow?.version) + 1);
    expect(rawConversation(created.id)?.dirty).toBe(1);
  });

  it('tolerates a touch on a missing conversation', () => {
    expect(() => t.db.conversations.touch('missing')).not.toThrow();
  });

  it('orders the list by updated_at descending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = t.db.conversations.create({ title: 'First' });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    t.db.conversations.create({ title: 'Second' });
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    t.db.conversations.touch(first.id);

    expect(t.db.conversations.list().map((conversation) => conversation.title)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('paginates with limit and offset', () => {
    vi.useFakeTimers();
    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
      t.db.conversations.create({ title: `Conversation ${index}` });
    }

    const page = t.db.conversations.list({ limit: 2, offset: 1 });
    expect(page.map((conversation) => conversation.title)).toEqual([
      'Conversation 3',
      'Conversation 2',
    ]);
  });

  it('reports the message count for each conversation', () => {
    const conversation = t.db.conversations.create({ title: 'Counted' });
    t.db.messages.append({ conversationId: conversation.id, role: 'user', content: 'one' });
    t.db.messages.append({ conversationId: conversation.id, role: 'assistant', content: 'two' });

    expect(t.db.conversations.get(conversation.id)?.messageCount).toBe(2);
    expect(t.db.conversations.list()[0]?.messageCount).toBe(2);
  });

  it('searches the title case-insensitively', () => {
    t.db.conversations.create({ title: 'Sourdough starter notes' });
    t.db.conversations.create({ title: 'Tax paperwork' });

    const results = t.db.conversations.list({ search: 'SOURDOUGH' });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Sourdough starter notes');
  });

  it('searches message content case-insensitively', () => {
    const conversation = t.db.conversations.create({ title: 'Unrelated title' });
    t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'Explain the Krebs cycle',
    });
    t.db.conversations.create({ title: 'Other' });

    const results = t.db.conversations.list({ search: 'krebs' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(conversation.id);
  });

  it('returns an empty list when nothing matches', () => {
    t.db.conversations.create({ title: 'Taxes' });
    expect(t.db.conversations.list({ search: 'astrophysics' })).toEqual([]);
  });

  it('treats a blank search as no filter', () => {
    t.db.conversations.create({ title: 'One' });
    t.db.conversations.create({ title: 'Two' });
    expect(t.db.conversations.list({ search: '   ' })).toHaveLength(2);
  });

  it('escapes LIKE wildcards so a literal percent sign matches literally', () => {
    t.db.conversations.create({ title: '100% complete' });
    t.db.conversations.create({ title: '100 percent complete' });

    const results = t.db.conversations.list({ search: '100%' });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('100% complete');
  });

  it('excludes soft-deleted conversations and their messages from search', () => {
    const deleted = t.db.conversations.create({ title: 'Deleted conversation' });
    t.db.messages.append({
      conversationId: deleted.id,
      role: 'user',
      content: 'vanishing keyword',
    });
    t.db.conversations.softDelete(deleted.id);

    expect(t.db.conversations.list({ search: 'vanishing keyword' })).toEqual([]);
    expect(t.db.conversations.list({ search: 'Deleted conversation' })).toEqual([]);
  });

  it('excludes soft-deleted message content from search', () => {
    const conversation = t.db.conversations.create({ title: 'Kept' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'archived keyword',
    });
    t.db.sql.run('UPDATE messages SET deleted_at = ? WHERE id = ?', [
      '2026-01-01T00:00:00.000Z',
      message.id,
    ]);

    expect(t.db.conversations.list({ search: 'archived keyword' })).toEqual([]);
    expect(t.db.conversations.get(conversation.id)?.messageCount).toBe(0);
  });

  it('soft delete hides the row but keeps a dirty tombstone for sync', () => {
    const conversation = t.db.conversations.create({ title: 'Delete me' });

    t.db.conversations.softDelete(conversation.id);

    expect(t.db.conversations.get(conversation.id)).toBeNull();
    expect(t.db.conversations.list()).toEqual([]);
    expect(t.db.conversations.count()).toBe(0);

    const row = rawConversation(conversation.id);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.dirty).toBe(1);
  });

  it('restores a soft-deleted conversation', () => {
    const conversation = t.db.conversations.create({ title: 'Restore me' });
    t.db.conversations.softDelete(conversation.id);

    t.db.conversations.restore(conversation.id);

    expect(t.db.conversations.get(conversation.id)?.title).toBe('Restore me');
    expect(rawConversation(conversation.id)?.dirty).toBe(1);
  });

  it('auto-titles only while the title is still the default', () => {
    const conversation = t.db.conversations.create({});
    t.db.conversations.autoTitle(conversation.id, 'Plan a trip to Kyoto');
    expect(t.db.conversations.get(conversation.id)?.title).toBe('Plan a trip to Kyoto');

    t.db.conversations.autoTitle(conversation.id, 'A second attempt');
    expect(t.db.conversations.get(conversation.id)?.title).toBe('Plan a trip to Kyoto');
  });

  it('does not auto-title a conversation the user already named', () => {
    const conversation = t.db.conversations.create({ title: 'My own title' });
    t.db.conversations.autoTitle(conversation.id, 'Generated title');
    expect(t.db.conversations.get(conversation.id)?.title).toBe('My own title');
  });

  it('counts only live conversations', () => {
    t.db.conversations.create({ title: 'One' });
    const two = t.db.conversations.create({ title: 'Two' });
    t.db.conversations.softDelete(two.id);
    expect(t.db.conversations.count()).toBe(1);
  });
});
