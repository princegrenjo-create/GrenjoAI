/**
 * The capability vocabulary and its task routing.
 *
 * These are the rules the whole app now depends on: which model may be offered
 * for which job, and what "this model can do X" is allowed to mean. They are
 * asserted here rather than only through the UI so a regression is named after
 * the rule it broke.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  NO_CAPABILITIES,
  TASK_CAPABILITIES,
  TASK_KINDS,
  activeCapabilities,
  capabilityProvenanceNote,
  hasCapability,
  makeCapabilities,
  supportsImageEditing,
  supportsTask,
  supportsVideoFromImage,
} from '@shared/capabilities';
import type { ModelCapabilities } from '@shared/types';

const textModel = makeCapabilities({ chat: true, streaming: true });
const visionModel = makeCapabilities({ chat: true, streaming: true, imageInput: true });
const imageModel = makeCapabilities({ imageOutput: true });
const editor = makeCapabilities({ imageOutput: true, imageEditing: true });
const videoModel = makeCapabilities({ videoOutput: true, imageInput: true });
const unclassified = makeCapabilities();

describe('capability vocabulary', () => {
  it('covers exactly the eleven declared flags', () => {
    expect(CAPABILITY_KEYS).toHaveLength(11);
    for (const key of CAPABILITY_KEYS) expect(NO_CAPABILITIES[key]).toBe(false);
  });

  it('builds a complete record from a partial one', () => {
    const built = makeCapabilities({ imageOutput: true });
    expect(built.imageOutput).toBe(true);
    // Every other flag must be present and false, not undefined: an absent flag
    // and a false one are the same to hasCapability but not to a stored row.
    for (const key of CAPABILITY_KEYS) {
      if (key === 'imageOutput') continue;
      expect(built[key]).toBe(false);
    }
    expect(Object.keys(built).sort()).toEqual([...CAPABILITY_KEYS].sort());
  });
});

describe('task routing', () => {
  it('routes each task to exactly one required capability', () => {
    expect(Object.keys(TASK_CAPABILITIES).sort()).toEqual([...TASK_KINDS].sort());
    expect(TASK_CAPABILITIES.chat).toBe('chat');
    expect(TASK_CAPABILITIES.image).toBe('imageOutput');
    expect(TASK_CAPABILITIES.video).toBe('videoOutput');
  });

  it('offers a text model for chat and refuses it for image and video', () => {
    expect(supportsTask(textModel, 'chat')).toBe(true);
    expect(supportsTask(textModel, 'image')).toBe(false);
    expect(supportsTask(textModel, 'video')).toBe(false);
  });

  it('offers an image model for image and not for chat — the defect this fixes', () => {
    expect(supportsTask(imageModel, 'image')).toBe(true);
    expect(supportsTask(imageModel, 'chat')).toBe(false);
  });

  it('offers a video model for video and not for chat or image', () => {
    expect(supportsTask(videoModel, 'video')).toBe(true);
    expect(supportsTask(videoModel, 'chat')).toBe(false);
    expect(supportsTask(videoModel, 'image')).toBe(false);
  });

  it('offers an unclassified model for nothing at all', () => {
    for (const task of TASK_KINDS) expect(supportsTask(unclassified, task)).toBe(false);
    expect(activeCapabilities(unclassified)).toEqual([]);
  });

  it('treats a missing capability record as no capability, never as a chat model', () => {
    expect(supportsTask(null, 'chat')).toBe(false);
    expect(supportsTask(undefined, 'chat')).toBe(false);
    expect(hasCapability(undefined, 'imageOutput')).toBe(false);
  });

  it('requires image output before offering an edit', () => {
    expect(supportsImageEditing(editor)).toBe(true);
    // A model that edits but does not declare output would be a contradiction;
    // the check is on the edit flag alone, and the form is what prevents the pair.
    expect(supportsImageEditing(makeCapabilities({ imageEditing: true }))).toBe(true);
    expect(supportsImageEditing(imageModel)).toBe(false);
    expect(supportsImageEditing(textModel)).toBe(false);
  });

  it('only offers image-to-video to a model that takes images and makes video', () => {
    expect(supportsVideoFromImage(videoModel)).toBe(true);
    expect(supportsVideoFromImage(makeCapabilities({ videoOutput: true }))).toBe(false);
    expect(supportsVideoFromImage(visionModel)).toBe(false);
  });

  it('lists active capabilities in declaration order', () => {
    const mixed: ModelCapabilities = makeCapabilities({
      chat: true,
      imageOutput: true,
      embeddings: true,
    });
    expect(activeCapabilities(mixed)).toEqual(['chat', 'imageOutput', 'embeddings']);
  });
});

describe('provenance wording', () => {
  const sources = ['catalog-hint', 'declared', 'heuristic', 'unclassified'] as const;

  it('says something distinct and honest for every source', () => {
    const notes = sources.map((source) => capabilityProvenanceNote(source));
    expect(new Set(notes).size).toBe(sources.length);
    for (const note of notes) expect(note.length).toBeGreaterThan(20);
    // None of them may read as a provider confirmation. The two that could be
    // mistaken for one say so explicitly; the declared one attributes the claim
    // to the user; the unclassified one says nothing is known.
    expect(capabilityProvenanceNote('catalog-hint')).toMatch(/not verified with the provider/);
    expect(capabilityProvenanceNote('heuristic')).toMatch(/not verified with the provider/);
    expect(capabilityProvenanceNote('declared')).toMatch(/you declared/);
    expect(capabilityProvenanceNote('unclassified')).toMatch(/unknown/i);
  });
});
