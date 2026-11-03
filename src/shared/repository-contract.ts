/**
 * Persistence contract.
 *
 * The renderer never sees this: it is implemented by the Electron main process
 * against SQLite and consumed by the chat/sync/IPC services. Keeping it as a
 * pure interface lets a future web or mobile client implement the same methods
 * on top of a different store, and lets every repository be tested without
 * Electron.
 *
 * All methods are synchronous by design: `node:sqlite` is synchronous, and a
 * chat turn must not interleave a half-written message with another write.
 */
import type { GenerationJob, GenerationJobStatus, GenerationMedia, MediaKind, MediaParams } from './media';
import type {
  Agent,
  AgentInput,
  AppSettings,
  AppSettingsPatch,
  ChatMessage,
  Conversation,
  ConversationCreateInput,
  ConversationPatch,
  CustomModelInput,
  Id,
  MessageRole,
  MessageStatus,
  ModelDescriptor,
  ProviderConfig,
  ProviderInput,
  SyncConflict,
  SyncEntityKind,
  SyncOperation,
  TokenUsage,
  AppErrorShape,
} from './types';
import type { MessageAttachment } from './attachments';

/** A value bindable to a SQLite statement. */
export type SqlValue = string | number | null | Uint8Array;

export interface RunResult {
  changes: number;
}

/** Escape hatch used by the migration runner and by focused queries. */
export interface SqlRunner {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): RunResult;
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): T | null;
}

/**
 * `dirty` defaults to true: a local write is unsynchronised until the push
 * succeeds. Remote applies pass `{ dirty: false }` so they never echo back.
 */
export interface WriteOptions {
  dirty?: boolean;
}

export interface ConversationListOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationRepository {
  list(options?: ConversationListOptions): Conversation[];
  get(id: Id): Conversation | null;
  create(input: ConversationCreateInput, options?: WriteOptions): Conversation;
  update(id: Id, patch: ConversationPatch, options?: WriteOptions): Conversation;
  /** Bump `updated_at` after a message is appended. */
  touch(id: Id, options?: WriteOptions): void;
  /** Soft delete: writes `deleted_at` so the tombstone can synchronise. */
  softDelete(id: Id, options?: WriteOptions): void;
  restore(id: Id): void;
  count(): number;
  /** Auto-title from the first user message, only when the title is still default. */
  autoTitle(id: Id, title: string): void;
}

export interface AppendMessageInput {
  conversationId: Id;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  modelRef?: { providerId: Id; modelId: string } | null;
  /**
   * Files and images that belong to this message. Optional and defaulted to an
   * empty list, so every pre-attachment call site keeps working unchanged.
   */
  attachments?: MessageAttachment[];
}

export interface MessagePatch {
  content?: string;
  status?: MessageStatus;
  error?: AppErrorShape | null;
  usage?: TokenUsage | null;
  attachments?: MessageAttachment[];
}

export interface MessageRepository {
  listByConversation(conversationId: Id): ChatMessage[];
  get(id: Id): ChatMessage | null;
  append(input: AppendMessageInput, options?: WriteOptions): ChatMessage;
  update(id: Id, patch: MessagePatch, options?: WriteOptions): ChatMessage;
  /** Hard delete used when a conversation is purged locally. */
  deleteByConversation(conversationId: Id): void;
  countByConversation(conversationId: Id): number;
}

export interface AgentRepository {
  list(): Agent[];
  get(id: Id): Agent | null;
  create(input: AgentInput, options?: WriteOptions): Agent;
  update(id: Id, input: AgentInput, options?: WriteOptions): Agent;
  duplicate(id: Id): Agent;
  softDelete(id: Id, options?: WriteOptions): void;
  count(): number;
}

export interface CustomModelRepository {
  list(providerId?: Id): ModelDescriptor[];
  get(id: Id): ModelDescriptor | null;
  findByRef(providerId: Id, modelId: string): ModelDescriptor | null;
  upsert(input: CustomModelInput, options?: WriteOptions): ModelDescriptor;
  softDelete(id: Id, options?: WriteOptions): void;
  /** Persist auto-discovered models so the list survives a restart. */
  replaceDiscovered(providerId: Id, models: ModelDescriptor[]): void;
  clearDiscovered(providerId: Id): void;
}

export interface ProviderRepository {
  list(): ProviderConfig[];
  get(id: Id): ProviderConfig | null;
  create(input: ProviderInput, options?: WriteOptions): ProviderConfig;
  update(id: Id, input: ProviderInput, options?: WriteOptions): ProviderConfig;
  recordKeyState(id: Id, fingerprint: string | null, updatedAt: string | null): void;
  softDelete(id: Id, options?: WriteOptions): void;
}

export interface SettingsRepository {
  get(): AppSettings;
  replace(settings: AppSettings, options?: WriteOptions): AppSettings;
  patch(patch: AppSettingsPatch, options?: WriteOptions): AppSettings;
  reset(options?: WriteOptions): AppSettings;
}

