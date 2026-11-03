import { makeCapabilities } from './capabilities';
/**
 * Application-wide constants: provider presets, generation-parameter metadata,
 * a small built-in model hint list, and default settings.
 *
 * The hint list is *not* authoritative. Model discovery through the provider's
 * own API is authoritative; a custom model the user adds is authoritative for
 * that user. Nothing in this file may be used to silently substitute one model
 * id for another.
 */
import type {
  AppSettings,
  GenParamKey,
  GenerationParams,
  ModelCapabilities,
  ModelLimits,
  ProviderKind,
} from './types';

/* -------------------------------------------------------- provider presets -- */

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  defaultName: string;
  defaultBaseUrl: string;
  /** Adapter can enumerate models over the network. */
  supportsModelDiscovery: boolean;
  /** Parameters the adapter is able to forward for this provider family. */
  supportedParams: GenParamKey[];
  /** Where the user obtains a key. Shown in the UI as a link. */
  consoleUrl: string;
  keyPlaceholder: string;
  /** Extra headers required by the provider, documented for the user. */
  notes: string;
}

const OPENAI_LAYER: GenParamKey[] = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'maxOutputTokens',
  'stop',
  'seed',
];

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek',
    defaultName: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    supportsModelDiscovery: true,
    supportedParams: [
      'temperature',
      'topP',
      'frequencyPenalty',
      'presencePenalty',
      'maxOutputTokens',
      'stop',
    ],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-...',
    notes:
      'DeepSeek does not document top-k or seed. Those controls stay disabled for DeepSeek models instead of being silently dropped.',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    defaultName: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsModelDiscovery: true,
    supportedParams: [...OPENAI_LAYER, 'reasoningEffort'],
    consoleUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    notes:
      'top-k is not part of the Chat Completions API, so the control is disabled for OpenAI models. Reasoning effort is only forwarded for models that accept it.',
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    defaultName: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsModelDiscovery: true,
    supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop', 'seed'],
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza...',
    notes:
      'Gemini is called over its own REST shape (generateContent / streamGenerateContent), not the OpenAI schema.',
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    defaultName: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    supportsModelDiscovery: true,
    supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop'],
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    notes:
      'Anthropic uses the Messages API with an x-api-key header and a required anthropic-version header. The system prompt is a top-level field, not a message.',
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'Custom OpenAI-compatible endpoint',
    defaultName: 'Custom endpoint',
    defaultBaseUrl: 'https://',
    supportsModelDiscovery: true,
    // A compatible endpoint may honour top-k and weirdness. The model declares
    // whether it actually does; until it does, both controls stay off.
    supportedParams: [...OPENAI_LAYER, 'topK', 'weirdness'],
    consoleUrl: '',
    keyPlaceholder: 'sk-... or endpoint token',
    notes:
      'Model discovery is attempted at GET {baseUrl}/models. Many self-hosted gateways do not implement it — add models manually in that case.',
  },
};

export const PROVIDER_ORDER: ProviderKind[] = [
  'deepseek',
  'openai',
  'gemini',
  'anthropic',
  'openai-compatible',
];

/* ------------------------------------------------------- parameter metadata -- */

export type ParamControl = 'slider' | 'number' | 'tokens' | 'list' | 'select';

export interface ParamSpec {
  key: GenParamKey;
  label: string;
  control: ParamControl;
  description: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  defaultValue: number | string[] | string | null;
  options?: Array<{ value: string; label: string }>;
  /** True when the value is only meaningful if the model accepts it. */
  providerSpecific: boolean;
}

