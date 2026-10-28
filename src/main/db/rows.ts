/**
 * Row -> domain mappers.
 *
 * One place converts a SQLite row into a shared domain object, so a repository
 * method cannot invent a slightly different shape from its sibling. Every field
 * is coerced; a NULL or an old column shape produces the documented fallback
 * rather than an `undefined` on the object.
 */
import { PROVIDER_PRESETS } from '../../shared/defaults';
import { normaliseSettings } from '../../shared/settings';
import type {
  Agent,
  AppSettings,
  ChatMessage,
  Conversation,
  ModelDescriptor,
  ProviderConfig,
  SyncConflict,
  SyncEntityKind,
  SyncState,
} from '../../shared/types';
import { bool, nullableStr, num, parseJson, str, type DbRow } from './codec';
import {
  toAppErrorShape,
  toConflictResolution,
  toGenerationParams,
  toGenParamKeys,
  toMessageRole,
  toMessageStatus,
  toModelCapabilities,
  toModelLimits,
  toModelRef,
  toModelSource,
  toProviderKind,
  toSyncEntityKind,
  toTokenUsage,
} from './domain-codec';
import { DbError } from './errors';

/**
 * Durable outbox state rendered for the UI. `local` is not produced here: it is
 * a presentation decision for when sync is disabled, while these five reflect
 * what the store itself knows.
 */
export function syncStateOf(row: DbRow): SyncState {
  if (bool(row.has_conflict, false)) return 'conflict';
  if (bool(row.dirty, false)) {
    const attempts = num(row.attempts, 0);
    return attempts > 0 && nullableStr(row.last_error) !== null ? 'error' : 'pending';
  }
  return 'synced';
}

export function toConversation(row: DbRow): Conversation {
  return {
    id: str(row.id),
    title: str(row.title),
    agentId: nullableStr(row.agent_id),
    providerId: nullableStr(row.provider_id),
    modelId: nullableStr(row.model_id),
    systemPrompt: nullableStr(row.system_prompt),
    paramsOverride: toGenerationParams(row.params_override_json),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    messageCount: num(row.message_count, 0),
    syncState: syncStateOf(row),
  };
}

