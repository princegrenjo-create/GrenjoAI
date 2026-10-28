/**
 * The complete preload surface exposed to the renderer as `window.api`.
 *
 * Rules encoded by these signatures:
 *  - No method accepts or returns an API key. Keys are set once, forwarded
 *    straight to the OS credential store, and thereafter only reported as
 *    `hasKey` + `keyFingerprint`.
 *  - Every call returns a plain serialisable value or throws an AppErrorShape.
 *  - Streaming arrives as an event subscription, not as a callback handle, so a
 *    renderer reload cannot leave a dangling listener inside main.
 */
import type {
  Agent,
  AgentInput,
  AppInfo,
  AppPaths,
  AppSettings,
  AppSettingsPatch,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  ChatStreamEvent,
  ConfigExport,
  ConfigImportResult,
  ConnectionTestResult,
  Conversation,
  ConversationCreateInput,
  ConversationPatch,
  CustomModelInput,
  Id,
  ModelDescriptor,
  ModelRef,
  ModelTestResult,
  ProviderConfig,
  ProviderInput,
  SyncAuthInput,
  SyncConfigInput,
  SyncConflict,
  SyncStatus,
} from './types';
import type { DiscoveredModel as ProviderDiscoveredModel } from './provider-contract';
import type { AppErrorShape } from './types';

/**
 * Every IPC call resolves to this envelope. `ipcMain.handle` can only
 * serialise an Error message across the bridge, which would lose the error
 * code the UI needs to choose its state, so structured errors travel as data.
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorShape };

export interface ConversationsApi {
  list(options?: { search?: string; limit?: number }): Promise<Conversation[]>;
  get(id: Id): Promise<{ conversation: Conversation; messages: ChatMessage[] }>;
  create(input: ConversationCreateInput): Promise<Conversation>;
  update(id: Id, patch: ConversationPatch): Promise<Conversation>;
  remove(id: Id): Promise<void>;
}

export interface MessagesApi {
  list(conversationId: Id): Promise<ChatMessage[]>;
}

export interface ChatApi {
  send(input: ChatSendInput): Promise<ChatSendResult>;
  stop(requestId: string): Promise<void>;
  /** Returns an unsubscribe function. */
  onEvent(listener: (event: ChatStreamEvent) => void): () => void;
}

export interface ProvidersApi {
  list(): Promise<ProviderConfig[]>;
  upsert(input: ProviderInput): Promise<ProviderConfig>;
  remove(id: Id): Promise<void>;
  /** Stores the key in the OS credential store; never persisted elsewhere. */
  setKey(id: Id, apiKey: string): Promise<ProviderConfig>;
  clearKey(id: Id): Promise<ProviderConfig>;
  test(id: Id): Promise<ConnectionTestResult>;
  discoverModels(id: Id): Promise<ProviderDiscoveredModel[]>;
}

export interface ModelsApi {
  list(providerId?: Id): Promise<ModelDescriptor[]>;
  upsert(input: CustomModelInput): Promise<ModelDescriptor>;
  remove(id: Id): Promise<void>;
  /** Persist discovery results as `discovered` rows. */
  saveDiscovered(providerId: Id, models: ProviderDiscoveredModel[]): Promise<ModelDescriptor[]>;
  clearDiscovered(providerId: Id): Promise<void>;
  test(ref: ModelRef, prompt?: string): Promise<ModelTestResult>;
}

export interface AgentsApi {
  list(): Promise<Agent[]>;
  get(id: Id): Promise<Agent>;
  create(input: AgentInput): Promise<Agent>;
  update(id: Id, input: AgentInput): Promise<Agent>;
  duplicate(id: Id): Promise<Agent>;
  remove(id: Id): Promise<void>;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  patch(patch: AppSettingsPatch): Promise<AppSettings>;
  reset(): Promise<AppSettings>;
  /** Non-secret configuration only; the export records that keys are excluded. */
  exportConfig(): Promise<ConfigExport>;
  importConfig(json: string): Promise<ConfigImportResult>;
}

export interface SyncApi {
  status(): Promise<SyncStatus>;
  configure(input: SyncConfigInput): Promise<SyncStatus>;
  signIn(input: SyncAuthInput): Promise<SyncStatus>;
  signUp(input: SyncAuthInput): Promise<{ status: SyncStatus; needsConfirmation: boolean }>;
  signOut(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  conflicts(): Promise<SyncConflict[]>;
  resolveConflict(id: number, resolution: 'kept_local' | 'kept_remote'): Promise<SyncStatus>;
  onStatus(listener: (status: SyncStatus) => void): () => void;
}

export interface AppApi {
  info(): Promise<AppInfo>;
  paths(): Promise<AppPaths>;
  openExternal(url: string): Promise<void>;
  quit(): Promise<void>;
}

export interface DesktopApi {
  conversations: ConversationsApi;
  messages: MessagesApi;
  chat: ChatApi;
  providers: ProvidersApi;
  models: ModelsApi;
  agents: AgentsApi;
  settings: SettingsApi;
  sync: SyncApi;
  app: AppApi;
}

/* ---------------------------------------------------------------- channels -- */

export const IPC = {
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsRemove: 'conversations:remove',

  messagesList: 'messages:list',

  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  /** main -> renderer */
  chatEvent: 'chat:event',

  providersList: 'providers:list',
  providersUpsert: 'providers:upsert',
  providersRemove: 'providers:remove',
  providersSetKey: 'providers:set-key',
  providersClearKey: 'providers:clear-key',
  providersTest: 'providers:test',
  providersDiscoverModels: 'providers:discover-models',

  modelsList: 'models:list',
  modelsUpsert: 'models:upsert',
  modelsRemove: 'models:remove',
  modelsSaveDiscovered: 'models:save-discovered',
  modelsClearDiscovered: 'models:clear-discovered',
  modelsTest: 'models:test',

  agentsList: 'agents:list',
  agentsGet: 'agents:get',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsDuplicate: 'agents:duplicate',
  agentsRemove: 'agents:remove',

  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',

  syncStatus: 'sync:status',
  syncConfigure: 'sync:configure',
  syncSignIn: 'sync:sign-in',
  syncSignUp: 'sync:sign-up',
  syncSignOut: 'sync:sign-out',
  syncNow: 'sync:now',
  syncConflicts: 'sync:conflicts',
  syncResolveConflict: 'sync:resolve-conflict',
  /** main -> renderer */
  syncStatusEvent: 'sync:status-event',

  appInfo: 'app:info',
  appPaths: 'app:paths',
  appOpenExternal: 'app:open-external',
  appQuit: 'app:quit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
