/**
 * Domain-value coercion.
 *
 * Everything that crosses into the domain from a database row or a remote sync
 * payload is untrusted: a column can hold an old shape, and a server payload is
 * arbitrary JSON. These functions turn such a value into the shared domain type
 * or a documented fallback, so no `as` cast ever stands between stored bytes and
 * an `AppSettings` / `ChatMessage` / `ModelDescriptor`.
 */
import { GEN_PARAM_KEYS, PROVIDER_KINDS } from '../../shared/types';
import type {
  AppErrorShape,
  ErrorCode,
  GenParamKey,
  GenerationParams,
  MessageRole,
  MessageStatus,
  ModelCapabilities,
  ModelLimits,
  ModelRef,
  ModelSource,
  ProviderKind,
  ReasoningEffort,
  SyncEntityKind,
  SyncOperation,
  TokenUsage,
} from '../../shared/types';
import { bool, isOneOf, isRow, nullableStr, num, parseJsonObject, pickOneOf, stringArray } from './codec';

export const MODEL_SOURCES: readonly ModelSource[] = ['catalog', 'discovered', 'custom'];

export const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant'];

export const MESSAGE_STATUSES: readonly MessageStatus[] = ['complete', 'streaming', 'error', 'stopped'];

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export const SYNC_ENTITY_KINDS: readonly SyncEntityKind[] = [
  'conversation',
  'message',
  'agent',
  'model',
  'provider',
  'settings',
];

export const SYNC_OPERATIONS: readonly SyncOperation[] = ['upsert', 'delete'];

export const CONFLICT_RESOLUTIONS = ['unresolved', 'kept_local', 'kept_remote'] as const;

export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/** Mirrors `ErrorCode`; kept as a runtime list so a stored shape is checked. */
export const ERROR_CODES: readonly ErrorCode[] = [
  'missing_key',
  'invalid_key',
  'rate_limited',
  'timeout',
  'offline',
  'model_not_found',
  'context_length',
  'provider_error',
  'bad_request',
  'cancelled',
  'not_found',
  'validation',
  'storage',
  'sync_auth',
  'sync_config',
  'unknown',
];

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  chat: true,
  streaming: true,
  imageInput: false,
  toolCalling: false,
  imageOutput: false,
  imageEditing: false,
  videoInput: false,
  videoOutput: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isGenParamKey(value: unknown): value is GenParamKey {
  return typeof value === 'string' && GEN_PARAM_KEYS.some((key) => key === value);
}

export function toGenerationParams(value: unknown): GenerationParams | null {
  const row = parseJsonObject(value);
  if (!row) return null;

  const params: GenerationParams = {};
  const temperature = optionalNumber(row.temperature);
  if (temperature !== undefined) params.temperature = temperature;
  const topP = optionalNumber(row.topP);
  if (topP !== undefined) params.topP = topP;
  const topK = optionalNumber(row.topK);
  if (topK !== undefined) params.topK = topK;
  const frequencyPenalty = optionalNumber(row.frequencyPenalty);
  if (frequencyPenalty !== undefined) params.frequencyPenalty = frequencyPenalty;
  const presencePenalty = optionalNumber(row.presencePenalty);
  if (presencePenalty !== undefined) params.presencePenalty = presencePenalty;
  const maxOutputTokens = optionalNumber(row.maxOutputTokens);
  if (maxOutputTokens !== undefined) params.maxOutputTokens = maxOutputTokens;
  const seed = optionalNumber(row.seed);
  if (seed !== undefined) params.seed = seed;
  const weirdness = optionalNumber(row.weirdness);
  if (weirdness !== undefined) params.weirdness = weirdness;
  if (Array.isArray(row.stop)) params.stop = stringArray(row.stop);
  if (isOneOf(row.reasoningEffort, REASONING_EFFORTS)) params.reasoningEffort = row.reasoningEffort;
  return params;
}

