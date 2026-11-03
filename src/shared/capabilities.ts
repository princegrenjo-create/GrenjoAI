/**
 * Capability vocabulary and task routing.
 *
 * The app used to treat every model as a chat model: `ModelCapabilities` was four
 * booleans, and discovery deleted any id that looked like an image, video, audio
 * or embedding model. That is why an image model could not appear in the picker
 * at all, let alone be selected for an image task.
 *
 * A capability is a *declaration*, never a guess. Three sources are allowed, and
 * the descriptor records which one produced the flags:
 *
 *  - `catalog-hint`  — a curated entry in `MODEL_HINTS`, dated;
 *  - `declared`      — the user registered the model by hand and ticked the boxes;
 *  - `heuristic`     — conservative defaults for an unclassified chat-shaped id;
 *  - `unclassified`  — a discovered id nothing knows anything about; it is kept,
 *                      listed, and offered for **no** task until someone declares it.
 *
 * Nothing here infers an output modality from a model name. A substring can tell
 * you an id is probably not a chat model; it cannot tell you what it does instead.
 */
import type { ModelCapabilities } from './types';

/**
 * Every flag a model can carry. `chat` means text generation — the name is kept
 * because every stored row, exported config and test fixture already uses it.
 */
export const CAPABILITY_KEYS = [
  'chat',
  'streaming',
  'imageInput',
  'imageOutput',
  'imageEditing',
  'videoInput',
  'videoOutput',
  'audioInput',
  'audioOutput',
  'embeddings',
  'toolCalling',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** A user-facing job the app can run. Each one selects models by capability. */
export const TASK_KINDS = ['chat', 'image', 'video'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * The capability a model must declare to be offered for a task.
 *
 * `image` requires `imageOutput`; editing is a further capability a model may or
 * may not have (`imageEditing`), so an editor is never offered a model that can
 * only generate.
 */
export const TASK_CAPABILITIES: Readonly<Record<TaskKind, CapabilityKey>> = {
  chat: 'chat',
  image: 'imageOutput',
  video: 'videoOutput',
};

/** Every flag off. The base for every literal, so adding a flag cannot be forgotten. */
export const NO_CAPABILITIES: ModelCapabilities = {
  chat: false,
  streaming: false,
  imageInput: false,
  imageOutput: false,
  imageEditing: false,
  videoInput: false,
  videoOutput: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  toolCalling: false,
};

/**
 * Build a complete capability record from a partial one.
 *
 * Every producer should use this rather than a bare object literal: a literal
 * silently missing a flag is the defect class this module exists to remove.
 */
export function makeCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...NO_CAPABILITIES, ...overrides };
}

/** True only when the flag is explicitly `true`; absent and `false` are the same. */
export function hasCapability(
  capabilities: ModelCapabilities | null | undefined,
  key: CapabilityKey,
): boolean {
  return capabilities?.[key] === true;
}

/** True when the model declares the capability this task requires. */
export function supportsTask(
  capabilities: ModelCapabilities | null | undefined,
  task: TaskKind,
): boolean {
  return hasCapability(capabilities, TASK_CAPABILITIES[task]);
}

/** True when a model can take an existing image and produce a new one. */
export function supportsImageEditing(capabilities: ModelCapabilities | null | undefined): boolean {
  return hasCapability(capabilities, 'imageEditing');
}

/** True when a model takes reference media as an input for video generation. */
export function supportsVideoFromImage(capabilities: ModelCapabilities | null | undefined): boolean {
  return hasCapability(capabilities, 'videoOutput') && hasCapability(capabilities, 'imageInput');
}

/** The capabilities that are on, in `CAPABILITY_KEYS` order. For UI and for tests. */
export function activeCapabilities(capabilities: ModelCapabilities | null | undefined): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) => hasCapability(capabilities, key));
}

/**
 * A one-line, honest description of where the flags came from. Shown next to a
 * model so a user never mistakes a hint for a provider-verified fact.
 */
export function capabilityProvenanceNote(source: 'catalog-hint' | 'declared' | 'heuristic' | 'unclassified'): string {
  switch (source) {
    case 'catalog-hint':
      return 'Capabilities come from the app’s built-in model list, which is dated and not verified with the provider.';
    case 'declared':
      return 'Capabilities are the ones you declared for this model.';
    case 'heuristic':
      return 'Capabilities are estimated from the model id and are not verified with the provider.';
    case 'unclassified':
      return 'This model was discovered but its capabilities are unknown. Nothing is assumed; declare them to use it.';
  }
}
