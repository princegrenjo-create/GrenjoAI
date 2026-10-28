import { describe, expect, it } from 'vitest';
import {
  capabilityNote,
  findModelHint,
  inferCapabilities,
} from '@main/providers/capabilities';

describe('findModelHint', () => {
  it('matches an exact catalog id and not a versioned sibling', () => {
    expect(findModelHint('openai', 'gpt-4o')?.displayName).toBe('GPT-4o');
    expect(findModelHint('openai', 'gpt-4o-2024-08-06')).toBeNull();
    expect(findModelHint('deepseek', 'deepseek-chat')?.limits.contextWindow).toBe(128000);
    expect(findModelHint('openai-compatible', 'anything')).toBeNull();
  });
});

describe('inferCapabilities', () => {
  it('reports a catalog hint as a dated configuration hint', () => {
    const profile = inferCapabilities('openai', 'gpt-4o');
    expect(profile.source).toBe('catalog-hint');
    expect(profile.capabilities).toEqual({
      chat: true,
      streaming: true,
      imageInput: true,
      toolCalling: true,
    });
    expect(profile.limits).toEqual({ contextWindow: 128000, maxOutputTokens: 16384 });
    expect(profile.supportedParams).toEqual([
      'temperature',
      'topP',
      'frequencyPenalty',
      'presencePenalty',
      'maxOutputTokens',
      'stop',
      'seed',
    ]);
    expect(profile.weirdnessSupported).toBe(false);
  });

  it('uses an explicitly supplied hint instead of doing its own lookup', () => {
    const hint = findModelHint('anthropic', 'claude-opus-4-0');
    expect(hint).not.toBeNull();
    if (!hint) return;
    const profile = inferCapabilities('anthropic', 'an-alias-for-opus', hint);
    expect(profile.source).toBe('catalog-hint');
    expect(profile.limits.maxOutputTokens).toBe(hint.limits.maxOutputTokens);
  });

  it('falls back to conservative defaults for an unknown id', () => {
    const profile = inferCapabilities('openai-compatible', 'acme-text-7b');
    expect(profile.source).toBe('heuristic');
    expect(profile.capabilities).toEqual({
      chat: true,
      streaming: true,
      imageInput: false,
      toolCalling: false,
    });
    expect(profile.limits).toEqual({});
    expect(profile.weirdnessSupported).toBe(false);
  });

  it('never advertises weirdness without a model that declares it', () => {
    for (const id of ['acme-text-7b', 'acme-vision-7b', 'unknown-1']) {
      const profile = inferCapabilities('openai-compatible', id);
      expect(profile.supportedParams).not.toContain('weirdness');
      expect(profile.weirdnessSupported).toBe(false);
    }
  });

  it('marks image input true for the documented id heuristics', () => {
    const heuristicIds = ['acme-vision-7b', 'acme-4o-mini', 'gemini-proxy', 'claude-mirror'];
    for (const id of heuristicIds) {
      expect(inferCapabilities('openai-compatible', id).capabilities.imageInput, id).toBe(true);
    }
  });

  it('does not claim image input for a plain text id', () => {
    expect(inferCapabilities('deepseek', 'plain-chat').capabilities.imageInput).toBe(false);
  });

  it('keeps the provider preset parameter list for unknown ids', () => {
    const profile = inferCapabilities('gemini', 'gemini-unknown-9');
    expect(profile.supportedParams).toEqual([
      'temperature',
      'topP',
      'topK',
      'maxOutputTokens',
      'stop',
      'seed',
    ]);
  });

  it('labels the provenance of the hint in the note', () => {
    expect(capabilityNote(inferCapabilities('openai', 'gpt-4o'))).toContain('built-in model list');
    expect(capabilityNote(inferCapabilities('openai', 'unknown-model'))).toContain('estimated from the model id');
  });
});
