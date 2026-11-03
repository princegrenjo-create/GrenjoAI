/**
 * The capability vocabulary as the models screen shows it.
 *
 * The shared module owns what a flag *means*; this file owns how it is said, and
 * these assertions pin the wording a user reads: the editor's full labels, the
 * badge row's short labels, and the case where nothing is declared at all.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITY_KEYS, makeCapabilities, supportsTask } from '@shared/capabilities';
import {
  CAPABILITIES,
  CAPABILITY_DESCRIPTION,
  CAPABILITY_LABEL,
  EMPTY_CAPABILITY_LABEL,
  capabilitySummary,
  isUnclassified,
} from '@renderer/pages/models/model-labels';

describe('capability labels', () => {
  it('labels and describes every declared flag exactly once', () => {
    expect(Object.keys(CAPABILITY_LABEL).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(Object.keys(CAPABILITY_DESCRIPTION).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(CAPABILITIES.map((entry) => entry.key)).toEqual([...CAPABILITY_KEYS]);
    for (const key of CAPABILITY_KEYS) {
      expect(CAPABILITY_LABEL[key].length).toBeGreaterThan(2);
      expect(CAPABILITY_DESCRIPTION[key].length).toBeGreaterThan(10);
    }
  });

  it('uses the user-facing wording the capability contract asks for', () => {
    expect(CAPABILITY_LABEL).toMatchObject({
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
    });
  });
});

describe('capability summary', () => {
  it('summarises a text and vision model as readable badges', () => {
    const model = makeCapabilities({
      chat: true,
      streaming: true,
      imageInput: true,
      toolCalling: true,
    });
    expect(capabilitySummary(model)).toEqual(['Text', 'Vision', 'Tools', 'Streaming']);
  });

  it('summarises an image model by what it generates', () => {
    const model = makeCapabilities({ imageOutput: true, imageEditing: true });
    expect(capabilitySummary(model)).toEqual(['Image gen', 'Image edit']);
  });

  it('summarises an unclassified model as nothing, and names that case', () => {
    const model = makeCapabilities();
    expect(capabilitySummary(model)).toEqual([]);
    expect(isUnclassified(model)).toBe(true);
    expect(EMPTY_CAPABILITY_LABEL).toBe('Capabilities not declared');
  });

  it('never calls a model with one declared capability unclassified', () => {
    expect(isUnclassified(makeCapabilities({ embeddings: true }))).toBe(false);
    expect(isUnclassified(makeCapabilities({ videoOutput: true }))).toBe(false);
    expect(isUnclassified(makeCapabilities({ imageInput: true }))).toBe(false);
  });

  it('treats a missing capability record as unclassified', () => {
    expect(isUnclassified(null)).toBe(true);
    expect(isUnclassified(undefined)).toBe(true);
    expect(capabilitySummary(undefined)).toEqual([]);
  });
});

describe('task gating as the pickers use it', () => {
  it('offers an image-output model for the image task and not for chat', () => {
    const imageModel = makeCapabilities({ imageOutput: true });
    expect(supportsTask(imageModel, 'image')).toBe(true);
    expect(supportsTask(imageModel, 'chat')).toBe(false);
  });

  it('does not offer a text-only model for the image task', () => {
    const textModel = makeCapabilities({ chat: true, streaming: true });
    expect(supportsTask(textModel, 'chat')).toBe(true);
    expect(supportsTask(textModel, 'image')).toBe(false);
    expect(supportsTask(textModel, 'video')).toBe(false);
  });
});
