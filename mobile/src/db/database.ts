/**
 * Local database for the mobile app.
 *
 * The desktop build uses `node:sqlite` with a sync outbox; mobile uses
 * `expo-sqlite` and has **no synchronisation** in this release, so those columns
 * are deliberately absent rather than carried around unused. The shapes of the
 * rows match the shared core types, so a future sync can be added without
 * reshaping the data.
 *
 * Migrations are keyed on `PRAGMA user_version`, applied in one transaction, and
 * never destructive: an upgrade adds columns, it does not recreate tables.
 */
import * as SQLite from 'expo-sqlite';
import type {
  Agent,
  AppSettings,
  ChatMessage,
  Conversation,
  GenerationParams,
  MessageStatus,
  ModelDescriptor,
  ProviderConfig,
  TokenUsage,
} from '@core/types';
import type { MessageAttachment } from '@core/attachments';
import { normaliseSettings } from '@core/settings';
import { DEFAULT_SETTINGS } from '@core/defaults';

export const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  agent_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  system_prompt TEXT,
  params_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  usage TEXT,
  model_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, seq);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider_id TEXT,
  model_id TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  limits TEXT NOT NULL,
  supported_params TEXT NOT NULL,
  weirdness_supported INTEGER NOT NULL DEFAULT 0,
  base_url_override TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  json TEXT NOT NULL
);
`;

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('grenjo.db');
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await migrate(db);
  return db;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  await db.withTransactionAsync(async () => {
    if (current < 1) await db.execAsync(MIGRATION_1);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/* ------------------------------------------------------------------ codec -- */

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function newId(): string {
  // RFC 4122 v4 without a dependency; Hermes has no crypto.randomUUID.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += (Math.floor(Math.random() * 4) + 8).toString(16);
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

interface ConversationRow {
  id: string;
  title: string;
  agent_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  system_prompt: string | null;
  params_override: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  message_count?: number;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    paramsOverride: parseJson<GenerationParams | null>(row.params_override, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    // No cloud sync in this release: every row is local by definition.
    syncState: 'local',
  };
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments: string;
  seq: number;
  status: string;
  error: string | null;
  usage: string | null;
  model_ref: string | null;
  created_at: string;
  updated_at: string;
}

function toMessage(row: MessageRow): ChatMessage {
  const attachments = parseJson<MessageAttachment[]>(row.attachments, []);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    attachments: Array.isArray(attachments) ? attachments : [],
    seq: row.seq,
    status: row.status as MessageStatus,
    error: parseJson<ChatMessage['error']>(row.error, null),
    usage: parseJson<TokenUsage | null>(row.usage, null),
    modelRef: parseJson<ChatMessage['modelRef']>(row.model_ref, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ----------------------------------------------------------- conversations -- */

export async function listConversations(db: SQLite.SQLiteDatabase, search?: string): Promise<Conversation[]> {
  const term = search?.trim() ?? '';
  const rows = term.length > 0
    ? await db.getAllAsync<ConversationRow>(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         WHERE c.deleted_at IS NULL AND (c.title LIKE ? OR EXISTS (
           SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE ?
         ))
         ORDER BY c.updated_at DESC LIMIT 200`,
        `%${term}%`,
        `%${term}%`,
      )
    : await db.getAllAsync<ConversationRow>(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT 200`,
      );
  return rows.map(toConversation);
}

export async function getConversation(db: SQLite.SQLiteDatabase, id: string): Promise<Conversation | null> {
  const row = await db.getFirstAsync<ConversationRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c WHERE c.id = ? AND c.deleted_at IS NULL`,
    id,
  );
  return row ? toConversation(row) : null;
}

export interface CreateConversationInput {
  title?: string;
  agentId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
}

