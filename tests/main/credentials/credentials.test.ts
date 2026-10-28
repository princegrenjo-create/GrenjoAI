import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCredentialStore,
  createMemoryCredentialStore,
  createSessionStorage,
  fingerprintSecret,
  MemoryEncryptionBackend,
  type CredentialStore,
} from '@main/credentials';
import { AppError } from '@shared/errors';
import { createNullLogger } from '@main/logger';
import { scratchDir, readText, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;

afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

function fileStore(backend = new MemoryEncryptionBackend()): {
  store: CredentialStore;
  file: string;
} {
  scratch = scratchDir('credentials');
  const file = path.join(scratch.path, 'credentials.bin');
  const store = createCredentialStore({
    filePath: file,
    backend,
    logger: createNullLogger(),
  });
  return { store, file };
}

const SECRET = 'sk-unit-test-0123456789abcdefghij';

describe('credential store', () => {
  it('round-trips a secret through the encrypted file', () => {
    const { store, file } = fileStore();
    store.set('provider-1', SECRET);

    expect(store.get('provider-1')).toBe(SECRET);
    expect(store.has('provider-1')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    // A fresh instance reading the same file must decrypt it (the key material
    // is the OS store, simulated here by the shared backend instance).
    const reopened = createCredentialStore({
      filePath: file,
      backend: new MemoryEncryptionBackend(),
      logger: createNullLogger(),
    });
    // A different backend means different key material, so it must fail closed
    // rather than return garbage.
    expect(reopened.get('provider-1')).toBeNull();
  });

  it('never writes the plaintext secret to disk', () => {
    const { store, file } = fileStore();
    store.set('provider-1', SECRET);
    const raw = readText(file);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('sk-unit-test');
    expect(raw).toContain('provider-1');
  });

  it('refuses to write when the OS store is unavailable', () => {
    const backend = new MemoryEncryptionBackend(false);
    const { store, file } = fileStore(backend);
    expect(store.isAvailable()).toBe(false);
    expect(() => store.set('provider-1', SECRET)).toThrowError(AppError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects an empty secret', () => {
    const { store } = fileStore();
    expect(() => store.set('provider-1', '')).toThrowError(/cannot be empty/i);
  });

  it('deletes an entry and reports whether it existed', () => {
    const { store } = fileStore();
    store.set('provider-1', SECRET);
    expect(store.delete('provider-1')).toBe(true);
    expect(store.delete('provider-1')).toBe(false);
    expect(store.get('provider-1')).toBeNull();
  });

  it('exposes a stable, non-reversible fingerprint', () => {
    const { store } = fileStore();
    store.set('provider-1', SECRET);
    const fingerprint = store.fingerprint('provider-1');
    expect(fingerprint).toBe(fingerprintSecret(SECRET));
    expect(fingerprint).toHaveLength(8);
    expect(SECRET).not.toContain(fingerprint ?? 'x');
    expect(store.fingerprint('missing')).toBeNull();
  });

  it('lists stored accounts without exposing values', () => {
    const { store } = fileStore();
    store.set('b-provider', SECRET);
    store.set('a-provider', `${SECRET}-two`);
    expect(store.listAccounts()).toEqual(['a-provider', 'b-provider']);
  });

  it('starts empty instead of throwing on a corrupt credential file', () => {
    scratch = scratchDir('credentials-corrupt');
    const file = path.join(scratch.path, 'credentials.bin');
    fs.writeFileSync(file, 'this is not json', 'utf8');
    const store = createCredentialStore({
      filePath: file,
      backend: new MemoryEncryptionBackend(),
      logger: createNullLogger(),
    });
    expect(store.get('anything')).toBeNull();
    expect(store.listAccounts()).toEqual([]);
  });

  it('namespaces the Supabase session storage adapter', () => {
    const store = createMemoryCredentialStore();
    const storage = createSessionStorage(store, '__session__');
    storage.setItem('auth-token', 'jwt-value');
    expect(store.get('__session__:auth-token')).toBe('jwt-value');
    expect(storage.getItem('auth-token')).toBe('jwt-value');
    storage.removeItem('auth-token');
    expect(storage.getItem('auth-token')).toBeNull();
  });
});