export const PARAM_SPECS: Record<GenParamKey, ParamSpec> = {
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    control: 'slider',
    description:
      'Sampling randomness. Lower is more deterministic; higher is more varied. Forwarded to every provider that documents it.',
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 0.7,
    providerSpecific: false,
  },
  topP: {
    key: 'topP',
    label: 'Top-p',
    control: 'slider',
    description: 'Nucleus sampling cut-off. Forwarded as top_p.',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 1,
    providerSpecific: false,
  },
  topK: {
    key: 'topK',
    label: 'Top-k',
    control: 'number',
    description:
      'Keeps only the k most likely tokens. Supported by Anthropic, Gemini and some compatible endpoints. Not a Chat Completions parameter, so it is disabled for OpenAI and DeepSeek models.',
    min: 1,
    max: 500,
    step: 1,
    integer: true,
    defaultValue: null,
    providerSpecific: true,
  },
  frequencyPenalty: {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    control: 'slider',
    description: 'Penalises tokens by how often they already appeared.',
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
    providerSpecific: false,
  },
  presencePenalty: {
    key: 'presencePenalty',
    label: 'Presence penalty',
    control: 'slider',
    description: 'Penalises tokens that already appeared at least once.',
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
    providerSpecific: false,
  },
  maxOutputTokens: {
    key: 'maxOutputTokens',
    label: 'Max output tokens',
    control: 'tokens',
    description:
      'Upper bound on generated tokens. Mapped to max_tokens (OpenAI/DeepSeek), max_output_tokens (Gemini) or max_tokens (Anthropic).',
    min: 1,
    max: 200000,
    step: 1,
    integer: true,
    defaultValue: 2048,
    providerSpecific: false,
  },
  stop: {
    key: 'stop',
    label: 'Stop sequences',
    control: 'list',
    description: 'Generation stops when any of these strings appears in the output.',
    defaultValue: [],
    providerSpecific: false,
  },
  seed: {
    key: 'seed',
    label: 'Seed',
    control: 'number',
    description:
      'Best-effort determinism where the provider documents a seed. Not every provider honours it.',
    min: 0,
    max: 2147483647,
    step: 1,
    integer: true,
    defaultValue: null,
    providerSpecific: true,
  },
  weirdness: {
    key: 'weirdness',
    label: 'Weirdness',
    control: 'slider',
    description:
      'A provider-specific parameter, not a universal one. Forwarded verbatim only to models that declare support; otherwise the control is disabled and no value is sent.',
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: null,
    providerSpecific: true,
  },
  reasoningEffort: {
    key: 'reasoningEffort',
    label: 'Reasoning effort',
    control: 'select',
    description:
      'Forwarded as reasoning_effort only to models that document it. Ignored for the rest.',
    defaultValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    providerSpecific: true,
  },
};

/* ------------------------------------------------------------- model hints -- */

export interface ModelHint {
  modelId: string;
  displayName: string;
  description: string;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  supportedParams: GenParamKey[];
  weirdnessSupported: boolean;
}

const CHAT_STREAM: ModelCapabilities = makeCapabilities({
  chat: true,
  streaming: true,
  toolCalling: true,
});

const CHAT_STREAM_VISION: ModelCapabilities = makeCapabilities({
  chat: true,
  streaming: true,
  imageInput: true,
  toolCalling: true,
});

/**
 * Deliberately small. Every entry is a widely published identifier, listed so a
 * fresh install can start a conversation before the user runs discovery.
 * `MODEL_HINTS_AS_OF` is shown in the UI so the list never masquerades as live.
 */
export const MODEL_HINTS_AS_OF = '2026-10-29';

