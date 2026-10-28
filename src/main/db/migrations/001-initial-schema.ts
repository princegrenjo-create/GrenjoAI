/**
 * Schema version 1.
 *
 * Every syncable table carries the same sync header — `version`, `dirty`,
 * `attempts`, `next_attempt_at`, `last_error`, `created_at`, `updated_at`,
 * `deleted_at` — because the row itself is the outbox entry (see the
 * `SyncRepository` contract). `deleted_at` is a tombstone: a soft delete keeps
 * the row so its deletion can be pushed.
 *
 * There is deliberately no credential column anywhere. `providers` stores only
 * `key_fingerprint` and `key_updated_at`; the key itself lives in the OS
 * credential store behind the main process.
 *
 * The foreign keys are `DEFERRABLE INITIALLY DEFERRED` so one transaction may
 * write a parent and its child in either order (a pull can deliver a message
 * before its conversation, or a model before its provider). The constraint is
 * still enforced when the transaction commits.
 */
export const INITIAL_SCHEMA_SQL = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT NULL,
  provider_id TEXT NULL,
  model_id TEXT NULL,
  system_prompt TEXT NULL,
  params_override_json TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL
);

CREATE INDEX idx_conversations_updated_at ON conversations (updated_at DESC);
CREATE INDEX idx_conversations_pending ON conversations (updated_at) WHERE dirty = 1;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'error', 'stopped')),
  error_json TEXT NULL,
  usage_json TEXT NULL,
  model_json TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, seq);
CREATE INDEX idx_messages_pending ON messages (updated_at) WHERE dirty = 1;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider_id TEXT NULL,
  model_id TEXT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL
);

CREATE INDEX idx_agents_updated_at ON agents (updated_at DESC);
CREATE INDEX idx_agents_pending ON agents (updated_at) WHERE dirty = 1;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  key_fingerprint TEXT NULL,
  key_updated_at TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL
);

CREATE INDEX idx_providers_pending ON providers (updated_at) WHERE dirty = 1;

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalog', 'discovered', 'custom')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  supported_params_json TEXT NOT NULL DEFAULT '[]',
  weirdness_supported INTEGER NOT NULL DEFAULT 0,
  base_url_override TEXT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  UNIQUE (provider_id, model_id, source)
);

CREATE INDEX idx_models_provider ON models (provider_id);
CREATE INDEX idx_models_pending ON models (updated_at) WHERE dirty = 1;

CREATE TABLE app_settings (
  id TEXT PRIMARY KEY CHECK (id = 'app-settings'),
  json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL
);

CREATE INDEX idx_app_settings_pending ON app_settings (updated_at) WHERE dirty = 1;

CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('conversation', 'message', 'agent', 'model', 'provider', 'settings')),
  entity_id TEXT NOT NULL,
  local_revision INTEGER NOT NULL,
  remote_revision INTEGER NOT NULL,
  detected_at TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('unresolved', 'kept_local', 'kept_remote')),
  summary TEXT NOT NULL,
  remote_payload_json TEXT NULL
);

CREATE INDEX idx_sync_conflicts_unresolved ON sync_conflicts (detected_at DESC) WHERE resolution = 'unresolved';

CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
