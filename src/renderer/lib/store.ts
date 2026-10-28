/**
 * Renderer stores.
 *
 * Four atoms, one writer each:
 *  - shell:         the route (fed by the hash listener) and layout toggles
 *  - settings:      the AppSettings snapshot and its patch path
 *  - conversations: the conversation list and its search
 *  - chat:          the open conversation's message entries, streaming state
 *                   and the model/agent catalogue the chat header needs
 *
 * No component mirrors props into a store and no two stores own the same value:
 * the open conversation object lives only in the conversations store, and the
 * chat store references it by id.
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { toAppError } from '@shared/errors';
import type {
  Agent,
  AppErrorShape,
  AppSettings,
  AppSettingsPatch,
  ChatMessage,
  ChatStreamEvent,
  Conversation,
  MessageRole,
  MessageStatus,
  ModelDescriptor,
  TokenUsage,
} from '@shared/types';
import { getApi } from './api';
import { errorSummary } from './error-copy';
import { parseHash, routeToHash, routesEqual, type Route } from './router';
import { toast } from './toast';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/* ------------------------------------------------------------------ shell -- */

interface ShellState {
  route: Route;
  /** The conversation column inside the chat page; a layout toggle only. */
  conversationsVisible: boolean;
  setRoute(route: Route): void;
  navigate(route: Route): void;
  toggleConversations(): void;
}

function readInitialRoute(): Route {
  if (typeof window === 'undefined') return { name: 'chat', conversationId: null };
  return parseHash(window.location.hash);
}

export const useShellStore = create<ShellState>((set, get) => ({
  route: readInitialRoute(),
  conversationsVisible: true,
  setRoute(route) {
    if (!routesEqual(get().route, route)) set({ route });
  },
  navigate(route) {
    if (typeof window !== 'undefined') {
      const hash = routeToHash(route);
      if (window.location.hash !== hash) window.location.hash = hash;
    }
    get().setRoute(route);
  },
  toggleConversations() {
    set((state) => ({ conversationsVisible: !state.conversationsVisible }));
  },
}));

/* --------------------------------------------------------------- settings -- */

interface SettingsState {
  status: LoadStatus;
  settings: AppSettings;
  error: AppErrorShape | null;
  load(): Promise<void>;
  patch(patch: AppSettingsPatch): Promise<boolean>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  status: 'idle',
  settings: DEFAULT_SETTINGS,
  error: null,
  async load() {
    set({ status: 'loading', error: null });
    try {
      const settings = await getApi().settings.get();
      set({ settings, status: 'ready', error: null });
    } catch (error) {
      set({ status: 'error', error: toAppError(error) });
    }
  },
  async patch(patch) {
    try {
      const settings = await getApi().settings.patch(patch);
      set({ settings, status: 'ready', error: null });
      return true;
    } catch (error) {
      const shaped = toAppError(error);
      set({ error: shaped });
      toast.danger('The setting was not saved', errorSummary(shaped));
      return false;
    }
  },
}));

/* ---------------------------------------------------------- conversations -- */

let listRequest = 0;

interface ConversationsState {
  status: LoadStatus;
  items: Conversation[];
  search: string;
  error: AppErrorShape | null;
  load(): Promise<void>;
  setSearch(search: string): Promise<void>;
  upsert(conversation: Conversation): void;
  create(): Promise<string | null>;
  rename(id: string, title: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  touch(id: string): void;
}

export const useConversationsStore = create<ConversationsState>((set, get) => ({
  status: 'idle',
  items: [],
  search: '',
  error: null,
  async load() {
    const ticket = listRequest + 1;
    listRequest = ticket;
    const search = get().search.trim();
    set({ status: 'loading', error: null });
    try {
      const items = await getApi().conversations.list(search ? { search } : undefined);
      if (ticket !== listRequest) return;
      set({ items, status: 'ready', error: null });
    } catch (error) {
      if (ticket !== listRequest) return;
      set({ status: 'error', error: toAppError(error) });
    }
  },
  async setSearch(search) {
    set({ search });
    await get().load();
  },
  upsert(conversation) {
    set((state) => ({
      items: [conversation, ...state.items.filter((item) => item.id !== conversation.id)],
    }));
  },
  async create() {
    try {
      const conversation = await getApi().conversations.create({});
      get().upsert(conversation);
      set({ status: 'ready', error: null });
      return conversation.id;
    } catch (error) {
      toast.danger('Could not start a conversation', errorSummary(toAppError(error)));
      return null;
    }
  },
  async rename(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return false;
    try {
      const conversation = await getApi().conversations.update(id, { title: trimmed });
      get().upsert(conversation);
      toast.success('Conversation renamed');
      return true;
    } catch (error) {
      toast.danger('The conversation was not renamed', errorSummary(toAppError(error)));
      return false;
    }
  },
  async remove(id) {
    try {
      await getApi().conversations.remove(id);
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
      toast.success('Conversation deleted');
      return true;
    } catch (error) {
      toast.danger('The conversation was not deleted', errorSummary(toAppError(error)));
      return false;
    }
  },
  touch(id) {
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              messageCount: item.messageCount + 2,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    }));
  },
}));

