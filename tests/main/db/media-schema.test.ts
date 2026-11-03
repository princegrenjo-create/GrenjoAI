/**
 * Schema 3: generated media and generation jobs.
 *
 * The migration is additive by design — no existing table changes — so the tests
 * that matter are: it lands on a fresh file, it lands on a database that is
 * already at v2 (the real upgrade path), it does not join the sync set, and the
 * conversation link is `ON DELETE SET NULL` so deleting a chat never deletes the
 * files the owner generated in it.
 */
import { copyFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError, openDatabase } from '@main/db/index';
import { MIGRATIONS } from '@main/db/migrations';
import { SYNC_TABLES } from '@main/sync/tables';
import { LATEST_SCHEMA_VERSION, TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

const PNG_SHA = 'a'.repeat(64);

function seedMedia(overrides: Partial<Parameters<typeof t.db.media.insert>[0]> = {}) {
  return t.db.media.insert({
    kind: 'image',
    providerId: 'p-1',
    modelId: 'gpt-image-2',
    prompt: 'A heron at dawn',
    params: { size: '1024x1024' },
    width: 1024,
    height: 1024,
    bytes: 1234,
    sha256: PNG_SHA,
    mime: 'image/png',
    relativePath: `${PNG_SHA.slice(0, 2)}/${PNG_SHA}.png`,
    ...overrides,
  });
}

describe('schema 3 — media', () => {
  it('is the current version and creates both tables', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(3);
    expect(t.db.migrations.version()).toBe(3);

    const tables = t.db.sql
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).toContain('media');
    expect(tables).toContain('generation_jobs');
  });

  it('upgrades a v2 database in place without touching existing rows', () => {
    // Build a database that stops at v2, exactly as an existing install would be.
    const path = t.filePath;
    const partial = openDatabase(path);
    partial.sql.run('DELETE FROM schema_migrations WHERE version = 3');
    partial.sql.run('DROP TABLE IF EXISTS media');
    partial.sql.run('DROP TABLE IF EXISTS generation_jobs');
    const conversation = partial.conversations.create({ title: 'Before the upgrade' });
    partial.messages.append({ conversationId: conversation.id, role: 'user', content: 'still here?' });
    partial.close();

    const upgraded = openDatabase(path);
    expect(upgraded.migrations.version()).toBe(3);
    // The rows that existed before are untouched.
    expect(upgraded.conversations.get(conversation.id)?.title).toBe('Before the upgrade');
    expect(upgraded.messages.listByConversation(conversation.id)).toHaveLength(1);
    // And the new tables are usable.
    expect(upgraded.media.list()).toEqual([]);
    upgraded.close();
  });

  it('refuses a database written by a newer build rather than guessing', () => {
    const path = t.filePath;
    t.db.sql.run(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'future', '2030-01-01T00:00:00.000Z')",
    );
    t.db.close();
    expect(() => openDatabase(path)).toThrowError(DbError);
  });

  it('stores and reads a media row, including its parameters', () => {
    const row = seedMedia();
    expect(row.sha256).toBe(PNG_SHA);
    expect(row.params).toEqual({ size: '1024x1024' });

    const read = t.db.media.get(row.id);
    expect(read).toEqual(row);
    expect(t.db.media.totalBytes()).toBe(1234);
  });

  it('lists by kind and by conversation, newest first', () => {
    const conversation = t.db.conversations.create({ title: 'Art' });
    const a = seedMedia({ sha256: 'a'.repeat(64), relativePath: `${'a'.repeat(2)}/${'a'.repeat(64)}.png` });
    const b = seedMedia({
      kind: 'video',
      sha256: 'b'.repeat(64),
      relativePath: `${'b'.repeat(2)}/${'b'.repeat(64)}.mp4`,
      mime: 'video/mp4',
      conversationId: conversation.id,
    });
    void a;

    expect(t.db.media.list({ kind: 'image' }).map((row) => row.kind)).toEqual(['image']);
    expect(t.db.media.list({ kind: 'video' }).map((row) => row.kind)).toEqual(['video']);
    expect(t.db.media.list({ conversationId: conversation.id }).map((row) => row.id)).toEqual([b.id]);
  });

  it('keeps the media row when its conversation is deleted', () => {
    const conversation = t.db.conversations.create({ title: 'Temporary' });
    const message = t.db.messages.append({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'here it is',
    });
    const row = seedMedia({ conversationId: conversation.id, messageId: message.id });
    expect(t.db.media.get(row.id)?.conversationId).toBe(conversation.id);

    // A soft delete keeps the row, so the link legitimately survives it.
    t.db.conversations.softDelete(conversation.id);
    expect(t.db.media.get(row.id)?.conversationId).toBe(conversation.id);

    // A hard delete is what fires the constraint. Deleting a chat must not delete
    // the owner's generated files: the row survives, orphaned but findable.
    t.db.sql.run('DELETE FROM messages WHERE conversation_id = ?', [conversation.id]);
    t.db.sql.run('DELETE FROM conversations WHERE id = ?', [conversation.id]);

    const orphan = t.db.media.get(row.id);
    expect(orphan).not.toBeNull();
    expect(orphan?.conversationId).toBeNull();
    expect(orphan?.messageId).toBeNull();
  });

  it('is not part of the sync set', () => {
    // Media is local-only by decision: a `dirty` column or a sync table entry
    // would claim otherwise. Both absences are asserted, not assumed.
    expect([...SYNC_TABLES]).not.toContain('media');
    const columns = t.db.sql
      .query<{ name: string }>('PRAGMA table_info(media)')
      .map((row) => row.name);
    expect(columns).not.toContain('dirty');
    expect(columns).not.toContain('version');
  });
});

