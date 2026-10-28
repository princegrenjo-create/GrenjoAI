/**
 * Credential storage abstraction.
 *
 * The application never keeps an API key anywhere except the operating system's
 * credential-protection facility. On Windows that is DPAPI, reached through
 * Electron's `safeStorage`; the ciphertext file below lives in `userData` and is
 * only decryptable by the same Windows user on the same machine.
 *
 * The interface exists so a future web or mobile client can supply its own
 * platform-appropriate store (Keychain, Android Keystore, an httpOnly session on
 * a server) without touching any calling code.
 *
 * Non-goals: no custom cryptography, no obfuscation, no plaintext fallback. If
 * the OS store is unavailable, `set()` fails loudly instead of degrading.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from '../logger';

export interface CredentialStore {
  /** True when the platform store can encrypt. Never assume true. */
  isAvailable(): boolean;
  /** Returns the secret, or null when no entry exists. */
  get(account: string): string | null;
  /**
   * Stores or replaces a secret. Throws `AppError('storage')` when the platform
   * store is unavailable — it never writes plaintext.
   */
  set(account: string, secret: string): void;
  delete(account: string): boolean;
  has(account: string): boolean;
  /** Stable, non-reversible identifier shown in the UI. */
  fingerprint(account: string): string | null;
  listAccounts(): string[];
}

export interface EncryptionBackend {
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  /** Human name for the backend, surfaced in diagnostics. */
  readonly kind: 'dpapi-safe-storage' | 'memory-test';
}

/** sha256 prefix: lets the UI show "the key changed" without revealing it. */
export function fingerprintSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

const FILE_VERSION = 1;

interface StoredEntry {
  /** base64 ciphertext produced by the platform backend. */
  c: string;
  /** ISO timestamp of the last write. */
  u: string;
}

interface CredentialFile {
  version: number;
  entries: Record<string, StoredEntry>;
}

function emptyFile(): CredentialFile {
  return { version: FILE_VERSION, entries: {} };
}

export class MemoryEncryptionBackend implements EncryptionBackend {
  readonly kind = 'memory-test' as const;
  private readonly key = crypto.randomBytes(32);
  private available: boolean;

  constructor(available = true) {
    this.available = available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  encryptString(plain: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
  }

  decryptString(payload: Buffer): string {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const body = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

export interface FileCredentialStoreOptions {
  filePath: string;
  backend: EncryptionBackend;
  logger?: Logger;
}

class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly backend: EncryptionBackend;
  private readonly logger: Logger | undefined;
  private cache: CredentialFile | null = null;

  constructor(options: FileCredentialStoreOptions) {
    this.filePath = options.filePath;
    this.backend = options.backend;
    this.logger = options.logger;
  }

  isAvailable(): boolean {
    return this.backend.isAvailable();
  }

  private load(): CredentialFile {
    if (this.cache) return this.cache;
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = emptyFile();
        return this.cache;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'entries' in parsed &&
        typeof (parsed as CredentialFile).entries === 'object' &&
        (parsed as CredentialFile).entries !== null
      ) {
        this.cache = { version: FILE_VERSION, entries: (parsed as CredentialFile).entries };
        return this.cache;
      }
      this.logger?.warn('Credential file had an unexpected shape; starting empty');
      this.cache = emptyFile();
      return this.cache;
    } catch (error) {
      this.logger?.warn('Could not read the credential file; starting empty', { error });
      this.cache = emptyFile();
      return this.cache;
    }
  }

  /** Atomic, durable write: temp file -> fsync -> rename onto the target. */
  private persist(next: CredentialFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify(next);
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(handle, body, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.filePath);
    try {
      // Best effort: on Windows this only toggles the read-only bit, but the
      // profile's ACL is what actually protects the file. Recorded here so the
      // intent is visible rather than implied.
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
    this.cache = next;
  }

  get(account: string): string | null {
    const file = this.load();
    const entry = file.entries[account];
    if (!entry) return null;
    try {
      const cipher = Buffer.from(entry.c, 'base64');
      return this.backend.decryptString(cipher);
    } catch (error) {
      this.logger?.warn('Could not decrypt a stored credential', { account, error });
      return null;
    }
  }

  set(account: string, secret: string): void {
    if (!this.backend.isAvailable()) {
      throw new AppError({
        code: 'storage',
        message:
          'The operating system credential store is unavailable, so the key was not saved. Nothing was written in plain text.',
        retryable: false,
      });
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new AppError({
        code: 'validation',
        message: 'An API key cannot be empty.',
        retryable: false,
      });
    }
    const cipher = this.backend.encryptString(secret);
    const file = this.load();
    const next: CredentialFile = {
      version: FILE_VERSION,
      entries: {
        ...file.entries,
        [account]: { c: cipher.toString('base64'), u: new Date().toISOString() },
      },
    };
    this.persist(next);
    this.logger?.info('Credential stored', { account, fingerprint: fingerprintSecret(secret) });
  }

  delete(account: string): boolean {
    const file = this.load();
    if (!file.entries[account]) return false;
    const entries = { ...file.entries };
    delete entries[account];
    this.persist({ version: FILE_VERSION, entries });
    this.logger?.info('Credential deleted', { account });
    return true;
  }

  has(account: string): boolean {
    return this.get(account) !== null;
  }

  fingerprint(account: string): string | null {
    const secret = this.get(account);
    return secret === null ? null : fingerprintSecret(secret);
  }

  listAccounts(): string[] {
    return Object.keys(this.load().entries).sort();
  }
}

export function createCredentialStore(options: FileCredentialStoreOptions): CredentialStore {
  return new FileCredentialStore(options);
}

/** In-memory implementation for tests and for the very first app launch probe. */
export function createMemoryCredentialStore(
  backend: EncryptionBackend = new MemoryEncryptionBackend(),
): CredentialStore {
  const map = new Map<string, string>();
  return {
    isAvailable: () => backend.isAvailable(),
    get: (account) => map.get(account) ?? null,
    set: (account, secret) => {
      if (!backend.isAvailable()) {
        throw new AppError({
          code: 'storage',
          message: 'The credential store is unavailable; nothing was saved.',
          retryable: false,
        });
      }
      map.set(account, secret);
    },
    delete: (account) => map.delete(account),
    has: (account) => map.has(account),
    fingerprint: (account) => {
      const secret = map.get(account);
      return secret === undefined ? null : fingerprintSecret(secret);
    },
    listAccounts: () => [...map.keys()].sort(),
  };
}

/**
 * Storage adapter for the Supabase client. Supabase persists the session JWT,
 * which is a credential, so it must not land in localStorage or SQLite.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createSessionStorage(store: CredentialStore, account: string): KeyValueStorage {
  const namespaced = (key: string): string => `${account}:${key}`;
  return {
    getItem: (key) => store.get(namespaced(key)),
    setItem: (key, value) => {
      store.set(namespaced(key), value);
    },
    removeItem: (key) => {
      store.delete(namespaced(key));
    },
  };
}