export interface SyncPendingRow {
  entity: SyncEntityKind;
  entityId: string;
  version: number;
  op: SyncOperation;
  payload: unknown;
}

export interface RemoteEntity {
  id: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  /** Non-secret JSON body. Never contains a credential. */
  payload: unknown;
}

export type RemoteApplyResult = 'applied' | 'conflict' | 'ignored';

export interface SyncMetaStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/**
 * Durable outbox. The row itself is the queue entry: a local write sets
 * `dirty = 1`, the push clears it only on success, and a failure records
 * `attempts` / `next_attempt_at` on the same row. That is what makes an
 * interrupted sync resumable without a separate log that can diverge.
 */
export interface SyncRepository {
  pending(limit: number): SyncPendingRow[];
  pendingCount(): number;
  markPushed(entity: SyncEntityKind, entityId: string, pushedVersion: number): void;
  markFailed(entity: SyncEntityKind, entityId: string, error: string, nextAttemptAt: string): void;
  /** Reset a row so the next pass retries it immediately (used by "Sync now"). */
  retryNow(entity: SyncEntityKind, entityId: string): void;

  /**
   * Apply a server record.
   *  - remote newer, local clean  -> `applied`
   *  - remote newer, local dirty  -> `conflict` (never silently overwritten)
   *  - remote same or older       -> `ignored` (idempotent duplicate)
   */
  applyRemote(entity: SyncEntityKind, remote: RemoteEntity): RemoteApplyResult;
  recordConflict(input: {
    entity: SyncEntityKind;
    entityId: string;
    localRevision: number;
    remoteRevision: number;
    summary: string;
    remotePayload: unknown;
  }): void;
  conflicts(): SyncConflict[];
  conflictCount(): number;
  resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): void;
  meta: SyncMetaStore;
}

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

/* ------------------------------------------------------------ media (v0.2) -- */

/**
 * Generated media and the jobs that produce it.
 *
 * Local-only by design: these rows carry no sync header, because generated media
 * is never uploaded automatically. A job row is the durable record that lets an
 * in-flight video generation survive an app restart.
 */
export interface NewMediaInput {
  id?: Id;
  kind: MediaKind;
  providerId: Id;
  modelId: string;
  prompt: string;
  negativePrompt?: string | null;
  params: MediaParams;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  bytes: number;
  sha256: string;
  mime: string;
  /** Path relative to the media root. Absolute paths are rejected by the store. */
  relativePath: string;
  conversationId?: Id | null;
  messageId?: Id | null;
  jobId?: string | null;
  providerJobId?: string | null;
  createdAt?: string;
}

export interface MediaListFilter {
  kind?: MediaKind;
  conversationId?: Id;
  limit?: number;
}

export interface MediaRepository {
  insert(input: NewMediaInput): GenerationMedia;
  get(id: Id): GenerationMedia | null;
  list(filter?: MediaListFilter): GenerationMedia[];
  remove(id: Id): boolean;
  /** Sum of every stored file's size, for the disk budget. */
  totalBytes(): number;
}

export interface NewJobInput {
  id?: string;
  task: MediaKind;
  providerId: Id;
  modelId: string;
  prompt: string;
  params: MediaParams;
  /** Media rows to use as references; ids only, the bytes stay in the store. */
  referenceMediaIds?: Id[];
  maskMediaId?: Id | null;
  conversationId?: Id | null;
  messageId?: Id | null;
}

export interface JobPatch {
  status?: GenerationJobStatus;
  progress?: number | null;
  remoteId?: string | null;
  pollUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
  attempts?: number;
  nextPollAt?: string | null;
  mediaId?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
}

export interface GenerationJobRepository {
  insert(input: NewJobInput): GenerationJob;
  get(id: string): GenerationJob | null;
  update(id: string, patch: JobPatch): GenerationJob | null;
  /** Every job still queued or running: the crash-recovery work list. */
  listActive(): GenerationJob[];
  listRecent(limit?: number): GenerationJob[];
  remove(id: string): boolean;
}

export interface Database {
  readonly filePath: string;
  readonly sql: SqlRunner;
  readonly migrations: { version(): number; history(): MigrationRecord[] };
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly agents: AgentRepository;
  readonly models: CustomModelRepository;
  readonly providers: ProviderRepository;
  readonly settings: SettingsRepository;
  readonly sync: SyncRepository;
  readonly media: MediaRepository;
  readonly generationJobs: GenerationJobRepository;
  /** Runs `fn` inside one transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  /** Flush WAL pages to the main file (called before a backup or on quit). */
  checkpoint(): void;
  close(): void;
}

/** Entity -> primary table, used by the sync payload builders and tests. */
export const SYNC_ENTITIES: readonly SyncEntityKind[] = [
  'conversation',
  'message',
  'agent',
  'model',
  'provider',
  'settings',
];
