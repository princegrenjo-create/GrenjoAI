/**
 * A complete fake of the preload bridge. Every method is a vi.fn, streaming is
 * driven by `emit`, and the data shapes are the real shared types — no Electron
 * and no network anywhere.
 */
import { vi, type Mock } from 'vitest';
import type { DesktopApi } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { mergeSettings } from '@shared/settings';
import type {
  Agent,
  AppSettings,
  AppSettingsPatch,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  ChatStreamEvent,
  Conversation,
  ConversationCreateInput,
  ConversationPatch,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Plan the week',
    agentId: null,
    providerId: 'provider-1',
    modelId: 'deepseek-chat',
    systemPrompt: null,
    paramsOverride: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:05:00.000Z',
    messageCount: 0,
    syncState: 'local',
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: '',
    seq: 1,
    status: 'complete',
    error: null,
    usage: null,
    modelRef: null,
    createdAt: '2026-10-28T10:01:00.000Z',
    updatedAt: '2026-10-28T10:01:00.000Z',
    ...overrides,
  };
}

export function makeModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'catalog:deepseek-chat',
    providerId: 'provider-1',
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    source: 'catalog',
    capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: true },
    limits: { contextWindow: 128000, maxOutputTokens: 8192 },
    description: 'General-purpose chat model.',
    supportedParams: ['temperature', 'topP', 'maxOutputTokens'],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Writing partner',
    description: 'A terse editor.',
    providerId: null,
    modelId: null,
    systemPrompt: 'You are a terse editor.',
    params: {},
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    syncState: 'local',
    ...overrides,
  };
}

export interface FakeApiOptions {
  conversations?: Conversation[];
  messages?: Record<string, ChatMessage[]>;
  models?: ModelDescriptor[];
  agents?: Agent[];
  settings?: AppSettings;
  providers?: ProviderConfig[];
}

export interface FakeApi {
  api: DesktopApi;
  /** Typed handles on the mocks, for overriding a single call in a test. */
  mocks: {
    getConversation: Mock;
    listConversations: Mock;
    listModels: Mock;
    createConversation: Mock;
    updateConversation: Mock;
    removeConversation: Mock;
    chatSend: Mock;
    chatStop: Mock;
    openExternal: Mock;
  };
  /** Push a chat stream event to every subscribed listener. */
  emit(event: ChatStreamEvent): void;
  conversations: Conversation[];
  listenerCount(): number;
}

