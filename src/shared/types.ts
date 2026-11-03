/**
 * Domain types shared by the Electron main process, the preload bridge and the
 * React renderer. Nothing here may import `electron`, `node:*` or browser
 * globals: the same module is consumed by all three surfaces, and by the future
 * web/mobile clients that reuse this data model.
 */

import type { MessageAttachment } from './attachments';

/* ------------------------------------------------------------------ ids ---- */

export type Id = string;

/* ------------------------------------------------------------- providers -- */

export const PROVIDER_KINDS = [
  'deepseek',
  'openai',
  'gemini',
  'anthropic',
  'openai-compatible',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Non-secret provider configuration. The API key is deliberately absent: it
 * lives only in the operating-system credential store behind the main process.
 */
export interface ProviderConfig {
  id: Id;
  kind: ProviderKind;
  /** Human label; the user may rename a provider instance. */
  name: string;
  /** Base URL used for every request. Validated, HTTPS-only by default. */
  baseUrl: string;
  enabled: boolean;
  /** True when a credential exists in the OS credential store. */
  hasKey: boolean;
  /** sha256(key) first 8 hex chars — lets the user see that a key changed. */
  keyFingerprint: string | null;
  keyUpdatedAt: string | null;
  /** Whether the adapter can enumerate models over the network. */
  supportsModelDiscovery: boolean;
  /** Generation parameters the adapter is able to forward. */
  supportedParams: GenParamKey[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  id?: Id;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  enabled?: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Round-trip duration of the probe request, milliseconds. */
  latencyMs: number | null;
  message: string;
  modelsFound: number | null;
  error: AppErrorShape | null;
}

/* ---------------------------------------------------------------- models -- */

export const GEN_PARAM_KEYS = [
  'temperature',
  'topP',
  'topK',
  'frequencyPenalty',
  'presencePenalty',
  'maxOutputTokens',
  'stop',
  'seed',
  'weirdness',
  'reasoningEffort',
] as const;

export type GenParamKey = (typeof GEN_PARAM_KEYS)[number];

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxOutputTokens?: number;
  stop?: string[];
  seed?: number;
  /**
   * Only forwarded when the selected model declares `weirdnessSupported`.
   * Never silently mapped onto another sampling parameter.
   */
  weirdness?: number;
  reasoningEffort?: ReasoningEffort;
}

/**
 * What a model can do. Every flag is an explicit declaration; absent means the
 * same as `false` (see `hasCapability`), and `src/shared/capabilities.ts` owns
 * the vocabulary, the task routing and the provenance wording.
 *
 * `chat` means text generation — the name predates the capability model and is
 * kept because stored rows, exported configs and tests already use it.
 */
export interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  imageInput: boolean;
  imageOutput: boolean;
  imageEditing: boolean;
  videoInput: boolean;
  videoOutput: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  embeddings: boolean;
  toolCalling: boolean;
}

export interface ModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ModelSource = 'catalog' | 'discovered' | 'custom';