/* ------------------------------------------------------------------- chat -- */

export interface ChatEntry {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error: AppErrorShape | null;
  usage: TokenUsage | null;
  seq: number;
  createdAt: string;
}

interface PendingSend {
  requestId: string | null;
  assistantLocalId: string;
  userLocalId: string;
}

interface ChatState {
  conversationId: string | null;
  entries: ChatEntry[];
  status: LoadStatus;
  error: AppErrorShape | null;
  isSending: boolean;
  activeRequestId: string | null;
  pending: PendingSend | null;
  models: ModelDescriptor[];
  agents: Agent[];
  catalogStatus: LoadStatus;
  catalogError: AppErrorShape | null;
  loadCatalog(): Promise<void>;
  open(conversationId: string): Promise<void>;
  reload(): Promise<void>;
  close(): void;
  send(content: string): Promise<void>;
  stop(): Promise<void>;
  retryLast(): Promise<void>;
  setModel(providerId: string | null, modelId: string | null): Promise<void>;
  setAgent(agentId: string | null): Promise<void>;
  applyEvent(event: ChatStreamEvent): void;
}

let localSequence = 0;
let openRequest = 0;

function fromMessage(message: ChatMessage): ChatEntry {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    error: message.error,
    usage: message.usage,
    seq: message.seq,
    createdAt: message.createdAt,
  };
}

function patchEntry(entries: ChatEntry[], id: string, patch: Partial<ChatEntry>): ChatEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

/**
 * Which entry a stream event belongs to. Events carry the persisted assistant
 * message id; while the optimistic placeholder still carries its local id the
 * pending send is the fallback.
 */
function targetEntryId(
  entries: ChatEntry[],
  pending: PendingSend | null,
  assistantMessageId: string,
): string | null {
  if (entries.some((entry) => entry.id === assistantMessageId)) return assistantMessageId;
  return pending ? pending.assistantLocalId : null;
}