function notStubbed(name: string): never {
  throw new Error(`${name} is not stubbed for this test`);
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const listeners = new Set<(event: ChatStreamEvent) => void>();
  const conversations = (options.conversations ?? []).map((item) => ({ ...item }));
  const messages = new Map<string, ChatMessage[]>(
    Object.entries(options.messages ?? {}).map(([key, list]) => [key, [...list]]),
  );
  let settings: AppSettings = options.settings ?? DEFAULT_SETTINGS;
  let requestCounter = 0;
  let conversationCounter = 0;

  const listConversations = vi.fn(
    async (query?: { search?: string; limit?: number }): Promise<Conversation[]> => {
      const search = query?.search?.trim().toLowerCase();
      const matched = search
        ? conversations.filter((item) => item.title.toLowerCase().includes(search))
        : conversations;
      const limit = query?.limit ?? matched.length;
      return matched.slice(0, limit);
    },
  );

  const getConversation = vi.fn(
    async (id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> => {
      const conversation = conversations.find((item) => item.id === id);
      if (!conversation) throw new Error(`Conversation ${id} does not exist`);
      return { conversation, messages: messages.get(id) ?? [] };
    },
  );

  const createConversation = vi.fn(
    async (input: ConversationCreateInput): Promise<Conversation> => {
      conversationCounter += 1;
      const conversation = makeConversation({
        id: `conv-new-${conversationCounter}`,
        title: input.title ?? 'New conversation',
        agentId: input.agentId ?? null,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        messageCount: 0,
      });
      conversations.unshift(conversation);
      messages.set(conversation.id, []);
      return conversation;
    },
  );

  const updateConversation = vi.fn(
    async (id: string, patch: ConversationPatch): Promise<Conversation> => {
      const index = conversations.findIndex((item) => item.id === id);
      const existing = conversations[index];
      if (!existing) throw new Error(`Conversation ${id} does not exist`);
      const updated: Conversation = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      conversations[index] = updated;
      return updated;
    },
  );

  const removeConversation = vi.fn(async (id: string): Promise<void> => {
    const index = conversations.findIndex((item) => item.id === id);
    if (index >= 0) conversations.splice(index, 1);
    messages.delete(id);
  });

  const send = vi.fn(async (input: ChatSendInput): Promise<ChatSendResult> => {
    requestCounter += 1;
    void input;
    return {
      requestId: `req-${requestCounter}`,
      userMessageId: `user-${requestCounter}`,
      assistantMessageId: `asst-${requestCounter}`,
    };
  });

  const stop = vi.fn(async (requestId: string): Promise<void> => {
    void requestId;
  });

  const onEvent = vi.fn((listener: (event: ChatStreamEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  const listModels = vi.fn(async (providerId?: string) =>
    (options.models ?? []).filter((model) => !providerId || model.providerId === providerId),
  );

  const openExternal = vi.fn(async (url: string): Promise<void> => {
    void url;
  });

  const api: DesktopApi = {
    conversations: {
      list: listConversations,
      get: getConversation,
      create: createConversation,
      update: updateConversation,
      remove: removeConversation,
    },
    messages: {
      list: vi.fn(async (conversationId: string) => messages.get(conversationId) ?? []),
    },
    chat: { send, stop, onEvent },
    providers: {
      list: vi.fn(async () => options.providers ?? []),
      upsert: vi.fn(async () => notStubbed('providers.upsert')),
      remove: vi.fn(async () => notStubbed('providers.remove')),
      setKey: vi.fn(async () => notStubbed('providers.setKey')),
      clearKey: vi.fn(async () => notStubbed('providers.clearKey')),
      test: vi.fn(async () => notStubbed('providers.test')),
      discoverModels: vi.fn(async () => notStubbed('providers.discoverModels')),
    },
    models: {
      list: listModels,
      upsert: vi.fn(async () => notStubbed('models.upsert')),
      remove: vi.fn(async () => notStubbed('models.remove')),
      saveDiscovered: vi.fn(async () => notStubbed('models.saveDiscovered')),
      clearDiscovered: vi.fn(async () => notStubbed('models.clearDiscovered')),
      test: vi.fn(async () => notStubbed('models.test')),
    },
    agents: {
      list: vi.fn(async () => options.agents ?? []),
      get: vi.fn(async () => notStubbed('agents.get')),
      create: vi.fn(async () => notStubbed('agents.create')),
      update: vi.fn(async () => notStubbed('agents.update')),
      duplicate: vi.fn(async () => notStubbed('agents.duplicate')),
      remove: vi.fn(async () => notStubbed('agents.remove')),
    },
    settings: {
      get: vi.fn(async () => settings),
      patch: vi.fn(async (patch: AppSettingsPatch) => {
        settings = mergeSettings(settings, patch);
        return settings;
      }),
      reset: vi.fn(async () => {
        settings = DEFAULT_SETTINGS;
        return settings;
      }),
      exportConfig: vi.fn(async () => notStubbed('settings.exportConfig')),
      importConfig: vi.fn(async () => notStubbed('settings.importConfig')),
    },
    sync: {
      status: vi.fn(async () => notStubbed('sync.status')),
      configure: vi.fn(async () => notStubbed('sync.configure')),
      signIn: vi.fn(async () => notStubbed('sync.signIn')),
      signUp: vi.fn(async () => notStubbed('sync.signUp')),
      signOut: vi.fn(async () => notStubbed('sync.signOut')),
      syncNow: vi.fn(async () => notStubbed('sync.syncNow')),
      conflicts: vi.fn(async () => notStubbed('sync.conflicts')),
      resolveConflict: vi.fn(async () => notStubbed('sync.resolveConflict')),
      onStatus: vi.fn(() => () => undefined),
    },
    app: {
      info: vi.fn(async () => notStubbed('app.info')),
      paths: vi.fn(async () => notStubbed('app.paths')),
      openExternal,
      quit: vi.fn(async () => {
        return undefined;
      }),
    },
  };

  return {
    api,
    conversations,
    mocks: {
      getConversation,
      listConversations,
      listModels,
      createConversation,
      updateConversation,
      removeConversation,
      chatSend: send,
      chatStop: stop,
      openExternal,
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}
