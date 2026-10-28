/**
 * Capability inference for discovered models.
 *
 * A discovered model's *existence* is a verified fact from the provider's own
 * API. Its *capabilities* are not: no provider enumerates image input or tool
 * calling reliably in its list endpoint, and guessing wrong is how a user ends
 * up with a control that silently does nothing. So every value produced here is
 * labelled a hint, and the descriptor records where the hint came from:
 *
 *  - `catalog-hint` — a known identifier from `MODEL_HINTS` (curated, dated, and
 *    presented in the UI as a built-in list rather than live truth);
 *  - `heuristic` — conservative defaults plus a name-based image-input guess.
 *
 * Adapters never turn a hint into a claim that a parameter or a modality was
 * verified with the provider.
 */
import { MODEL_HINTS, PROVIDER_PRESETS } from '@shared/defaults';
import type { ModelHint } from '@shared/defaults';
import type { GenParamKey, ModelCapabilities, ModelLimits, ProviderKind } from '@shared/types';

export type CapabilitySource = 'catalog-hint' | 'heuristic';

export interface CapabilityProfile {
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  /** Parameters the adapter is willing to forward for this model. */
  supportedParams: GenParamKey[];
  weirdnessSupported: boolean;
  /** Where the flags came from. Never a provider-verified statement. */
  source: CapabilitySource;
}

/**
 * Substrings that reliably appear in multimodal model ids across providers:
 * OpenAI `gpt-4o`, `-vision` variants, every Gemini id, every Claude id.
 * Matching one only sets `imageInput`; nothing else is inferred from the name.
 */
const IMAGE_INPUT_TOKENS = ['vision', '4o', 'gemini', 'claude'] as const;

/** Look up a curated hint for an exact model id. */
export function findModelHint(kind: ProviderKind, modelId: string): ModelHint | null {
  for (const hint of MODEL_HINTS[kind]) {
    if (hint.modelId === modelId) return hint;
  }
  return null;
}

/**
 * Capability profile for a model id.
 *
 * Pass `hint` when the caller already resolved one (discovery may reuse a
 * catalog entry); otherwise the curated list is consulted by exact id.
 */
export function inferCapabilities(
  kind: ProviderKind,
  modelId: string,
  hint?: ModelHint | null,
): CapabilityProfile {
  const matched = hint ?? findModelHint(kind, modelId);

  if (matched) {
    return {
      capabilities: { ...matched.capabilities },
      limits: { ...matched.limits },
      supportedParams: [...matched.supportedParams],
      weirdnessSupported: matched.weirdnessSupported,
      source: 'catalog-hint',
    };
  }

  const lower = modelId.toLowerCase();
  const imageInput = IMAGE_INPUT_TOKENS.some((token) => lower.includes(token));
  const preset = PROVIDER_PRESETS[kind];
  // `weirdness` is only forwarded to a model that explicitly declares support;
  // a model nobody has classified keeps it off (and out of its parameter list).
  const supportedParams = preset.supportedParams.filter((key) => key !== 'weirdness');

  return {
    capabilities: { chat: true, streaming: true, imageInput, toolCalling: false },
    limits: {},
    supportedParams,
    weirdnessSupported: false,
    source: 'heuristic',
  };
}

/** One-line provenance note for a discovered model's description. */
export function capabilityNote(profile: CapabilityProfile): string {
  return profile.source === 'heuristic'
    ? 'Capability flags are estimated from the model id and are not verified with the provider.'
    : 'Capability flags come from the app’s built-in model list and are not verified with the provider.';
}
