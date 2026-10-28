import { describe, expect, it } from 'vitest';
import { createMemoryCredentialStore } from '@main/credentials';
import {
  bindProviderKey,
  clearProviderKey,
  hasBoundKey,
  normaliseBaseUrl,
  readProviderKey,
  resolveRequestEndpoint,
  sameOrigin,
} from '@main/models/endpoint-policy';

const BASE = 'https://api.example.test/v1';
const KEY = 'sk-binding-test-0123456789';

describe('provider key binding', () => {
  it('round-trips a key while the base URL is unchanged', () => {
    const store = createMemoryCredentialStore();
    bindProviderKey(store, 'p1', BASE, KEY);
    expect(readProviderKey(store, 'p1', BASE)).toBe(KEY);
    expect(hasBoundKey(store, 'p1', BASE)).toBe(true);
  });

  it('invalidates and deletes the key when the base URL changes', () => {
    const store = createMemoryCredentialStore();
    bindProviderKey(store, 'p1', BASE, KEY);
    expect(readProviderKey(store, 'p1', 'https://attacker.example/v1')).toBeNull();
    // Deleted, not merely hidden: a later switch back must not resurrect it.
    expect(store.get('p1')).toBeNull();
  });

  it('ignores a trailing slash difference', () => {
    const store = createMemoryCredentialStore();
    bindProviderKey(store, 'p1', 'https://api.example.test/v1/', KEY);
    expect(readProviderKey(store, 'p1', 'https://api.example.test/v1')).toBe(KEY);
  });

  it('discards a key that has no binding record', () => {
    const store = createMemoryCredentialStore();
    store.set('p1', KEY);
    expect(readProviderKey(store, 'p1', BASE)).toBeNull();
    expect(store.get('p1')).toBeNull();
  });

  it('clears both the key and the binding', () => {
    const store = createMemoryCredentialStore();
    bindProviderKey(store, 'p1', BASE, KEY);
    clearProviderKey(store, 'p1');
    expect(store.get('p1')).toBeNull();
    expect(store.get('__provider_binding__:p1')).toBeNull();
  });

  it('normalises a base URL for comparison', () => {
    expect(normaliseBaseUrl('https://api.example.test/v1///')).toBe('https://api.example.test/v1');
    expect(normaliseBaseUrl('  https://api.example.test  ')).toBe('https://api.example.test');
  });
});

describe('model endpoint override policy', () => {
  it('uses the provider base URL when there is no override', () => {
    expect(resolveRequestEndpoint(BASE, null)).toBe(BASE);
    expect(resolveRequestEndpoint(BASE, '')).toBe(BASE);
  });

  it('allows an override on the same origin', () => {
    expect(resolveRequestEndpoint(BASE, 'https://api.example.test/v2')).toBe(
      'https://api.example.test/v2',
    );
  });

  it('refuses an override that would move the key to another origin', () => {
    expect(() => resolveRequestEndpoint(BASE, 'https://attacker.example/v1')).toThrowError(
      /never sent to a different origin/i,
    );
  });

  it('refuses an override with a different port (a different origin)', () => {
    expect(() => resolveRequestEndpoint(BASE, 'https://api.example.test:8443/v1')).toThrowError(
      /different origin/i,
    );
  });

  it('refuses a malformed override', () => {
    expect(() => resolveRequestEndpoint(BASE, 'not a url')).toThrowError(/not a valid absolute url/i);
  });

  it('compares origins', () => {
    expect(sameOrigin(BASE, 'https://api.example.test/other')).toBe(true);
    expect(sameOrigin(BASE, 'http://api.example.test/v1')).toBe(false);
    expect(sameOrigin(BASE, 'nonsense')).toBe(false);
  });
});
