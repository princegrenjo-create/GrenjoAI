/**
 * Settings composition: default-fill, range normalisation, patch merge and the
 * "requires restart" map. Pure functions so the settings service and its tests
 * share one implementation.
 */
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from './defaults';
import type {
  AdvancedSettings,
  AppSettings,
  AppSettingsPatch,
  ChatSettings,
  DefaultModelSettings,
  GeneralSettings,
  GenerationSettings,
  SyncSettings,
  WeirdnessSettings,
} from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function normaliseGeneral(raw: unknown): GeneralSettings {
  const d = DEFAULT_SETTINGS.general;
  if (!isObject(raw)) return { ...d };
  return {
    theme: pickString(raw.theme, ['dark', 'light', 'system'] as const, d.theme),
    sendOnEnter: pickBoolean(raw.sendOnEnter, d.sendOnEnter),
    reduceMotion: pickBoolean(raw.reduceMotion, d.reduceMotion),
  };
}

export function normaliseChat(raw: unknown): ChatSettings {
  const d = DEFAULT_SETTINGS.chat;
  if (!isObject(raw)) return { ...d };
  return {
    streaming: pickBoolean(raw.streaming, d.streaming),
    showTokenUsage: pickBoolean(raw.showTokenUsage, d.showTokenUsage),
    autoTitleFromFirstMessage: pickBoolean(
      raw.autoTitleFromFirstMessage,
      d.autoTitleFromFirstMessage,
    ),
    defaultAgentId:
      typeof raw.defaultAgentId === 'string' && raw.defaultAgentId.length <= 128
        ? raw.defaultAgentId
        : null,
  };
}

export function normaliseDefaults(raw: unknown): DefaultModelSettings {
  const d = DEFAULT_SETTINGS.defaults;
  if (!isObject(raw)) return { ...d, params: { ...d.params } };
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.length <= 128 ? raw.providerId : null,
    modelId: typeof raw.modelId === 'string' && raw.modelId.length <= 200 ? raw.modelId : null,
    params: isObject(raw.params) ? { ...raw.params } : { ...d.params },
  };
}

export function normaliseGeneration(raw: unknown): GenerationSettings {
  const d = DEFAULT_SETTINGS.generation;
  if (!isObject(raw)) return { ...d };
  return {
    requestTimeoutMs: pickNumber(raw.requestTimeoutMs, d.requestTimeoutMs, 1000, 600000),
    maxRetries: pickNumber(raw.maxRetries, d.maxRetries, 0, 5),
    retryBackoffMs: pickNumber(raw.retryBackoffMs, d.retryBackoffMs, 0, 60000),
    maxHistoryMessages: pickNumber(raw.maxHistoryMessages, d.maxHistoryMessages, 1, 500),
    historyTokenBudget: pickNumber(raw.historyTokenBudget, d.historyTokenBudget, 1000, 2000000),
    includeReasoning: pickBoolean(raw.includeReasoning, d.includeReasoning),
  };
}

export function normaliseWeirdness(raw: unknown): WeirdnessSettings {
  const d = DEFAULT_SETTINGS.weirdness;
  if (!isObject(raw)) return { ...d };
  return {
    mode: pickString(raw.mode, ['off', 'creativityBias'] as const, d.mode),
    bias: typeof raw.bias === 'number' ? Math.min(1, Math.max(0, raw.bias)) : d.bias,
  };
}

export function normaliseAdvanced(raw: unknown): AdvancedSettings {
  const d = DEFAULT_SETTINGS.advanced;
  if (!isObject(raw)) return { ...d };
  return {
    logLevel: pickString(raw.logLevel, ['error', 'warn', 'info', 'debug'] as const, d.logLevel),
    requireHttpsForCustomEndpoints: pickBoolean(
      raw.requireHttpsForCustomEndpoints,
      d.requireHttpsForCustomEndpoints,
    ),
    allowInsecureLocalhost: pickBoolean(raw.allowInsecureLocalhost, d.allowInsecureLocalhost),
    blockRequestsWhenOffline: pickBoolean(raw.blockRequestsWhenOffline, d.blockRequestsWhenOffline),
    streamIdleTimeoutMs: pickNumber(raw.streamIdleTimeoutMs, d.streamIdleTimeoutMs, 5000, 600000),
  };
}

export function normaliseSync(raw: unknown): SyncSettings {
  const d = DEFAULT_SETTINGS.sync;
  if (!isObject(raw)) return { ...d };
  const url = typeof raw.supabaseUrl === 'string' ? raw.supabaseUrl.slice(0, 2048) : d.supabaseUrl;
  return {
    enabled: pickBoolean(raw.enabled, d.enabled),
    supabaseUrl: url,
    autoSync: pickBoolean(raw.autoSync, d.autoSync),
    syncIntervalMs: pickNumber(raw.syncIntervalMs, d.syncIntervalMs, 15000, 3600000),
  };
}

/** Coerce arbitrary stored JSON into a complete, in-range AppSettings. */
export function normaliseSettings(raw: unknown): AppSettings {
  const source = isObject(raw) ? raw : {};
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    general: normaliseGeneral(source.general),
    chat: normaliseChat(source.chat),
    defaults: normaliseDefaults(source.defaults),
    generation: normaliseGeneration(source.generation),
    weirdness: normaliseWeirdness(source.weirdness),
    advanced: normaliseAdvanced(source.advanced),
    sync: normaliseSync(source.sync),
  };
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return { ...base };
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'params' && isObject(value) && isObject(base)) {
      out.params = { ...(base as Record<string, unknown>).params as object, ...value };
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

/** Apply a validated patch on top of current settings and re-normalise. */
export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  return normaliseSettings({
    ...current,
    general: mergeSection(current.general, patch.general),
    chat: mergeSection(current.chat, patch.chat),
    defaults: mergeSection(current.defaults, patch.defaults),
    generation: mergeSection(current.generation, patch.generation),
    weirdness: mergeSection(current.weirdness, patch.weirdness),
    advanced: mergeSection(current.advanced, patch.advanced),
    sync: mergeSection(current.sync, patch.sync),
  });
}

/**
 * Keys whose change takes effect only after the app restarts. Surfaced in the
 * UI as a "requires restart" badge, and enforced by the app telling the user
 * rather than silently applying half of a change.
 */
export const RESTART_REQUIRED_KEYS: ReadonlyArray<keyof AppSettings> = ['advanced'];

export function sectionRequiresRestart(section: keyof AppSettings, key: string): boolean {
  if (section !== 'advanced') return false;
  // Log level and request policy apply immediately; the stream idle timeout is
  // read at request time as well. Nothing in `advanced` structurally needs a
  // restart today, but the hook exists so future keys can declare it.
  return key === 'none-specific' ? true : false;
}