export function toChatMessage(row: DbRow): ChatMessage {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    role: toMessageRole(row.role),
    content: str(row.content),
    seq: num(row.seq, 0),
    status: toMessageStatus(row.status),
    error: toAppErrorShape(row.error_json),
    usage: toTokenUsage(row.usage_json),
    modelRef: toModelRef(row.model_json),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function toAgent(row: DbRow): Agent {
  return {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    providerId: nullableStr(row.provider_id),
    modelId: nullableStr(row.model_id),
    systemPrompt: str(row.system_prompt),
    params: toGenerationParams(row.params_json) ?? {},
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    syncState: syncStateOf(row),
  };
}

/**
 * `hasKey` is derived, never stored: the row keeps only the sha256 fingerprint
 * (first 8 hex chars) and the timestamp of the credential that lives in the OS
 * credential store. There is no key column to read.
 */
export function toProviderConfig(row: DbRow): ProviderConfig {
  const kind = toProviderKind(row.kind);
  const preset = PROVIDER_PRESETS[kind];
  return {
    id: str(row.id),
    kind,
    name: str(row.name, preset.defaultName),
    baseUrl: str(row.base_url, preset.defaultBaseUrl),
    enabled: bool(row.enabled, true),
    hasKey: nullableStr(row.key_fingerprint) !== null,
    keyFingerprint: nullableStr(row.key_fingerprint),
    keyUpdatedAt: nullableStr(row.key_updated_at),
    supportsModelDiscovery: preset.supportsModelDiscovery,
    supportedParams: [...preset.supportedParams],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function toModelDescriptor(row: DbRow): ModelDescriptor {
  const modelId = str(row.model_id);
  return {
    id: str(row.id),
    providerId: str(row.provider_id),
    modelId,
    displayName: str(row.display_name, modelId),
    source: toModelSource(row.source),
    capabilities: toModelCapabilities(parseJson(row.capabilities_json)),
    limits: toModelLimits(parseJson(row.limits_json)),
    description: str(row.description),
    supportedParams: toGenParamKeys(parseJson(row.supported_params_json)),
    weirdnessSupported: bool(row.weirdness_supported, false),
    baseUrlOverride: nullableStr(row.base_url_override),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function toAppSettings(row: DbRow | null): AppSettings {
  if (row === null) return normaliseSettings(null);
  return normaliseSettings(parseJson(row.json));
}

export function toSyncConflict(row: DbRow): SyncConflict {
  const entity = toSyncEntityKind(row.entity);
  if (entity === null) {
    throw new DbError('A stored sync conflict row has an unknown entity kind.', 'storage');
  }
  return {
    id: num(row.id),
    entity,
    entityId: str(row.entity_id),
    localRevision: num(row.local_revision),
    remoteRevision: num(row.remote_revision),
    detectedAt: str(row.detected_at),
    resolution: toConflictResolution(row.resolution),
    summary: str(row.summary),
  };
}

/**
 * Body pushed for a pending outbox row. Non-secret by construction: the
 * providers payload carries the fingerprint, never a credential, and the
 * settings payload is the normalised settings document.
 */
export function syncPayloadFor(entity: SyncEntityKind, row: DbRow): Record<string, unknown> {
  switch (entity) {
    case 'conversation':
      return {
        id: str(row.id),
        version: num(row.version),
        title: str(row.title),
        agentId: nullableStr(row.agent_id),
        providerId: nullableStr(row.provider_id),
        modelId: nullableStr(row.model_id),
        systemPrompt: nullableStr(row.system_prompt),
        paramsOverride: toGenerationParams(row.params_override_json),
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    case 'message':
      return {
        id: str(row.id),
        version: num(row.version),
        conversationId: str(row.conversation_id),
        role: toMessageRole(row.role),
        content: str(row.content),
        seq: num(row.seq),
        status: toMessageStatus(row.status),
        error: toAppErrorShape(row.error_json),
        usage: toTokenUsage(row.usage_json),
        modelRef: toModelRef(row.model_json),
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    case 'agent':
      return {
        id: str(row.id),
        version: num(row.version),
        name: str(row.name),
        description: str(row.description),
        providerId: nullableStr(row.provider_id),
        modelId: nullableStr(row.model_id),
        systemPrompt: str(row.system_prompt),
        params: toGenerationParams(row.params_json) ?? {},
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    case 'model':
      return {
        id: str(row.id),
        version: num(row.version),
        providerId: str(row.provider_id),
        modelId: str(row.model_id),
        displayName: str(row.display_name),
        source: toModelSource(row.source),
        capabilities: toModelCapabilities(parseJson(row.capabilities_json)),
        limits: toModelLimits(parseJson(row.limits_json)),
        supportedParams: toGenParamKeys(parseJson(row.supported_params_json)),
        weirdnessSupported: bool(row.weirdness_supported, false),
        baseUrlOverride: nullableStr(row.base_url_override),
        description: str(row.description),
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    case 'provider':
      return {
        id: str(row.id),
        version: num(row.version),
        kind: toProviderKind(row.kind),
        name: str(row.name),
        baseUrl: str(row.base_url),
        enabled: bool(row.enabled, true),
        keyFingerprint: nullableStr(row.key_fingerprint),
        keyUpdatedAt: nullableStr(row.key_updated_at),
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    case 'settings':
      return {
        id: str(row.id),
        version: num(row.version),
        settings: toAppSettings(row),
        updatedAt: str(row.updated_at),
        deletedAt: nullableStr(row.deleted_at),
      };
    default:
      throw new DbError('Unsupported sync entity kind.', 'validation');
  }
}