export const MODEL_HINTS: Record<ProviderKind, ModelHint[]> = {
  deepseek: [
    {
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      description: 'General-purpose chat model served over DeepSeek’s OpenAI-compatible API.',
      capabilities: CHAT_STREAM,
      limits: { contextWindow: 128000, maxOutputTokens: 8192 },
      supportedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
    {
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      description: 'Reasoning model. Slower and more expensive; emits a reasoning trace before the answer.',
      capabilities: CHAT_STREAM,
      limits: { contextWindow: 64000, maxOutputTokens: 8192 },
      supportedParams: ['temperature', 'topP', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
  ],
  openai: [
    {
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      description: 'Multimodal chat model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 128000, maxOutputTokens: 16384 },
      supportedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
      description: 'Smaller, cheaper multimodal chat model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 128000, maxOutputTokens: 16384 },
      supportedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'gpt-4.1',
      displayName: 'GPT-4.1',
      description: 'Chat model with a large context window.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 1047576, maxOutputTokens: 32768 },
      supportedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'gpt-4.1-mini',
      displayName: 'GPT-4.1 mini',
      description: 'Smaller GPT-4.1 variant.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 1047576, maxOutputTokens: 32768 },
      supportedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'o3-mini',
      displayName: 'o3-mini',
      description: 'Reasoning model; accepts reasoning_effort and rejects some sampling parameters.',
      capabilities: CHAT_STREAM,
      limits: { contextWindow: 200000, maxOutputTokens: 100000 },
      supportedParams: ['maxOutputTokens', 'reasoningEffort'],
      weirdnessSupported: false,
    },
  ],
  gemini: [
    {
      modelId: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      description: 'Large Gemini model with a long context window.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 1048576, maxOutputTokens: 65536 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      description: 'Fast Gemini model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 1048576, maxOutputTokens: 65536 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-2.0-flash',
      displayName: 'Gemini 2.0 Flash',
      description: 'Previous-generation fast model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 1048576, maxOutputTokens: 8192 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop', 'seed'],
      weirdnessSupported: false,
    },
  ],
  anthropic: [
    {
      modelId: 'claude-sonnet-4-0',
      displayName: 'Claude Sonnet 4',
      description: 'Balanced Claude model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 200000, maxOutputTokens: 64000 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
    {
      modelId: 'claude-opus-4-0',
      displayName: 'Claude Opus 4',
      description: 'Highest-capability Claude model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 200000, maxOutputTokens: 32000 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
    {
      modelId: 'claude-3-7-sonnet-latest',
      displayName: 'Claude 3.7 Sonnet',
      description: 'Previous-generation Claude model, kept as a stable alias.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 200000, maxOutputTokens: 64000 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
    {
      modelId: 'claude-3-5-haiku-latest',
      displayName: 'Claude 3.5 Haiku',
      description: 'Fast, low-cost Claude model.',
      capabilities: CHAT_STREAM_VISION,
      limits: { contextWindow: 200000, maxOutputTokens: 8192 },
      supportedParams: ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stop'],
      weirdnessSupported: false,
    },
  ],
  // No hints: a compatible endpoint's model ids are user-defined by definition.
  'openai-compatible': [],
};

/* ----------------------------------------------------------- app defaults -- */

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.7,
  topP: 1,
  maxOutputTokens: 2048,
};

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  general: {
    theme: 'dark',
    sendOnEnter: true,
    reduceMotion: false,
  },
  chat: {
    streaming: true,
    showTokenUsage: true,
    autoTitleFromFirstMessage: true,
    defaultAgentId: null,
  },
  defaults: {
    providerId: null,
    modelId: null,
    params: { ...DEFAULT_GENERATION_PARAMS },
  },
  generation: {
    requestTimeoutMs: 120000,
    maxRetries: 2,
    retryBackoffMs: 800,
    maxHistoryMessages: 40,
    historyTokenBudget: 32000,
    includeReasoning: false,
  },
  weirdness: {
    mode: 'off',
    bias: 0.5,
  },
  advanced: {
    logLevel: 'info',
    requireHttpsForCustomEndpoints: true,
    allowInsecureLocalhost: true,
    blockRequestsWhenOffline: true,
    streamIdleTimeoutMs: 60000,
  },
  sync: {
    enabled: false,
    supabaseUrl: '',
    autoSync: false,
    syncIntervalMs: 60000,
  },
};

/** Reserved credential-store account that holds the Supabase anon key. */
export const SUPABASE_KEY_ACCOUNT = '__supabase_anon_key__';
/** Reserved credential-store account that holds the Supabase session JSON. */
export const SUPABASE_SESSION_ACCOUNT = '__supabase_session__';

export const MAX_MESSAGE_CHARS = 200_000;
export const MAX_API_KEY_LENGTH = 4096;
export const MAX_SYSTEM_PROMPT_CHARS = 32_000;
