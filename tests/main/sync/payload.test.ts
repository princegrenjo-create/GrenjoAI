import { describe, expect, it } from 'vitest';
import {
  containsCredentialShapedValue,
  isCredentialShaped,
  isPlainJsonObject,
  resolveRemoteDeletedAt,
  resolveRemoteUpdatedAt,
  sanitizeForSync,
} from '@main/sync/payload';

const NOW = '2026-10-29T03:00:00.000Z';

describe('sync payload sanitisation', () => {
  it('removes secret-named fields and provider device-local metadata', () => {
    const result = sanitizeForSync('provider', {
      id: 'p1',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      apiKey: 'sk-live-abcdef123456',
      hasKey: true,
      has_key: true,
      keyFingerprint: '0123abcd',
      keyUpdatedAt: '2026-10-01T00:00:00.000Z',
      nested: { token: 'eyJhbGciOiJIUzI1NiJ9.abc.def', keep: 'yes' },
    });

    expect(result.blocked).toBe(false);
    expect(result.value).toEqual({
      id: 'p1',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      nested: { keep: 'yes' },
    });
    expect(result.removedKeys).toEqual(
      expect.arrayContaining([
        'apiKey',
        'hasKey',
        'has_key',
        'keyFingerprint',
        'keyUpdatedAt',
        'nested.token',
      ]),
    );
  });

  it('blocks a payload whose free-text value looks like a credential', () => {
    const result = sanitizeForSync('message', {
      id: 'm1',
      content: 'here is my key sk-live-abcdef123456',
    });

    expect(result.blocked).toBe(true);
    expect(result.value).not.toHaveProperty('content');
  });

  it('keeps a normal message payload intact', () => {
    const payload = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'Explain the difference between TCP and UDP.',
      seq: 1,
      usage: null,
    };
    const result = sanitizeForSync('message', payload);
    expect(result.blocked).toBe(false);
    expect(result.value).toEqual(payload);
    expect(result.removedKeys).toEqual([]);
  });

  it('detects credentials anywhere in a nested structure', () => {
    expect(containsCredentialShapedValue({ a: [{ b: 'AIzaSyFakeKeyValue123456' }] })).toBe(true);
    expect(containsCredentialShapedValue({ b: 'not a secret at all' })).toBe(false);
    expect(isCredentialShaped('sk-abcdefgh')).toBe(true);
    expect(isCredentialShaped('sk-')).toBe(false);
    expect(isCredentialShaped('eyJhbGciOiJIUzI1NiJ9')).toBe(true);
  });

  it('distinguishes a plain JSON object from arrays and dates', () => {
    expect(isPlainJsonObject({})).toBe(true);
    expect(isPlainJsonObject({ a: 1 })).toBe(true);
    expect(isPlainJsonObject([])).toBe(false);
    expect(isPlainJsonObject(new Date())).toBe(false);
    expect(isPlainJsonObject(null)).toBe(false);
  });
});

describe('sync remote timestamps', () => {
  it('uses the payload updatedAt, including a past timestamp', () => {
    expect(resolveRemoteUpdatedAt({ updatedAt: '2026-10-20T10:00:00.000Z' }, NOW)).toBe(
      '2026-10-20T10:00:00.000Z',
    );
    expect(resolveRemoteUpdatedAt({ updated_at: '2026-10-20T10:00:00.000Z' }, NOW)).toBe(
      '2026-10-20T10:00:00.000Z',
    );
  });

  it('clamps a future timestamp so a skewed clock cannot poison the watermark', () => {
    expect(resolveRemoteUpdatedAt({ updatedAt: '2026-10-29T23:00:00.000Z' }, NOW)).toBe(NOW);
  });

  it('falls back to now when the payload carries no usable timestamp', () => {
    expect(resolveRemoteUpdatedAt({}, NOW)).toBe(NOW);
    expect(resolveRemoteUpdatedAt({ updatedAt: 'not a date' }, NOW)).toBe(NOW);
  });

  it('reads an optional tombstone timestamp', () => {
    expect(resolveRemoteDeletedAt({ deletedAt: '2026-10-20T10:00:00.000Z' })).toBe(
      '2026-10-20T10:00:00.000Z',
    );
    expect(resolveRemoteDeletedAt({})).toBeNull();
  });
});
