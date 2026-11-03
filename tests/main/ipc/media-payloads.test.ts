/**
 * The media IPC payloads.
 *
 * These schemas are the trust boundary: the renderer is untrusted, so everything
 * it sends is parsed before it reaches the service. The negative cases matter most
 * — an unknown task, an unknown key, an empty prompt and an oversized prompt must
 * all be refused before a provider is contacted.
 */
import { describe, expect, it } from 'vitest';
import {
  jobIdSchema,
  mediaGenerateSchema,
  mediaJobsQuerySchema,
  mediaListSchema,
  mediaParamsSchema,
} from '@shared/schemas';

describe('mediaGenerateSchema', () => {
  it('accepts a minimal image request', () => {
    const parsed = mediaGenerateSchema.parse({ task: 'image', prompt: 'A heron at dawn' });
    expect(parsed.task).toBe('image');
    expect(parsed.prompt).toBe('A heron at dawn');
  });

  it('accepts a full request with parameters, reference choices and a conversation', () => {
    const parsed = mediaGenerateSchema.parse({
      task: 'video',
      prompt: 'Slow pan over a harbour',
      negativePrompt: 'blurry',
      params: { aspect_ratio: '16:9', resolution: '720p', n: 1, seed: 42, loop: true, note: null },
      providerId: 'p-1',
      modelId: 'gemini-omni-1.1-flash',
      conversationId: 'c-1',
    });
    expect(parsed.params).toMatchObject({ aspect_ratio: '16:9', loop: true, note: null });
    expect(parsed.conversationId).toBe('c-1');
  });

  it('refuses a task that is not image or video', () => {
    for (const task of ['audio', 'chat', 'text', 'IMAGE']) {
      expect(mediaGenerateSchema.safeParse({ task, prompt: 'x' }).success, task).toBe(false);
    }
  });

  it('refuses an empty prompt and one over the ceiling', () => {
    expect(mediaGenerateSchema.safeParse({ task: 'image', prompt: '   ' }).success).toBe(false);
    expect(
      mediaGenerateSchema.safeParse({ task: 'image', prompt: 'x'.repeat(32_001) }).success,
    ).toBe(false);
  });

  it('refuses an unknown key, so a typo cannot silently become a provider field', () => {
    const result = mediaGenerateSchema.safeParse({
      task: 'image',
      prompt: 'x',
      imageUrl: 'https://example.com/a.png',
    });
    expect(result.success).toBe(false);
  });
});

describe('mediaParamsSchema', () => {
  it('accepts scalars only', () => {
    expect(mediaParamsSchema.parse({ a: 'x', b: 1, c: true, d: null })).toEqual({
      a: 'x',
      b: 1,
      c: true,
      d: null,
    });
  });

  it('refuses a nested object, which is how a path or a body could be smuggled in', () => {
    expect(mediaParamsSchema.safeParse({ a: { path: '/etc/passwd' } }).success).toBe(false);
    expect(mediaParamsSchema.safeParse({ a: ['x'] }).success).toBe(false);
  });
});

describe('list and id payloads', () => {
  it('treats an absent filter as "everything"', () => {
    expect(mediaListSchema.parse(undefined)).toBeUndefined();
    expect(mediaListSchema.parse({})).toEqual({});
  });

  it('accepts a kind and a conversation filter, and refuses an unknown one', () => {
    expect(mediaListSchema.parse({ kind: 'video', conversationId: 'c-1' })).toEqual({
      kind: 'video',
      conversationId: 'c-1',
    });
    expect(mediaListSchema.safeParse({ kind: 'audio' }).success).toBe(false);
    expect(mediaListSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('requires a non-empty job id and bounds the jobs query', () => {
    expect(jobIdSchema.safeParse('').success).toBe(false);
    expect(jobIdSchema.safeParse('job-1').success).toBe(true);
    expect(mediaJobsQuerySchema.safeParse(0).success).toBe(false);
    expect(mediaJobsQuerySchema.safeParse(10).success).toBe(true);
    expect(mediaJobsQuerySchema.safeParse(501).success).toBe(false);
  });
});
