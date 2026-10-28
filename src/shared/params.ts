/**
 * Generation-parameter resolution.
 *
 * Precedence, highest last:
 *   1. provider / model defaults
 *   2. application-wide defaults
 *   3. agent-specific settings
 *   4. explicit conversation overrides
 *
 * Two behaviours are deliberate and covered by tests:
 *  - A parameter the selected model does not support is *dropped and reported*,
 *    never silently forwarded and never silently replaced by a different one.
 *  - `weirdness` is forwarded only to models that declare support for it. When
 *    they do not, an application-level creativity bias may shift temperature and
 *    top-p locally, and it is labelled as an application bias, not a model knob.
 */
import { PARAM_SPECS } from './defaults';
import type {
  GenerationParams,
  GenParamKey,
  ModelDescriptor,
  WeirdnessSettings,
} from './types';

export type ParamProvenance = 'model-default' | 'app-default' | 'agent' | 'conversation';

export interface ParamLayer {
  source: ParamProvenance;
  params: GenerationParams | null | undefined;
}

export interface ResolvedParams {
  /** Values safe to send to the adapter. */
  values: GenerationParams;
  /** Which layer supplied each surviving value. */
  provenance: Partial<Record<GenParamKey, ParamProvenance>>;
  /** Parameter -> human-readable reason it was dropped. */
  suppressed: Partial<Record<GenParamKey, string>>;
  /** Non-null when an application-level bias changed the sampling values. */
  creativityBias: { temperature: number; topP: number; from: number } | null;
}

const NON_PROVIDER_SPECIFIC: GenParamKey[] = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'maxOutputTokens',
  'stop',
];

export const DEBUG_PARAM_KEYS = Object.keys(PARAM_SPECS) as GenParamKey[];

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function clampNumber(key: GenParamKey, value: number): number {
  const spec = PARAM_SPECS[key];
  let out = value;
  if (spec.min !== undefined && out < spec.min) out = spec.min;
  if (spec.max !== undefined && out > spec.max) out = spec.max;
  if (spec.integer) out = Math.round(out);
  return out;
}

function normaliseParams(input: GenerationParams): GenerationParams {
  const out: GenerationParams = {};
  for (const key of DEBUG_PARAM_KEYS) {
    const raw = input[key];
    if (!isSet(raw)) continue;
    if (key === 'stop') {
      const list = (raw as string[])
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 4);
      if (list.length > 0) out.stop = list;
      continue;
    }
    if (key === 'reasoningEffort') {
      const v = raw as string;
      if (v === 'low' || v === 'medium' || v === 'high') out.reasoningEffort = v;
      continue;
    }
    if (typeof raw === 'number') {
      out[key] = clampNumber(key, raw) as never;
    }
  }
  return out;
}

/** Human-readable validation messages; empty means the values are usable. */
export function validateGenerationParams(params: GenerationParams): string[] {
  const problems: string[] = [];
  for (const key of DEBUG_PARAM_KEYS) {
    const raw = params[key];
    if (raw === undefined || raw === null) continue;
    const spec = PARAM_SPECS[key];
    if (key === 'stop' || key === 'reasoningEffort') continue;
    const value = raw as number;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${spec.label} must be a number`);
      continue;
    }
    if (spec.min !== undefined && value < spec.min) {
      problems.push(`${spec.label} must be at least ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      problems.push(`${spec.label} must be at most ${spec.max}`);
    }
  }
  if (params.stop !== undefined) {
    if (!Array.isArray(params.stop)) problems.push('Stop sequences must be a list');
    else if (params.stop.length > 4) problems.push('At most 4 stop sequences are allowed');
  }
  return problems;
}

export interface ResolveParamsInput {
  model: Pick<ModelDescriptor, 'supportedParams' | 'weirdnessSupported' | 'limits'> | null;
  layers: ParamLayer[];
  weirdness: WeirdnessSettings;
}