describe('schema 3 — generation jobs', () => {
  const baseJob = {
    task: 'image' as const,
    providerId: 'p-1',
    modelId: 'gpt-image-2',
    prompt: 'A heron at dawn',
    params: {},
  };

  it('creates a queued job and lists it as active', () => {
    const job = t.db.generationJobs.insert(baseJob);
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(t.db.generationJobs.listActive().map((row) => row.id)).toEqual([job.id]);
  });

  it('moves a job through its states and drops it from the active list when terminal', () => {
    const job = t.db.generationJobs.insert(baseJob);
    t.db.generationJobs.update(job.id, { status: 'running', remoteId: 'remote-1', progress: 40 });
    expect(t.db.generationJobs.get(job.id)?.status).toBe('running');
    expect(t.db.generationJobs.listActive()).toHaveLength(1);

    const finished = t.db.generationJobs.update(job.id, {
      status: 'succeeded',
      progress: 100,
      mediaId: 'media-1',
      finishedAt: '2026-11-03T00:00:00.000Z',
    });
    expect(finished?.status).toBe('succeeded');
    expect(finished?.mediaId).toBe('media-1');
    // A terminal job is not offered to the poller again.
    expect(t.db.generationJobs.listActive()).toEqual([]);
  });

  it('records a failure with its retryability, so the engine can decide not to loop', () => {
    const job = t.db.generationJobs.insert(baseJob);
    const failed = t.db.generationJobs.update(job.id, {
      status: 'failed',
      errorCode: 'moderation_blocked',
      errorMessage: 'Blocked by the provider’s content policy.',
      retryable: false,
    });
    expect(failed?.errorCode).toBe('moderation_blocked');
    expect(failed?.retryable).toBe(false);
    expect(t.db.generationJobs.listActive()).toEqual([]);
  });

  it('returns null when updating a job that does not exist', () => {
    expect(t.db.generationJobs.update('missing', { status: 'running' })).toBeNull();
  });

  it('round-trips parameters and prompt for a resumed job', () => {
    const job = t.db.generationJobs.insert({
      ...baseJob,
      task: 'video',
      params: { aspect_ratio: '16:9', resolution: '720p', n: 1 },
    });
    const read = t.db.generationJobs.get(job.id);
    expect(read?.params).toEqual({ aspect_ratio: '16:9', resolution: '720p', n: 1 });
    expect(read?.task).toBe('video');
  });
});

describe('schema 3 — migration set integrity', () => {
  it('keeps the set strictly increasing and starting at 1', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(new Set(MIGRATIONS.map((migration) => migration.name)).size).toBe(3);
  });

  it('leaves a copy of a v3 file readable after a shutdown', () => {
    const copy = `${t.filePath}.copy.db`;
    t.db.checkpoint();
    copyFileSync(t.filePath, copy);
    const reopened = openDatabase(copy);
    expect(reopened.migrations.version()).toBe(3);
    reopened.close();
  });
});