function finishedStatus(finishReason: string): MessageStatus {
  return finishReason === 'aborted' ? 'stopped' : 'complete';
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  entries: [],
  status: 'idle',
  error: null,
  isSending: false,
  activeRequestId: null,
  pending: null,
  models: [],
  agents: [],
  catalogStatus: 'idle',
  catalogError: null,

  async loadCatalog() {
    set({ catalogStatus: 'loading', catalogError: null });
    try {
      const api = getApi();
      const [models, agents] = await Promise.all([api.models.list(), api.agents.list()]);
      set({ models, agents, catalogStatus: 'ready', catalogError: null });
    } catch (error) {
      set({ catalogStatus: 'error', catalogError: toAppError(error) });
    }
  },

  async open(conversationId) {
    const ticket = openRequest + 1;
    openRequest = ticket;
    set({
      conversationId,
      entries: [],
      status: 'loading',
      error: null,
      isSending: false,
      activeRequestId: null,
      pending: null,
    });
    try {
      const result = await getApi().conversations.get(conversationId);
      if (ticket !== openRequest) return;
      useConversationsStore.getState().upsert(result.conversation);
      set({ entries: result.messages.map(fromMessage), status: 'ready', error: null });
    } catch (error) {
      if (ticket !== openRequest) return;
      set({ status: 'error', error: toAppError(error) });
    }
  },

  async reload() {
    const id = get().conversationId;
    if (id) await get().open(id);
  },

  close() {
    openRequest += 1;
    set({
      conversationId: null,
      entries: [],
      status: 'idle',
      error: null,
      isSending: false,
      activeRequestId: null,
      pending: null,
    });
  },

  async send(content) {
    const state = get();
    const conversationId = state.conversationId;
    const text = content.trim();
    if (!conversationId || state.isSending || text.length === 0) return;

    localSequence += 1;
    const userLocalId = `local-user-${localSequence}`;
    const assistantLocalId = `local-assistant-${localSequence}`;
    const lastEntry = state.entries[state.entries.length - 1];
    const baseSeq = (lastEntry ? lastEntry.seq : 0) + 1;
    const now = new Date().toISOString();

    const userEntry: ChatEntry = {
      id: userLocalId,
      role: 'user',
      content: text,
      status: 'complete',
      error: null,
      usage: null,
      seq: baseSeq,
      createdAt: now,
    };
    const assistantEntry: ChatEntry = {
      id: assistantLocalId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      error: null,
      usage: null,
      seq: baseSeq + 1,
      createdAt: now,
    };

    set({
      entries: [...state.entries, userEntry, assistantEntry],
      isSending: true,
      error: null,
      pending: { requestId: null, assistantLocalId, userLocalId },
    });

    try {
      const result = await getApi().chat.send({ conversationId, content: text });
      const pending = get().pending;
      if (pending && pending.assistantLocalId === assistantLocalId) {
        set({ pending: { ...pending, requestId: result.requestId } });
      }
      if (get().pending) set({ activeRequestId: result.requestId });
    } catch (error) {
      const shaped = toAppError(error);
      set((current) => ({
        entries: patchEntry(current.entries, assistantLocalId, { status: 'error', error: shaped }),
        isSending: false,
        activeRequestId: null,
        pending: null,
      }));
    }
  },

  async stop() {
    const state = get();
    const requestId = state.activeRequestId ?? state.pending?.requestId ?? null;
    if (!requestId) return;
    try {
      await getApi().chat.stop(requestId);
    } catch (error) {
      toast.danger('The request was not stopped', errorSummary(toAppError(error)));
    }
  },

  async retryLast() {
    const entries = get().entries;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry && entry.role === 'user') {
        await get().send(entry.content);
        return;
      }
    }
  },

  async setModel(providerId, modelId) {
    const conversationId = get().conversationId;
    if (!conversationId) return;
    try {
      const conversation = await getApi().conversations.update(conversationId, {
        providerId,
        modelId,
      });
      useConversationsStore.getState().upsert(conversation);
    } catch (error) {
      toast.danger('The model was not changed', errorSummary(toAppError(error)));
    }
  },

  async setAgent(agentId) {
    const conversationId = get().conversationId;
    if (!conversationId) return;
    try {
      const conversation = await getApi().conversations.update(conversationId, { agentId });
      useConversationsStore.getState().upsert(conversation);
    } catch (error) {
      toast.danger('The agent was not changed', errorSummary(toAppError(error)));
    }
  },

  applyEvent(event) {
    const state = get();
    switch (event.type) {
      case 'start': {
        const pending = state.pending;
        set({
          activeRequestId: event.requestId,
          pending: {
            requestId: event.requestId,
            assistantLocalId: event.assistantMessageId,
            userLocalId: pending ? pending.userLocalId : event.userMessageId,
          },
          entries: pending
            ? state.entries.map((entry) => {
                if (entry.id === pending.assistantLocalId) {
                  return { ...entry, id: event.assistantMessageId };
                }
                if (entry.id === pending.userLocalId) {
                  return { ...entry, id: event.userMessageId };
                }
                return entry;
              })
            : state.entries,
        });
        break;
      }
      case 'delta': {
        const target = targetEntryId(state.entries, state.pending, event.assistantMessageId);
        if (!target) break;
        set({
          entries: state.entries.map((entry) =>
            entry.id === target
              ? { ...entry, content: entry.content + event.text, status: 'streaming' }
              : entry,
          ),
        });
        break;
      }
      case 'usage': {
        const target = targetEntryId(state.entries, state.pending, event.assistantMessageId);
        if (!target) break;
        set({ entries: patchEntry(state.entries, target, { usage: event.usage }) });
        break;
      }
      case 'done': {
        const target = targetEntryId(state.entries, state.pending, event.assistantMessageId);
        set({
          entries: target
            ? state.entries.map((entry) =>
                entry.id === target
                  ? {
                      ...entry,
                      content:
                        event.message.content.length > 0 ? event.message.content : entry.content,
                      status: finishedStatus(event.finishReason),
                      error: event.message.error,
                      usage: event.message.usage ?? entry.usage,
                    }
                  : entry,
              )
            : state.entries,
          isSending: false,
          activeRequestId: null,
          pending: null,
        });
        if (state.conversationId) {
          useConversationsStore.getState().touch(state.conversationId);
        }
        break;
      }
      case 'error': {
        const target = targetEntryId(state.entries, state.pending, event.assistantMessageId);
        set({
          entries: target
            ? state.entries.map((entry) =>
                entry.id === target
                  ? {
                      ...entry,
                      content: event.message.content || entry.content,
                      status: 'error',
                      error: event.error,
                    }
                  : entry,
              )
            : state.entries,
          isSending: false,
          activeRequestId: null,
          pending: null,
        });
        if (state.conversationId) {
          useConversationsStore.getState().touch(state.conversationId);
        }
        break;
      }
      default:
        break;
    }
  },
}));
