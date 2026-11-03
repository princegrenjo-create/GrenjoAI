/**
 * Display helpers for the models screen: how a source, a capability and a limit
 * are labelled. One implementation so a badge cannot mean two things on the
 * provider list and on the model list.
 *
 * Two vocabularies, one per job:
 *
 *  - `CAPABILITY_LABEL` / `CAPABILITY_DESCRIPTION` are the full wording the
 *    capability editor shows beside each switch, so the form never has to invent
 *    a name for a flag the shared contract already defines.
 *  - `capabilitySummary` is the short badge row — "Text", "Vision", "Image gen" —
 *    because a row of eleven full sentences is not a badge row.
 */
import type { BadgeTone } from '@renderer/components/ui';
import { CAPABILITY_KEYS, activeCapabilities, type CapabilityKey } from '@shared/capabilities';
import { PARAM_SPECS } from '@shared/defaults';
import type {
  GenParamKey,
  ModelCapabilities,
  ModelLimits,
  ModelSource,
} from '@shared/types';

export const SOURCE_LABEL: Record<ModelSource, string> = {
  catalog: 'Built-in hint',
  discovered: 'Discovered',
  custom: 'Custom',
};

export const SOURCE_TONE: Record<ModelSource, BadgeTone> = {
  catalog: 'neutral',
  discovered: 'info',
  custom: 'accent',
};

export interface CapabilityEntry {
  key: CapabilityKey;
  label: string;
}

/**
 * User-facing wording for every flag, in the shared declaration order. `chat` is
 * called "Text generation" because that is what it means: the model writes text.
 */
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  chat: 'Text generation',
  streaming: 'Streaming',
  imageInput: 'Image understanding',
  imageOutput: 'Image generation',
  imageEditing: 'Image editing',
  videoInput: 'Video understanding',
  videoOutput: 'Video generation',
  audioInput: 'Audio input',
  audioOutput: 'Audio output',
  embeddings: 'Embeddings',
  toolCalling: 'Tool calling',
};

/**
 * What each flag actually gets the user, plus the one dependency that matters.
 * Shown as the switch hint, so a disabled control explains itself instead of
 * looking broken.
 */
export const CAPABILITY_DESCRIPTION: Record<CapabilityKey, string> = {
  chat: 'Writes replies. The chat model picker only offers models with this on.',
  streaming: 'Shows the reply while it is being written. Needs text generation.',
  imageInput: 'Reads an image you attach to a message.',
  imageOutput: 'Produces an image from a prompt.',
  imageEditing: 'Takes an existing image and produces a new one. Needs image generation.',
  videoInput: 'Reads a video you attach to a message.',
  videoOutput: 'Produces a video. It stands on its own and does not need text generation.',
  audioInput: 'Reads an audio recording you attach.',
  audioOutput: 'Produces audio.',
  embeddings: 'Turns text into vectors for search. It is not a chat model.',
  toolCalling: 'Can call the tools you allow.',
};

/** Every capability, in declaration order. The editor groups these by kind. */
export const CAPABILITIES: CapabilityEntry[] = CAPABILITY_KEYS.map((key) => ({
  key,
  label: CAPABILITY_LABEL[key],
}));

/**
 * The short labels a badge row uses, in the order a reader scans them: what it
 * reads and writes first, capability modifiers last.
 */
const CAPABILITY_SHORT_LABEL: Record<CapabilityKey, string> = {
  chat: 'Text',
  streaming: 'Streaming',
  imageInput: 'Vision',
  imageOutput: 'Image gen',
  imageEditing: 'Image edit',
  videoInput: 'Video in',
  videoOutput: 'Video gen',
  audioInput: 'Audio in',
  audioOutput: 'Audio out',
  embeddings: 'Embeddings',
  toolCalling: 'Tools',
};

const CAPABILITY_SUMMARY_ORDER: CapabilityKey[] = [
  'chat',
  'imageInput',
  'imageOutput',
  'imageEditing',
  'videoInput',
  'videoOutput',
  'audioInput',
  'audioOutput',
  'embeddings',
  'toolCalling',
  'streaming',
];

/** Short labels for the capabilities that are on. Empty for an unclassified model. */
export function capabilitySummary(
  capabilities: ModelCapabilities | null | undefined,
): string[] {
  return CAPABILITY_SUMMARY_ORDER.filter((key) => capabilities?.[key] === true).map(
    (key) => CAPABILITY_SHORT_LABEL[key],
  );
}

/** The one sentence a model with no declared capability shows instead of nothing. */
export const EMPTY_CAPABILITY_LABEL = 'Capabilities not declared';

/**
 * True when a model declares no capability at all — the discovered-but-unknown
 * case. It is offered for no task, so the row must say so rather than render an
 * empty badge row that reads as a model that does nothing.
 */
export function isUnclassified(
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  return activeCapabilities(capabilities).length === 0;
}

export function tokenCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

/** "128,000 context · 8,192 max output", never an invented number. */
export function limitSummary(limits: ModelLimits): string {
  const parts: string[] = [];
  if (typeof limits.contextWindow === 'number') {
    parts.push(`${tokenCount(limits.contextWindow)} context`);
  }
  if (typeof limits.maxOutputTokens === 'number') {
    parts.push(`${tokenCount(limits.maxOutputTokens)} max output`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No limits declared for this model.';
}

export function paramLabel(key: GenParamKey): string {
  return PARAM_SPECS[key].label;
}

/** The parameters this model is declared to honour, in the shared spec order. */
export function paramSummary(keys: GenParamKey[]): string {
  if (keys.length === 0) return 'No parameters declared.';
  return keys.map(paramLabel).join(', ');
}
