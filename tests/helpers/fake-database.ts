/**
 * In-memory implementation of the `Database` contract for service-level tests.
 *
 * The real SQLite implementation is exercised by its own suite. This fake exists
 * so the chat, settings and IPC layers can be tested as logic — precedence,
 * persistence calls, error paths — without a file, and so a test can assert which
 * repository calls a service actually made.
 */
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { mergeSettings, normaliseSettings } from '@shared/settings';
import type { GenerationJob, GenerationMedia } from '@shared/media';
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
  MessageRole,
  MessageStatus,
  ModelDescriptor,
  ProviderConfig,
  ProviderInput,
  SyncConflict,
  SyncEntityKind,
  TokenUsage,
  SyncState,
} from '@shared/types';
import type {
  Database,
  RemoteApplyResult,
  RemoteEntity,
  SyncMetaStore,
  SyncPendingRow,
  WriteOptions,
} from '@shared/repository-contract';
import type {
  GenerationJobRepository,
  MediaRepository,
  MigrationRecord,
  SqlRunner,
} from '@shared/repository-contract';
import type { MessageAttachment } from '@shared/attachments';

const NOW = () => new Date().toISOString();

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface FakeDatabaseOptions {
  now?: () => string;
}

export interface FakeDatabase extends Database {
  /** Every method call, in order — lets a test assert persistence happened. */
  readonly calls: string[];
  readonly tables: {
    conversations: Map<string, Conversation>;
    messages: Map<string, ChatMessage>;
    agents: Map<string, Agent>;
    providers: Map<string, ProviderConfig>;
    models: Map<string, ModelDescriptor>;
    media: Map<string, GenerationMedia>;
    generationJobs: Map<string, GenerationJob>;
  };
}

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const now = options.now ?? NOW;
  const calls: string[] = [];
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, ChatMessage>();
  const agents = new Map<string, Agent>();
  const providers = new Map<string, ProviderConfig>();
  const models = new Map<string, ModelDescriptor>();
  const media = new Map<string, GenerationMedia>();
  const generationJobs = new Map<string, GenerationJob>();
  const conflicts = new Map<number, SyncConflict & { remotePayload?: unknown; resolution: SyncConflict['resolution'] }>();
  const dirty = new Set<string>();
  const meta = new Map<string, string>();
  let settings: AppSettings = normaliseSettings(DEFAULT_SETTINGS);
  let conflictSeq = 0;
  let messageSeq = 0;

  const syncStateOf = (id: string): SyncState => (dirty.has(id) ? 'pending' : 'local');

  function requireConversation(id: string): Conversation {
    const found = conversations.get(id);
    if (!found) throw new Error(`conversation ${id} not found`);
    return found;
  }

  const conversationsRepo: Database['conversations'] = {
    list(query) {
      calls.push('conversations.list');
      let rows = [...conversations.values()];
      const search = query?.search?.trim().toLowerCase();
      if (search) {
        rows = rows.filter((row) => {
          if (row.title.toLowerCase().includes(search)) return true;
          return [...messages.values()].some(
            (message) =>
              message.conversationId === row.id &&
              message.content.toLowerCase().includes(search),
          );
        });
      }
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return clone(query?.limit ? rows.slice(0, query.limit) : rows);
    },
    get(id) {
      calls.push('conversations.get');
      const row = conversations.get(id);
      return row ? clone(row) : null;
    },
    create(input: ConversationCreateInput) {
      calls.push('conversations.create');
      const at = now();
      const row: Conversation = {
        id: crypto.randomUUID(),
        title: input.title?.trim() || 'New conversation',
        agentId: input.agentId ?? null,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        systemPrompt: input.systemPrompt ?? null,
        paramsOverride: null,
        createdAt: at,
        updatedAt: at,
        messageCount: 0,
        syncState: 'pending',
      };
      conversations.set(row.id, row);
      dirty.add(row.id);
      return clone(row);
    },
    update(id, patch: ConversationPatch) {
      calls.push('conversations.update');
      const row = requireConversation(id);
      const next: Conversation = {
        ...row,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
        ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
        ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
        ...(patch.paramsOverride !== undefined ? { paramsOverride: patch.paramsOverride } : {}),
        updatedAt: now(),
        syncState: 'pending',
      };
      conversations.set(id, next);
      dirty.add(id);
      return clone(next);
    },
    touch(id) {
      calls.push('conversations.touch');
      const row = requireConversation(id);
      conversations.set(id, {
        ...row,
        updatedAt: now(),
        messageCount: countByConversation(id),
        syncState: 'pending',
      });
      dirty.add(id);
    },
    softDelete(id) {
      calls.push('conversations.softDelete');
      conversations.delete(id);
      dirty.add(id);
    },
    restore(id) {
      calls.push('conversations.restore');
      void id;
    },
    count() {
      return conversations.size;
    },
    autoTitle(id, title) {
      calls.push('conversations.autoTitle');
      const row = requireConversation(id);
      conversations.set(id, { ...row, title, updatedAt: now() });
      dirty.add(id);
    },
  };

  function countByConversation(conversationId: string): number {
    return [...messages.values()].filter((row) => row.conversationId === conversationId).length;
  }

  function nextSeq(conversationId: string): number {
    const seqs = [...messages.values()]
      .filter((row) => row.conversationId === conversationId)
      .map((row) => row.seq);
    return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
  }

  const messagesRepo: Database['messages'] = {
    listByConversation(conversationId) {
      calls.push('messages.listByConversation');
      return clone(
        [...messages.values()]
          .filter((row) => row.conversationId === conversationId)
          .sort((a, b) => a.seq - b.seq),
      );
    },
    get(id) {
      const row = messages.get(id);
      return row ? clone(row) : null;
    },
    append(input: {
      conversationId: string;
      role: MessageRole;
      content: string;
      status?: MessageStatus;
      modelRef?: { providerId: string; modelId: string } | null;
      attachments?: MessageAttachment[];
    }) {
      calls.push('messages.append');
      messageSeq += 1;
      const at = now();
      const row: ChatMessage = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        seq: nextSeq(input.conversationId),
        status: input.status ?? 'complete',
        error: null,
        usage: null,
        modelRef: input.modelRef ?? null,
        attachments: input.attachments ?? [],
        createdAt: at,
        updatedAt: at,
      };
      messages.set(row.id, row);
      dirty.add(row.id);
      return clone(row);
    },
    update(id, patch: { content?: string; status?: MessageStatus; error?: ChatMessage['error']; usage?: TokenUsage | null }) {
      calls.push('messages.update');
      const row = messages.get(id);
      if (!row) throw new Error(`message ${id} not found`);
      const next: ChatMessage = {
        ...row,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
        updatedAt: now(),
      };
      messages.set(id, next);
      dirty.add(id);
      return clone(next);
    },
    deleteByConversation(conversationId) {
      calls.push('messages.deleteByConversation');
      for (const [id, row] of messages) {
        if (row.conversationId === conversationId) messages.delete(id);
      }
    },
    countByConversation(conversationId) {
      return countByConversation(conversationId);
    },
  };

  const agentsRepo: Database['agents'] = {
    list() {
      calls.push('agents.list');
      return clone([...agents.values()]);
    },
    get(id) {
      const row = agents.get(id);
      return row ? clone(row) : null;
    },
    create(input: AgentInput) {
      calls.push('agents.create');
      const at = now();
      const row: Agent = {
        id: input.id ?? crypto.randomUUID(),
        name: input.name,
        description: input.description ?? '',
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        systemPrompt: input.systemPrompt,
        params: input.params ?? {},
        createdAt: at,
        updatedAt: at,
        syncState: 'pending',
      };
      agents.set(row.id, row);
      dirty.add(row.id);
      return clone(row);
    },
    update(id, input: AgentInput) {
      calls.push('agents.update');
      const row = agents.get(id);
      if (!row) throw new Error(`agent ${id} not found`);
      const next: Agent = {
        ...row,
        name: input.name,
        description: input.description ?? '',
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        systemPrompt: input.systemPrompt,
        params: input.params ?? {},
        updatedAt: now(),
        syncState: 'pending',
      };
      agents.set(id, next);
      dirty.add(id);
      return clone(next);
    },
    duplicate(id) {
      calls.push('agents.duplicate');
      const row = agents.get(id);
      if (!row) throw new Error(`agent ${id} not found`);
      return agentsRepo.create({ ...row, id: undefined, name: `${row.name} (copy)` });
    },
    softDelete(id) {
      calls.push('agents.softDelete');
      agents.delete(id);
      dirty.add(id);
    },
    count() {
      return agents.size;
    },
  };

  const modelsRepo: Database['models'] = {
    list(providerId) {
      calls.push('models.list');
      const rows = [...models.values()];
      return clone(providerId ? rows.filter((row) => row.providerId === providerId) : rows);
    },
    get(id) {
      const row = models.get(id);
      return row ? clone(row) : null;
    },
    findByRef(providerId, modelId) {
      calls.push('models.findByRef');
      const found = [...models.values()]
        .filter((row) => row.providerId === providerId && row.modelId === modelId)
        .sort((a, b) => (a.source === 'custom' ? -1 : b.source === 'custom' ? 1 : 0))[0];
      return found ? clone(found) : null;
    },
    upsert(input: CustomModelInput) {
      calls.push('models.upsert');
      const at = now();
      const existing = input.id ? models.get(input.id) : undefined;
      const row: ModelDescriptor = {
        id: existing?.id ?? input.id ?? crypto.randomUUID(),
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        source: 'custom',
        capabilities: input.capabilities,
        limits: input.limits ?? {},
        description: input.description ?? '',
        supportedParams: input.supportedParams ?? [],
        weirdnessSupported: input.weirdnessSupported ?? false,
        baseUrlOverride: input.baseUrlOverride ?? null,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      models.set(row.id, row);
      dirty.add(row.id);
      return clone(row);
    },
    softDelete(id) {
      calls.push('models.softDelete');
      models.delete(id);
      dirty.add(id);
    },
    replaceDiscovered(providerId, rows) {
      calls.push('models.replaceDiscovered');
      for (const [id, row] of models) {
        if (row.providerId === providerId && row.source === 'discovered') models.delete(id);
      }
      for (const row of rows) models.set(row.id, clone(row));
    },
    clearDiscovered(providerId) {
      calls.push('models.clearDiscovered');
      for (const [id, row] of models) {
        if (row.providerId === providerId && row.source === 'discovered') models.delete(id);
      }
    },
  };

  const providersRepo: Database['providers'] = {
    list() {
      calls.push('providers.list');
      return clone([...providers.values()]);
    },
    get(id) {
      calls.push('providers.get');
      const row = providers.get(id);
      return row ? clone(row) : null;
    },
    create(input: ProviderInput) {
      calls.push('providers.create');
      const at = now();
      const row: ProviderConfig = {
        id: input.id ?? crypto.randomUUID(),
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled ?? true,
        hasKey: false,
        keyFingerprint: null,
        keyUpdatedAt: null,
        supportsModelDiscovery: true,
        supportedParams: [],
        createdAt: at,
        updatedAt: at,
      };
      providers.set(row.id, row);
      dirty.add(row.id);
      return clone(row);
    },
    update(id, input: ProviderInput) {
      calls.push('providers.update');
      const row = providers.get(id);
      if (!row) throw new Error(`provider ${id} not found`);
      const next: ProviderConfig = {
        ...row,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled ?? row.enabled,
        updatedAt: now(),
      };
      providers.set(id, next);
      dirty.add(id);
      return clone(next);
    },
    recordKeyState(id, fingerprint, updatedAt) {
      calls.push('providers.recordKeyState');
      const row = providers.get(id);
      if (!row) return;
      providers.set(id, {
        ...row,
        hasKey: fingerprint !== null,
        keyFingerprint: fingerprint,
        keyUpdatedAt: updatedAt,
      });
    },
    softDelete(id) {
      calls.push('providers.softDelete');
      providers.delete(id);
      dirty.add(id);
    },
  };

  const settingsRepo: Database['settings'] = {
    get() {
      calls.push('settings.get');
      return clone(settings);
    },
    replace(next: AppSettings) {
      calls.push('settings.replace');
      settings = normaliseSettings(next);
      return clone(settings);
    },
    patch(patch: AppSettingsPatch) {
      calls.push('settings.patch');
      settings = mergeSettings(settings, patch);
      return clone(settings);
    },
    reset() {
      calls.push('settings.reset');
      settings = normaliseSettings(DEFAULT_SETTINGS);
      return clone(settings);
    },
  };

  const syncMeta: SyncMetaStore = {
    get: (key) => meta.get(key) ?? null,
    set: (key, value) => {
      meta.set(key, value);
    },
    delete: (key) => {
      meta.delete(key);
    },
  };

  const syncRepo: Database['sync'] = {
    pending(limit): SyncPendingRow[] {
      return [...dirty].slice(0, limit).map((id) => ({
        entity: 'conversation' as SyncEntityKind,
        entityId: id,
        version: 1,
        op: 'upsert' as const,
        payload: {},
      }));
    },
    pendingCount: () => dirty.size,
    markPushed(_entity, entityId) {
      dirty.delete(entityId);
    },
    markFailed() {
      /* no-op for the fake */
    },
    retryNow() {
      /* no-op */
    },
    applyRemote(_entity: SyncEntityKind, remote: RemoteEntity): RemoteApplyResult {
      const local = conversations.get(remote.id);
      if (!local) return 'ignored';
      if (dirty.has(remote.id)) {
        conflictSeq += 1;
        const conflict = {
          id: conflictSeq,
          entity: 'conversation' as SyncEntityKind,
          entityId: remote.id,
          localRevision: 1,
          remoteRevision: remote.version,
          detectedAt: now(),
          resolution: 'unresolved' as const,
          summary: 'both changed',
          remotePayload: remote.payload,
        };
        conflicts.set(conflict.id, conflict);
        return 'conflict';
      }
      return 'applied';
    },
    recordConflict() {
      /* covered by applyRemote in the fake */
    },
    conflicts() {
      return [...conflicts.values()].map((row) => ({
        id: row.id,
        entity: row.entity,
        entityId: row.entityId,
        localRevision: row.localRevision,
        remoteRevision: row.remoteRevision,
        detectedAt: row.detectedAt,
        resolution: row.resolution,
        summary: row.summary,
      }));
    },
    conflictCount: () => conflicts.size,
    resolveConflict(id, resolution) {
      const row = conflicts.get(id);
      if (row) conflicts.set(id, { ...row, resolution });
    },
    meta: syncMeta,
  };

  const sql: SqlRunner = {
    exec() {
      throw new Error('sql.exec is not available on the in-memory fake');
    },
    run() {
      throw new Error('sql.run is not available on the in-memory fake');
    },
    query<T>() {
      void (0 as unknown as T);
      throw new Error('sql.query is not available on the in-memory fake');
    },
    get<T>() {
      void (0 as unknown as T);
      throw new Error('sql.get is not available on the in-memory fake');
    },
  };

  let open = true;

  const mediaRepo: MediaRepository = {
    insert(input) {
      calls.push('media.insert');
      const row: GenerationMedia = {
        id: input.id ?? "media-" + String(media.size + 1),
        kind: input.kind,
        providerId: input.providerId,
        modelId: input.modelId,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt ?? null,
        params: { ...input.params },
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        bytes: input.bytes,
        sha256: input.sha256,
        mime: input.mime,
        relativePath: input.relativePath,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        jobId: input.jobId ?? null,
        providerJobId: input.providerJobId ?? null,
        createdAt: input.createdAt ?? now(),
      };
      media.set(row.id, row);
      return clone(row);
    },
    get(id) {
      const row = media.get(id);
      return row ? clone(row) : null;
    },
    list(filter = {}) {
      const rows = [...media.values()]
        .filter((row) => (filter.kind === undefined ? true : row.kind === filter.kind))
        .filter((row) =>
          filter.conversationId === undefined ? true : row.conversationId === filter.conversationId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return rows.slice(0, filter.limit ?? 200).map((row) => clone(row));
    },
    remove(id) {
      calls.push('media.remove');
      return media.delete(id);
    },
    totalBytes() {
      return [...media.values()].reduce((sum, row) => sum + row.bytes, 0);
    },
  };

  const jobsRepo: GenerationJobRepository = {
    insert(input) {
      calls.push('jobs.insert');
      const timestamp = now();
      const row: GenerationJob = {
        id: input.id ?? "job-" + String(generationJobs.size + 1),
        task: input.task,
        providerId: input.providerId,
        modelId: input.modelId,
        status: 'queued',
        progress: null,
        prompt: input.prompt,
        params: { ...input.params },
        remoteId: null,
        pollUrl: null,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        attempts: 0,
        nextPollAt: timestamp,
        mediaId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        finishedAt: null,
      };
      generationJobs.set(row.id, row);
      return clone(row);
    },
    get(id) {
      const row = generationJobs.get(id);
      return row ? clone(row) : null;
    },
    update(id, patch) {
      const row = generationJobs.get(id);
      if (!row) return null;
      const next = { ...row, ...patch, updatedAt: patch.updatedAt ?? now() } as GenerationJob;
      generationJobs.set(id, next);
      return clone(next);
    },
    listActive() {
      return [...generationJobs.values()]
        .filter((row) => row.status === 'queued' || row.status === 'running')
        .map((row) => clone(row));
    },
    listRecent(limit = 50) {
      return [...generationJobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((row) => clone(row));
    },
    remove(id) {
      return generationJobs.delete(id);
    },
  };

  const db: FakeDatabase = {
    filePath: ':memory:',
    calls,
    tables: { conversations, messages, agents, providers, models, media, generationJobs },
    sql,
    migrations: {
      version: () => 1,
      history: (): MigrationRecord[] => [{ version: 1, name: 'fake', appliedAt: now() }],
    },
    conversations: conversationsRepo,
    messages: messagesRepo,
    agents: agentsRepo,
    models: modelsRepo,
    providers: providersRepo,
    settings: settingsRepo,
    sync: syncRepo,
    media: mediaRepo,
    generationJobs: jobsRepo,
    transaction<T>(fn: () => T): T {
      return fn();
    },
    checkpoint() {
      /* nothing to flush */
    },
    close() {
      open = false;
    },
  };

  void open;
  void syncStateOf;
  void (undefined as unknown as WriteOptions);
  return db;
}
