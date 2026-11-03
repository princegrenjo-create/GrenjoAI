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
import type { GenerationJob, GenerationMedia } from './media';
import type { UpdateState } from './updates';
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
import type {
  AttachmentMeta,
  AttachmentPickResult,
  TranscriptionResult,
} from './attachments';

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

/**
 * Which kinds of file the native picker offers.
 *
 * This is a *dialog* hint, not a policy: it decides which files the OS shows,
 * and the attachment service still decides what is accepted once the user has
 * chosen. An omitted value means "no filter", which is what every caller that
 * does not pass one gets.
 *
 * The list is deliberately closed: a kind that is not in it is a validation
 * error at the IPC boundary, not a string the dialog is free to interpret.
 * Audio is absent on purpose — recordings arrive through the recorder, not a
 * file picker — even though the attachment service still accepts audio files.
 */
export const ATTACHMENT_PICK_KINDS = ['file', 'image'] as const;
export type AttachmentPickKind = (typeof ATTACHMENT_PICK_KINDS)[number];

/** Optional narrowing for the native picker. Omitted means "show everything". */
export interface AttachmentPickOptions {
  kinds?: AttachmentPickKind;
}

/**
 * Attachments. The renderer never sees a filesystem path and never reads a file
 * itself: the main process opens the picker, validates, reads and extracts, and
 * hands back opaque ids plus display metadata.
 */
export interface AttachmentsApi {
  /**
   * Opens the native picker and ingests the chosen files.
   *
   * `options.kinds` narrows which files the dialog offers. It never widens what
   * the attachment service accepts: a kind the schema rejects never reaches the
   * dialog, and a file the service refuses is still refused after the pick.
   */
  pick(options?: AttachmentPickOptions): Promise<AttachmentPickResult>;
  /** Ingests bytes the renderer already has (drag-and-drop, paste). */
  ingestBytes(input: AttachmentBytesInput): Promise<AttachmentPickResult>;
  /** Metadata for one pending attachment, or null when it is gone. */
  get(id: Id): Promise<AttachmentMeta | null>;
  /** Drops a pending attachment and its bytes. */
  remove(id: Id): Promise<void>;
  /** Re-reads an image for preview (also used for historical messages). */
  readImage(id: Id): Promise<{ dataUrl: string }>;
  /** Sends a recording to the configured transcription endpoint. */
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
  /** Providers that can transcribe, so the UI can explain a missing one. */
  transcriptionStatus(): Promise<TranscriptionStatus>;
}

export interface AttachmentBytesInput {
  name: string;
  mimeType: string;
  dataBase64: string;
  /** True when the renderer read the file as an image (used for validation). */
  kindHint?: 'image' | 'file';
}

export interface TranscriptionInput {
  dataBase64: string;
  mimeType: string;
  durationMs: number;
}

export interface TranscriptionStatus {
  available: boolean;
  /** Provider name when available, for "transcribed by …". */
  providerName: string | null;
  /** Sentence explaining what to configure when it is not available. */
  reason: string | null;
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

/**
 * Auto-update, driven entirely by explicit user actions.
 *
 * check() only asks the release feed; download() only downloads; install()
 * restarts into the downloaded build. Nothing here can install behind the user's
 * back, which is why there is no "auto install" member to call.
 */
export interface UpdatesApi {
  /** Current state, so the UI can render before the first event arrives. */
  state(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<{ restarting: boolean }>;
  setAutoCheck(enabled: boolean): Promise<UpdateState>;
  /** Returns an unsubscribe function. */
  onEvent(listener: (state: UpdateState) => void): () => void;
}

export interface AppApi {
  info(): Promise<AppInfo>;
  paths(): Promise<AppPaths>;
  openExternal(url: string): Promise<void>;
  quit(): Promise<void>;
}

/**
 * Generated media.
 *
 * Bytes never cross this bridge: list/get return rows, and the renderer shows
 * a file through the media:// protocol, so a 40 MB video is a normal resource
 * load rather than a 55 MB string.
 */
export interface MediaGenerateInput {
  task: 'image' | 'video';
  prompt: string;
  negativePrompt?: string | null;
  params?: Record<string, string | number | boolean | null>;
  providerId?: string;
  modelId?: string;
  conversationId?: string | null;
}

export interface MediaApi {
  list(filter?: { kind?: 'image' | 'video'; conversationId?: string }): Promise<GenerationMedia[]>;
  get(id: string): Promise<GenerationMedia | null>;
  jobs(limit?: number): Promise<GenerationJob[]>;
  /** Queues a generation and returns immediately: the UI is never blocked. */
  generate(input: MediaGenerateInput): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Saves a copy through the OS dialog; resolves to the path, or null if cancelled. */
  export(id: string): Promise<string | null>;
  reveal(id: string): Promise<boolean>;
  onEvent(listener: (job: GenerationJob) => void): () => void;
}

export interface DesktopApi {
  conversations: ConversationsApi;
  messages: MessagesApi;
  attachments: AttachmentsApi;
  chat: ChatApi;
  providers: ProvidersApi;
  models: ModelsApi;
  agents: AgentsApi;
  settings: SettingsApi;
  sync: SyncApi;
  media: MediaApi;
  updates: UpdatesApi;
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

  attachmentsPick: 'attachments:pick',
  attachmentsIngestBytes: 'attachments:ingest-bytes',
  attachmentsGet: 'attachments:get',
  attachmentsRemove: 'attachments:remove',
  attachmentsReadImage: 'attachments:read-image',
  attachmentsTranscribe: 'attachments:transcribe',
  attachmentsTranscriptionStatus: 'attachments:transcription-status',

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

  /* ------------------------------------------------------------- media -- */
  mediaList: 'media:list',
  mediaGet: 'media:get',
  mediaJobs: 'media:jobs',
  mediaGenerate: 'media:generate',
  mediaCancel: 'media:cancel',
  mediaRemove: 'media:remove',
  mediaExport: 'media:export',
  mediaReveal: 'media:reveal',
  /** main -> renderer */
  mediaEvent: 'media:event',

  /* ----------------------------------------------------------- updates -- */
  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesSetAutoCheck: 'updates:set-auto-check',
  /** main -> renderer */
  updatesEvent: 'updates:event',

  appInfo: 'app:info',
  appPaths: 'app:paths',
  appOpenExternal: 'app:open-external',
  appQuit: 'app:quit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