export function toModelCapabilities(value: unknown): ModelCapabilities {
  const row = isRow(value) ? value : {};
  // Tolerant read: a row written before the capability model existed has the
  // original four flags and none of the others, and is still a valid chat model.
  return {
    chat: bool(row.chat, DEFAULT_MODEL_CAPABILITIES.chat),
    streaming: bool(row.streaming, DEFAULT_MODEL_CAPABILITIES.streaming),
    imageInput: bool(row.imageInput, DEFAULT_MODEL_CAPABILITIES.imageInput),
    toolCalling: bool(row.toolCalling, DEFAULT_MODEL_CAPABILITIES.toolCalling),
    imageOutput: bool(row.imageOutput, DEFAULT_MODEL_CAPABILITIES.imageOutput),
    imageEditing: bool(row.imageEditing, DEFAULT_MODEL_CAPABILITIES.imageEditing),
    videoInput: bool(row.videoInput, DEFAULT_MODEL_CAPABILITIES.videoInput),
    videoOutput: bool(row.videoOutput, DEFAULT_MODEL_CAPABILITIES.videoOutput),
    audioInput: bool(row.audioInput, DEFAULT_MODEL_CAPABILITIES.audioInput),
    audioOutput: bool(row.audioOutput, DEFAULT_MODEL_CAPABILITIES.audioOutput),
    embeddings: bool(row.embeddings, DEFAULT_MODEL_CAPABILITIES.embeddings),
  };
}

export function toModelLimits(value: unknown): ModelLimits {
  if (!isRow(value)) return {};
  const limits: ModelLimits = {};
  const contextWindow = optionalNumber(value.contextWindow);
  if (contextWindow !== undefined) limits.contextWindow = contextWindow;
  const maxOutputTokens = optionalNumber(value.maxOutputTokens);
  if (maxOutputTokens !== undefined) limits.maxOutputTokens = maxOutputTokens;
  return limits;
}

export function toGenParamKeys(value: unknown): GenParamKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isGenParamKey);
}

export function toAppErrorShape(value: unknown): AppErrorShape | null {
  const row = parseJsonObject(value);
  if (!row) return null;
  if (!isOneOf(row.code, ERROR_CODES)) return null;
  const shape: AppErrorShape = {
    code: row.code,
    message: typeof row.message === 'string' ? row.message : '',
    retryable: bool(row.retryable, false),
  };
  const providerId = nullableStr(row.providerId);
  if (providerId !== null) shape.providerId = providerId;
  const status = optionalNumber(row.status);
  if (status !== undefined) shape.status = status;
  return shape;
}

export function toTokenUsage(value: unknown): TokenUsage | null {
  const row = parseJsonObject(value);
  if (!row) return null;
  const usage: TokenUsage = {};
  const promptTokens = optionalNumber(row.promptTokens);
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;
  const completionTokens = optionalNumber(row.completionTokens);
  if (completionTokens !== undefined) usage.completionTokens = completionTokens;
  const totalTokens = optionalNumber(row.totalTokens);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return usage;
}

export function toModelRef(value: unknown): ModelRef | null {
  const row = parseJsonObject(value);
  if (!row) return null;
  const providerId = nullableStr(row.providerId);
  const modelId = nullableStr(row.modelId);
  if (providerId === null || modelId === null || modelId.length === 0) return null;
  return { providerId, modelId };
}

export function toProviderKind(value: unknown): ProviderKind {
  return pickOneOf(value, PROVIDER_KINDS, 'openai-compatible');
}

export function toMessageRole(value: unknown): MessageRole {
  return pickOneOf(value, MESSAGE_ROLES, 'user');
}

export function toMessageStatus(value: unknown): MessageStatus {
  return pickOneOf(value, MESSAGE_STATUSES, 'complete');
}

export function toModelSource(value: unknown): ModelSource {
  return pickOneOf(value, MODEL_SOURCES, 'custom');
}

export function toSyncEntityKind(value: unknown): SyncEntityKind | null {
  return isOneOf(value, SYNC_ENTITY_KINDS) ? value : null;
}

export function toSyncOperation(value: unknown): SyncOperation {
  return pickOneOf(value, SYNC_OPERATIONS, 'upsert');
}

export function toConflictResolution(value: unknown): ConflictResolution {
  return pickOneOf(value, CONFLICT_RESOLUTIONS, 'unresolved');
}

/** Shape guard for a stored `seq`, which must be a positive integer. */
export function toSeq(value: unknown): number | null {
  const candidate = num(value, 0);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}