export interface ModelDescriptor {
  /** Stable row id (`catalog:*`, `disc:*`, `custom:*`). */
  id: Id;
  providerId: Id;
  /** Exact identifier sent to the provider. Never rewritten. */
  modelId: string;
  displayName: string;
  source: ModelSource;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  description: string;
  /** Parameters this model is expected to honour. */
  supportedParams: GenParamKey[];
  weirdnessSupported: boolean;
  /** Only set for custom models that talk to their own endpoint. */
  baseUrlOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRef {
  providerId: Id;
  modelId: string;
}

export interface CustomModelInput {
  id?: Id;
  providerId: Id;
  displayName: string;
  modelId: string;
  baseUrlOverride?: string | null;
  description?: string;
  capabilities: ModelCapabilities;
  limits?: ModelLimits;
  supportedParams?: GenParamKey[];
  weirdnessSupported?: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number | null;
  /** Trimmed model reply, never a raw provider payload dump. */
  sample: string | null;
  error: AppErrorShape | null;
}

/* -------------------------------------------------------------- messages -- */

export type MessageRole = 'system' | 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error' | 'stopped';

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatMessage {
  id: Id;
  conversationId: Id;
  role: MessageRole;
  content: string;
  /** Monotonic per-conversation ordering key. */
  seq: number;
  status: MessageStatus;
  error: AppErrorShape | null;
  usage: TokenUsage | null;
  modelRef: ModelRef | null;
  /**
   * Files and images that belonged to this message. Empty for every message
   * created before attachments existed, which is why it is defaulted rather
   * than optional.
   */
  attachments: MessageAttachment[];
  createdAt: string;
  updatedAt: string;
}

/* --------------------------------------------------------- conversations -- */

export interface Conversation {
  id: Id;
  title: string;
  agentId: Id | null;
  providerId: Id | null;
  modelId: string | null;
  /** Per-conversation system prompt override. */
  systemPrompt: string | null;
  /** Conversation-level generation overrides (highest precedence). */
  paramsOverride: GenerationParams | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  syncState: SyncState;
}

export interface ConversationCreateInput {
  title?: string;
  agentId?: Id | null;
  providerId?: Id | null;
  modelId?: string | null;
  systemPrompt?: string | null;
}

export interface ConversationPatch {
  title?: string;
  agentId?: Id | null;
  providerId?: Id | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  paramsOverride?: GenerationParams | null;
}

/* ----------------------------------------------------------------- agents -- */

export interface Agent {
  id: Id;
  name: string;
  description: string;
  providerId: Id | null;
  modelId: string | null;
  systemPrompt: string;
  params: GenerationParams;
  createdAt: string;
  updatedAt: string;
  syncState: SyncState;
}

export interface AgentInput {
  id?: Id;
  name: string;
  description?: string;
  providerId?: Id | null;
  modelId?: string | null;
  systemPrompt: string;
  params?: GenerationParams;
}

/* --------------------------------------------------------------- settings -- */

export type ThemePreference = 'dark' | 'light' | 'system';
export type AppLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface GeneralSettings {
  theme: ThemePreference;
  sendOnEnter: boolean;
  reduceMotion: boolean;
}

export interface ChatSettings {
  streaming: boolean;
  showTokenUsage: boolean;
  autoTitleFromFirstMessage: boolean;
  defaultAgentId: Id | null;
}

export interface DefaultModelSettings {
  providerId: Id | null;
  modelId: string | null;
  params: GenerationParams;
}

export interface GenerationSettings {
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  /** How many prior messages may be replayed as context. */
  maxHistoryMessages: number;
  /** Approximate context budget in tokens, used to trim history. */
  historyTokenBudget: number;
  includeReasoning: boolean;
}

export interface WeirdnessSettings {
  /**
   * `off`  — the control is disabled wherever the model has no native support.
   * `creativityBias` — an application-level bias the app applies locally to
   * temperature/top-p and labels as such in the UI. It is not a model
   * parameter and must never be described as one.
   */
  mode: 'off' | 'creativityBias';
  bias: number;
}

export interface AdvancedSettings {
  logLevel: AppLogLevel;
  /** Reject plain-HTTP custom endpoints unless allowInsecureLocalhost. */
  requireHttpsForCustomEndpoints: boolean;
  allowInsecureLocalhost: boolean;
  /** Whether the app may send the request at all while offline is detected. */
  blockRequestsWhenOffline: boolean;
  /** Abort an idle stream that produced no bytes for this long. */
  streamIdleTimeoutMs: number;
}

export interface SyncSettings {
  enabled: boolean;
  supabaseUrl: string;
  autoSync: boolean;
  syncIntervalMs: number;
}

export interface AppSettings {
  schemaVersion: number;
  general: GeneralSettings;
  chat: ChatSettings;
  defaults: DefaultModelSettings;
  generation: GenerationSettings;
  weirdness: WeirdnessSettings;
  advanced: AdvancedSettings;
  sync: SyncSettings;
}

export type AppSettingsPatch = {
  [K in keyof Omit<AppSettings, 'schemaVersion'>]?: Partial<AppSettings[K]>;
};

/* -------------------------------------------------------------------- sync -- */

export type SyncState = 'local' | 'pending' | 'synced' | 'conflict' | 'error';

export type SyncEntityKind =
  | 'conversation'
  | 'message'
  | 'agent'
  | 'model'
  | 'provider'
  | 'settings';

export type SyncOperation = 'upsert' | 'delete';

export interface SyncQueueEntry {
  id: number;
  entity: SyncEntityKind;
  entityId: string;
  op: SyncOperation;
  payload: unknown;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
}

export interface SyncStatus {
  enabled: boolean;
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  phase: 'idle' | 'syncing' | 'error' | 'offline' | 'needs_config';
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt: string | null;
  lastError: AppErrorShape | null;
  online: boolean;
}

export interface SyncConflict {
  id: number;
  entity: SyncEntityKind;
  entityId: string;
  localRevision: number;
  remoteRevision: number;
  detectedAt: string;
  resolution: 'unresolved' | 'kept_local' | 'kept_remote';
  summary: string;
}

export interface SyncAuthInput {
  email: string;
  password: string;
}

export interface SyncConfigInput {
  supabaseUrl: string;
  /** Public anon key — stored in the OS credential store, never in SQLite. */
  anonKey: string;
}

/* ----------------------------------------------------------------- errors -- */

export type ErrorCode =
  | 'missing_key'
  | 'invalid_key'
  | 'rate_limited'
  | 'timeout'
  | 'offline'
  | 'model_not_found'
  | 'context_length'
  | 'provider_error'
  | 'bad_request'
  | 'cancelled'
  | 'not_found'
  | 'validation'
  | 'storage'
  | 'sync_auth'
  | 'sync_config'
  | 'unknown';

export interface AppErrorShape {
  code: ErrorCode;
  /** User-facing sentence. Never contains a credential. */
  message: string;
  retryable: boolean;
  providerId?: string;
  status?: number;
}

/* ------------------------------------------------------------------ chat --- */

/**
 * Chat errors are attached to the persisted assistant message as
 * `{type:'error'}`. The UI must never render an error as a successful reply.
 */
export interface ChatSendInput {
  conversationId: Id;
  content: string;
  /** Opaque ids returned by the attachment service. Resolved in the main process. */
  attachmentIds?: Id[];
  /** Optional per-send overrides; empty means "use resolved precedence". */
  modelRef?: ModelRef;
  paramsOverride?: GenerationParams;
  systemPromptOverride?: string;
}

export interface ChatSendResult {
  requestId: string;
  userMessageId: Id;
  assistantMessageId: Id;
}

export type ChatFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'aborted'
  | 'error';

export type ChatStreamEvent =
  | {
      type: 'start';
      requestId: string;
      conversationId: Id;
      userMessageId: Id;
      assistantMessageId: Id;
      providerId: string;
      modelId: string;
    }
  | { type: 'delta'; requestId: string; assistantMessageId: Id; text: string }
  | { type: 'usage'; requestId: string; assistantMessageId: Id; usage: TokenUsage }
  | {
      type: 'done';
      requestId: string;
      assistantMessageId: Id;
      finishReason: ChatFinishReason;
      message: ChatMessage;
    }
  | {
      type: 'error';
      requestId: string;
      assistantMessageId: Id;
      error: AppErrorShape;
      message: ChatMessage;
    };

/* ------------------------------------------------------------------ misc --- */

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  userDataPath: string;
  databasePath: string;
  logPath: string;
  packaged: boolean;
  /** Whether the OS credential store reported encryption as available. */
  secureStorageAvailable: boolean;
}

export interface AppPaths {
  userData: string;
  database: string;
  logs: string;
  credentials: string;
}

/**
 * Export format marker. `grenjo-ai-tool` is what this build writes; the previous
 * marker is still accepted on import so a configuration exported before the
 * rename stays importable.
 */
export type ConfigExportMarker = 'grenjo-ai-tool' | 'personal-ai-desk';

export interface ConfigExport {
  app: ConfigExportMarker;
  exportedAt: string;
  settings: AppSettings;
  providers: Array<Omit<ProviderConfig, 'hasKey' | 'keyFingerprint' | 'keyUpdatedAt'>>;
  agents: Agent[];
  customModels: Array<Omit<ModelDescriptor, 'source'>>;
  /** Explicitly records that credentials are excluded. */
  credentials: 'excluded';
}

export interface ConfigImportResult {
  applied: string[];
  skipped: string[];
  warnings: string[];
}