export async function createConversation(
  db: SQLite.SQLiteDatabase,
  input: CreateConversationInput = {},
): Promise<Conversation> {
  const at = nowIso();
  const conversation: Conversation = {
    id: newId(),
    title: input.title?.trim() || 'New chat',
    agentId: input.agentId ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    systemPrompt: null,
    paramsOverride: null,
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
    syncState: 'local',
  };
  await db.runAsync(
    `INSERT INTO conversations (id, title, agent_id, provider_id, model_id, system_prompt, params_override, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    conversation.id,
    conversation.title,
    conversation.agentId,
    conversation.providerId,
    conversation.modelId,
    at,
    at,
  );
  return conversation;
}

export async function renameConversation(db: SQLite.SQLiteDatabase, id: string, title: string): Promise<void> {
  await db.runAsync('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', title.trim(), nowIso(), id);
}

export async function deleteConversation(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

export async function touchConversation(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE conversations SET updated_at = ? WHERE id = ?', nowIso(), id);
}

export async function setConversationModel(
  db: SQLite.SQLiteDatabase,
  id: string,
  providerId: string,
  modelId: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE conversations SET provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?',
    providerId,
    modelId,
    nowIso(),
    id,
  );
}

/* ---------------------------------------------------------------- messages -- */

export async function listMessages(db: SQLite.SQLiteDatabase, conversationId: string): Promise<ChatMessage[]> {
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
    conversationId,
  );
  return rows.map(toMessage);
}

export interface AppendMessageInput {
  conversationId: string;
  role: ChatMessage['role'];
  content: string;
  status?: MessageStatus;
  attachments?: MessageAttachment[];
  modelRef?: ChatMessage['modelRef'];
}

export async function appendMessage(
  db: SQLite.SQLiteDatabase,
  input: AppendMessageInput,
): Promise<ChatMessage> {
  const at = nowIso();
  const seqRow = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?',
    input.conversationId,
  );
  const seq = seqRow?.next ?? 1;
  const message: ChatMessage = {
    id: newId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    attachments: input.attachments ?? [],
    seq,
    status: input.status ?? 'complete',
    error: null,
    usage: null,
    modelRef: input.modelRef ?? null,
    createdAt: at,
    updatedAt: at,
  };
  await db.runAsync(
    `INSERT INTO messages (id, conversation_id, role, content, attachments, seq, status, error, usage, model_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    message.id,
    message.conversationId,
    message.role,
    message.content,
    JSON.stringify(message.attachments),
    message.seq,
    message.status,
    message.modelRef ? JSON.stringify(message.modelRef) : null,
    at,
    at,
  );
  return message;
}

export async function updateMessage(
  db: SQLite.SQLiteDatabase,
  id: string,
  patch: {
    content?: string;
    status?: MessageStatus;
    error?: ChatMessage['error'];
    usage?: TokenUsage | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.content !== undefined) {
    sets.push('content = ?');
    values.push(patch.content);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error === null ? null : JSON.stringify(patch.error));
  }
  if (patch.usage !== undefined) {
    sets.push('usage = ?');
    values.push(patch.usage === null ? null : JSON.stringify(patch.usage));
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  await db.runAsync(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

/** Settle a message left "streaming" by a crash or a kill, on next launch. */
export async function settleInterruptedMessages(db: SQLite.SQLiteDatabase): Promise<number> {
  const result = await db.runAsync(
    "UPDATE messages SET status = 'stopped', updated_at = ? WHERE status = 'streaming'",
    nowIso(),
  );
  return result.changes;
}

/* ------------------------------------------------------------------ agents -- */

interface AgentRow {
  id: string;
  name: string;
  description: string;
  provider_id: string | null;
  model_id: string | null;
  system_prompt: string;
  params: string;
  created_at: string;
  updated_at: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    providerId: row.provider_id,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    params: parseJson<GenerationParams>(row.params, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncState: 'local',
  };
}

export async function listAgents(db: SQLite.SQLiteDatabase): Promise<Agent[]> {
  const rows = await db.getAllAsync<AgentRow>('SELECT * FROM agents ORDER BY name COLLATE NOCASE');
  return rows.map(toAgent);
}

export interface AgentInput {
  id?: string;
  name: string;
  description?: string;
  providerId?: string | null;
  modelId?: string | null;
  systemPrompt: string;
  params?: GenerationParams;
}

export async function saveAgent(db: SQLite.SQLiteDatabase, input: AgentInput): Promise<Agent> {
  const at = nowIso();
  const id = input.id ?? newId();
  const existing = input.id
    ? await db.getFirstAsync<AgentRow>('SELECT * FROM agents WHERE id = ?', input.id)
    : null;
  if (existing) {
    await db.runAsync(
      `UPDATE agents SET name = ?, description = ?, provider_id = ?, model_id = ?, system_prompt = ?, params = ?, updated_at = ? WHERE id = ?`,
      input.name,
      input.description ?? '',
      input.providerId ?? null,
      input.modelId ?? null,
      input.systemPrompt,
      JSON.stringify(input.params ?? {}),
      at,
      id,
    );
  } else {
    await db.runAsync(
      `INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description ?? '',
      input.providerId ?? null,
      input.modelId ?? null,
      input.systemPrompt,
      JSON.stringify(input.params ?? {}),
      at,
      at,
    );
  }
  const row = await db.getFirstAsync<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
  if (!row) throw new Error('agent write did not persist');
  return toAgent(row);
}

export async function deleteAgent(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM agents WHERE id = ?', id);
}

/* --------------------------------------------------------------- providers -- */

interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  base_url: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toProvider(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    kind: row.kind as ProviderConfig['kind'],
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    hasKey: false,
    keyFingerprint: null,
    keyUpdatedAt: null,
    supportsModelDiscovery: true,
    supportedParams: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProviders(db: SQLite.SQLiteDatabase): Promise<ProviderConfig[]> {
  const rows = await db.getAllAsync<ProviderRow>('SELECT * FROM providers ORDER BY created_at');
  return rows.map(toProvider);
}

export async function saveProvider(
  db: SQLite.SQLiteDatabase,
  input: { id?: string; kind: string; name: string; baseUrl: string; enabled?: boolean },
): Promise<ProviderConfig> {
  const at = nowIso();
  const id = input.id ?? newId();
  const existing = input.id
    ? await db.getFirstAsync<ProviderRow>('SELECT * FROM providers WHERE id = ?', input.id)
    : null;
  if (existing) {
    await db.runAsync(
      'UPDATE providers SET kind = ?, name = ?, base_url = ?, enabled = ?, updated_at = ? WHERE id = ?',
      input.kind,
      input.name,
      input.baseUrl,
      input.enabled === false ? 0 : 1,
      at,
      id,
    );
  } else {
    await db.runAsync(
      `INSERT INTO providers (id, kind, name, base_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.name,
      input.baseUrl,
      input.enabled === false ? 0 : 1,
      at,
      at,
    );
  }
  const row = await db.getFirstAsync<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
  if (!row) throw new Error('provider write did not persist');
  return toProvider(row);
}

export async function deleteProvider(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM models WHERE provider_id = ?', id);
  await db.runAsync('DELETE FROM providers WHERE id = ?', id);
}

/* ------------------------------------------------------------------ models -- */

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  source: string;
  capabilities: string;
  limits: string;
  supported_params: string;
  weirdness_supported: number;
  base_url_override: string | null;
  description: string;
  created_at: string;
  updated_at: string;
}

function toModel(row: ModelRow): ModelDescriptor {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    source: row.source as ModelDescriptor['source'],
    capabilities: parseJson<ModelDescriptor['capabilities']>(row.capabilities, {
      chat: true,
      streaming: true,
      imageInput: false,
      toolCalling: false,
    }),
    limits: parseJson<ModelDescriptor['limits']>(row.limits, {}),
    description: row.description,
    supportedParams: parseJson<ModelDescriptor['supportedParams']>(row.supported_params, []),
    weirdnessSupported: row.weirdness_supported === 1,
    baseUrlOverride: row.base_url_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listModels(db: SQLite.SQLiteDatabase, providerId?: string): Promise<ModelDescriptor[]> {
  const rows = providerId
    ? await db.getAllAsync<ModelRow>('SELECT * FROM models WHERE provider_id = ? ORDER BY display_name', providerId)
    : await db.getAllAsync<ModelRow>('SELECT * FROM models ORDER BY display_name');
  return rows.map(toModel);
}

export async function saveModel(
  db: SQLite.SQLiteDatabase,
  model: Omit<ModelDescriptor, 'createdAt' | 'updatedAt'>,
): Promise<ModelDescriptor> {
  const at = nowIso();
  await db.runAsync(
    `INSERT INTO models (id, provider_id, model_id, display_name, source, capabilities, limits, supported_params, weirdness_supported, base_url_override, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       display_name = excluded.display_name,
       source = excluded.source,
       capabilities = excluded.capabilities,
       limits = excluded.limits,
       supported_params = excluded.supported_params,
       weirdness_supported = excluded.weirdness_supported,
       base_url_override = excluded.base_url_override,
       description = excluded.description,
       updated_at = excluded.updated_at`,
    model.id,
    model.providerId,
    model.modelId,
    model.displayName,
    model.source,
    JSON.stringify(model.capabilities),
    JSON.stringify(model.limits),
    JSON.stringify(model.supportedParams),
    model.weirdnessSupported ? 1 : 0,
    model.baseUrlOverride,
    model.description,
    at,
    at,
  );
  const row = await db.getFirstAsync<ModelRow>(
    'SELECT * FROM models WHERE provider_id = ? AND model_id = ?',
    model.providerId,
    model.modelId,
  );
  if (!row) throw new Error('model write did not persist');
  return toModel(row);
}

export async function deleteModel(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM models WHERE id = ?', id);
}

/* ---------------------------------------------------------------- settings -- */

export async function loadSettings(db: SQLite.SQLiteDatabase): Promise<AppSettings> {
  const row = await db.getFirstAsync<{ json: string }>('SELECT json FROM settings WHERE id = 1');
  return normaliseSettings(row ? parseJson<unknown>(row.json, DEFAULT_SETTINGS) : DEFAULT_SETTINGS);
}

export async function saveSettings(db: SQLite.SQLiteDatabase, settings: AppSettings): Promise<AppSettings> {
  const normalised = normaliseSettings(settings);
  await db.runAsync(
    `INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    JSON.stringify(normalised),
  );
  return normalised;
}
