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
  bfl: {
    kind: 'bfl',
    label: 'Black Forest Labs',
    defaultName: 'Black Forest Labs',
    defaultBaseUrl: 'https://api.bfl.ai/v1',
    // BFL publishes no model-list endpoint.
    supportsModelDiscovery: false,
    // No chat parameters exist: this provider has generation APIs only.
    supportedParams: [],
    consoleUrl: 'https://api.bfl.ai/',
    keyPlaceholder: 'your x-key value',
    notes:
      'Image and video generation only; there is no chat API. The credential travels in the x-key header, not Authorization.',
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
  'bfl',
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
  /**
   * ISO date after which the provider no longer serves this id.
   *
   * Model line-ups churn fast — three OpenAI image models retire within weeks of
   * this list being written — so a hint carries its own expiry and the picker
   * hides an expired id instead of offering a request that will 404.
   */
  shutdownDate?: string;
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

/*
 * Media models. These are the *only* places a model is declared able to generate
 * or edit an image, or generate video. Nothing infers an output modality from an
 * id, and every entry below is dated against the provider's published line-up.
 */
const IMAGE_GEN: ModelCapabilities = makeCapabilities({
  imageOutput: true,
  imageInput: true,
  imageEditing: true,
});

/** Generates images from text and reference images, but has no documented edit flow. */
const IMAGE_GEN_NO_EDIT: ModelCapabilities = makeCapabilities({
  imageOutput: true,
  imageInput: true,
});

const VIDEO_GEN: ModelCapabilities = makeCapabilities({
  videoOutput: true,
  imageInput: true,
});

/**
 * Deliberately small. Every entry is a widely published identifier, listed so a
 * fresh install can start a conversation before the user runs discovery.
 * `MODEL_HINTS_AS_OF` is shown in the UI so the list never masquerades as live.
 */
export const MODEL_HINTS_AS_OF = '2026-11-03';

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
    /*
     * Image generation (Images API). Verified against the OpenAI Images
     * reference on 2026-11-03: /v1/images/generations and /v1/images/edits,
     * base64 output only, up to 16 reference images and a mask on edits.
     * `chatgpt-image-latest` is listed with its published shutdown date so the
     * picker has a real expired id to hide rather than a theoretical one.
     */
    {
      modelId: 'gpt-image-2.5-sunburst',
      displayName: 'GPT Image 2.5 Sunburst',
      description: 'OpenAI image model. Generation and editing, including masks and up to 16 reference images.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gpt-image-2.5-flare',
      displayName: 'GPT Image 2.5 Flare',
      description: 'OpenAI image model, tuned for a different style balance than Sunburst.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gpt-image-2',
      displayName: 'GPT Image 2',
      description: 'OpenAI image model. Arbitrary sizes in multiples of 16; transparent backgrounds are in preview.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'chatgpt-image-latest',
      displayName: 'ChatGPT Image (latest)',
      description: 'OpenAI image model. Shut down on 2026-12-01; listed with its expiry so the picker hides it.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
      shutdownDate: '2026-12-01',
    },
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
    /*
     * Image and video generation on the Gemini API, verified 2026-11-03.
     * Images and video are documented on the Interactions endpoint, not
     * `generateContent`; `gemini-3.1-flash-lite-image` is the one model the docs
     * say is not built for multiple reference images or sequential editing.
     */
    {
      modelId: 'gemini-nano-banana-2.1',
      displayName: 'Nano Banana 2.1',
      description: 'Gemini image model with multi-turn editing and multiple reference images.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-3.1-flash-image',
      displayName: 'Nano Banana 2',
      description: 'Gemini image model; adds a 512 px size over the 2.1 workhorse.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-3-pro-image',
      displayName: 'Nano Banana Pro',
      description: 'Gemini image model that interleaves text and images in one reply.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-3.1-flash-lite-image',
      displayName: 'Nano Banana 2 Lite',
      description: 'Fastest Gemini image model, 1K only. Not built for multiple references or sequential editing.',
      capabilities: IMAGE_GEN_NO_EDIT,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-2.5-flash-image',
      displayName: 'Nano Banana (legacy)',
      description: 'Earlier Gemini image model; the provider recommends migrating to a newer one.',
      capabilities: IMAGE_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
    {
      modelId: 'gemini-omni-1.1-flash',
      displayName: 'Gemini Omni Flash',
      description: 'Gemini video model: text or image to video, with audio, and +10 s extension per turn.',
      capabilities: VIDEO_GEN,
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
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
  bfl: [
    /*
     * Video only, and only the mode that was verified: `mode: 't2v'` on
     * POST /v1/flux-3-video. Image-to-video needs a documented mode and input
     * shape this build has not confirmed, so the model declares no image input.
     */
    {
      modelId: 'flux-3-video',
      displayName: 'FLUX 3 Video',
      description: 'Black Forest Labs text-to-video model. Asynchronous: submit, poll, then download.',
      capabilities: makeCapabilities({ videoOutput: true }),
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
    },
  ],
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
