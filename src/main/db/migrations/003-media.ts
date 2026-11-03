/**
 * Schema version 3 — generated media and the jobs that produce it.
 *
 * Additive: two new tables, no change to any existing one, so a v2 database gains
 * them without touching a conversation, a message or a credential.
 *
 * **No sync header on either table.** Generated media is local-only by owner
 * decision: it is never uploaded automatically, so a `dirty` column would be a
 * promise the engine does not keep. Adding media to the sync set later means
 * changing `sync/tables.ts`, the entity union, the RPC switches and the
 * `sync_conflicts` constraint together — a deliberate, separate change.
 *
 * Conversation and message references are `ON DELETE SET NULL` rather than
 * `CASCADE`: deleting a conversation must not silently delete the files the owner
 * generated in it. The row survives, orphaned but findable, and the media index
 * still lists it.
 *
 * Consequence to state in release notes: after this migration ships, the previous
 * build refuses to open the database (the runner will not run against a newer
 * schema). There is no downgrade path; that guard is deliberate.
 */
export const MEDIA_SCHEMA_SQL = `
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  width INTEGER NULL,
  height INTEGER NULL,
  duration_ms INTEGER NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  conversation_id TEXT NULL REFERENCES conversations (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  message_id TEXT NULL REFERENCES messages (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  job_id TEXT NULL,
  provider_job_id TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_media_relative_path ON media (relative_path);
CREATE INDEX idx_media_created_at ON media (created_at DESC);
CREATE INDEX idx_media_conversation ON media (conversation_id, created_at DESC);
CREATE INDEX idx_media_job ON media (job_id);

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL CHECK (task IN ('image', 'video')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
  progress INTEGER NULL,
  prompt TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  remote_id TEXT NULL,
  poll_url TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT NULL,
  media_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);

CREATE INDEX idx_jobs_active ON generation_jobs (status, next_poll_at);
CREATE INDEX idx_jobs_created_at ON generation_jobs (created_at DESC);
`;
