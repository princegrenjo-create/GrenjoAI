/**
 * Entity <-> cloud table mapping and the fixed sync order.
 *
 * The order matters: a provider and a model are referenced by an agent, an agent by a
 * conversation, and a message belongs to a conversation. Pulling and pushing parents
 * before children keeps a half-synced account readable on the next device.
 */
import type { SyncEntityKind } from '@shared/types';

export const SYNC_TABLES = [
  'providers',
  'models',
  'agents',
  'conversations',
  'messages',
  'settings',
] as const;

export type SyncTableName = (typeof SYNC_TABLES)[number];

/** Columns requested on a pull. Mirrors the schema in supabase/migrations/0001_init.sql. */
export const SYNC_REMOTE_COLUMNS = 'id, user_id, version, updated_at, deleted_at, payload' as const;

export const SYNC_TABLE_BY_ENTITY: Record<SyncEntityKind, SyncTableName> = {
  provider: 'providers',
  model: 'models',
  agent: 'agents',
  conversation: 'conversations',
  message: 'messages',
  settings: 'settings',
};

/** Pull and push pass order, per the sync contract. */
export const SYNC_ENTITY_ORDER: readonly SyncEntityKind[] = [
  'provider',
  'model',
  'agent',
  'conversation',
  'message',
  'settings',
];

/** Human noun used in conflict summaries and status messages. */
export const ENTITY_NOUN: Record<SyncEntityKind, string> = {
  provider: 'provider',
  model: 'model',
  agent: 'agent',
  conversation: 'conversation',
  message: 'message',
  settings: 'settings',
};
