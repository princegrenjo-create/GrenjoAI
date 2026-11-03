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
import { capabilityProvenanceNote, makeCapabilities } from '@shared/capabilities';
import { MODEL_HINTS, PROVIDER_PRESETS } from '@shared/defaults';
import type { ModelHint } from '@shared/defaults';
import type { GenParamKey, ModelCapabilities, ModelLimits, ProviderKind } from '@shared/types';

export type CapabilitySource = 'catalog-hint' | 'heuristic' | 'unclassified';

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

/**
 * Ids that are clearly *not* chat models.
 *
 * This used to be a deletion filter: discovery dropped any id matching it, so an
 * image model could never appear in the picker at all. Deleting a model is a
 * worse mistake than labelling it, so a match now produces an `unclassified`
 * model — listed, offered for no task, and waiting for a declaration.
 *
 * It still does not guess what the model *is*: knowing that an id is not a chat
 * model says nothing about whether it generates images, video or embeddings.
 */
const NON_CHAT_ID_PATTERN =
  /(^|[-_/])(embedding|embeddings|whisper|tts|dall-e|moderation|image|images|sora|transcribe|realtime|audio|speech|rerank|ocr|veo|flux|nano-banana|omni)([-_/]|$)/i;

/** True when the id looks like it is not a chat model. Never a capability claim. */
export function isLikelyNonChat(modelId: string): boolean {
  return NON_CHAT_ID_PATTERN.test(modelId);
}

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
 *
 * `forceUnclassified` exists for a provider that states a model cannot answer a
 * chat request (Gemini lists the supported methods per model): the model is kept
 * and listed, but nothing is assumed about what it can do instead.
 */
export function inferCapabilities(
  kind: ProviderKind,
  modelId: string,
  hint?: ModelHint | null,
  options?: { forceUnclassified?: boolean },
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

  if (options?.forceUnclassified === true || isLikelyNonChat(modelId)) {
    return {
      capabilities: makeCapabilities(),
      limits: {},
      supportedParams: [],
      weirdnessSupported: false,
      source: 'unclassified',
    };
  }

  const lower = modelId.toLowerCase();
  const imageInput = IMAGE_INPUT_TOKENS.some((token) => lower.includes(token));
  const preset = PROVIDER_PRESETS[kind];
  // `weirdness` is only forwarded to a model that explicitly declares support;
  // a model nobody has classified keeps it off (and out of its parameter list).
  const supportedParams = preset.supportedParams.filter((key) => key !== 'weirdness');

  return {
    capabilities: makeCapabilities({ chat: true, streaming: true, imageInput }),
    limits: {},
    supportedParams,
    weirdnessSupported: false,
    source: 'heuristic',
  };
}

/** One-line provenance note for a discovered model's description. */
export function capabilityNote(profile: CapabilityProfile): string {
  return capabilityProvenanceNote(profile.source);
}