export function resolveGenerationParams(input: ResolveParamsInput): ResolvedParams {
  const values: GenerationParams = {};
  const provenance: Partial<Record<GenParamKey, ParamProvenance>> = {};
  const suppressed: Partial<Record<GenParamKey, string>> = {};

  // Layer 1..4 — later layers win when they set a value.
  for (const layer of input.layers) {
    if (!layer.params) continue;
    const normalised = normaliseParams(layer.params);
    for (const key of DEBUG_PARAM_KEYS) {
      if (isSet(normalised[key])) {
        (values as Record<string, unknown>)[key] = normalised[key];
        provenance[key] = layer.source;
      }
    }
  }

  const model = input.model;
  const supported = model
    ? model.supportedParams.length > 0
      ? model.supportedParams
      : NON_PROVIDER_SPECIFIC
    : NON_PROVIDER_SPECIFIC;

  for (const key of DEBUG_PARAM_KEYS) {
    if (!isSet((values as Record<string, unknown>)[key])) continue;
    if (key === 'weirdness') continue; // handled below
    if (!supported.includes(key)) {
      suppressed[key] =
        'This provider/model does not document this parameter, so the value is not sent.';
      delete (values as Record<string, unknown>)[key];
      delete provenance[key];
    }
  }

  let creativityBias: ResolvedParams['creativityBias'] = null;
  if (isSet(values.weirdness) && typeof values.weirdness === 'number') {
    const requested = values.weirdness;
    const native = !!model && model.weirdnessSupported && supported.includes('weirdness');
    if (native) {
      provenance.weirdness = provenance.weirdness ?? 'app-default';
    } else {
      delete values.weirdness;
      const origin = provenance.weirdness;
      delete provenance.weirdness;
      if (input.weirdness.mode === 'creativityBias') {
        const bias = Math.min(1, Math.max(0, input.weirdness.bias)) * requested;
        const baseTemp = typeof values.temperature === 'number' ? values.temperature : 0.7;
        const baseTopP = typeof values.topP === 'number' ? values.topP : 1;
        values.temperature = clampNumber('temperature', baseTemp + bias * 0.5);
        values.topP = clampNumber('topP', baseTopP + bias * 0.15);
        provenance.temperature = origin ?? 'app-default';
        provenance.topP = origin ?? 'app-default';
        creativityBias = {
          temperature: values.temperature,
          topP: values.topP,
          from: requested,
        };
        suppressed.weirdness =
          'Not sent to the provider. The selected model has no weirdness parameter, so the app applied its own creativity bias to temperature and top-p instead.';
      } else {
        suppressed.weirdness =
          'The selected model does not support a weirdness parameter, and the app-level fallback is switched off. Enable it in Settings → Generation.';
      }
    }
  }

  if (model?.limits.maxOutputTokens && values.maxOutputTokens) {
    if (values.maxOutputTokens > model.limits.maxOutputTokens) {
      const capped = model.limits.maxOutputTokens;
      suppressed.maxOutputTokens = `Capped at the model's documented maximum of ${capped} output tokens.`;
      values.maxOutputTokens = capped;
    }
  }

  return { values, provenance, suppressed, creativityBias };
}

/** Rough token estimate (4 characters ≈ 1 token) used for history trimming. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Trim conversation history to fit an approximate token budget, newest first.
 * The most recent user message is always retained even if it alone exceeds the
 * budget, because dropping it would send a request with no question in it.
 */
export function trimHistory(
  messages: HistoryMessage[],
  budgetTokens: number,
): { kept: HistoryMessage[]; dropped: number } {
  if (budgetTokens <= 0) return { kept: [...messages], dropped: 0 };
  const kept: HistoryMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const cost = estimateTokens(message.content) + 4;
    const isNewest = kept.length === 0;
    if (!isNewest && used + cost > budgetTokens) break;
    kept.unshift(message);
    used += cost;
  }
  return { kept, dropped: messages.length - kept.length };
}
