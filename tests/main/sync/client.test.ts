import { describe, expect, it } from 'vitest';
import type { SupabaseClientOptions } from '@supabase/supabase-js';
import type { AppErrorShape } from '@shared/types';
import { AppError } from '@shared/errors';
import {
  createCloudClient,
  createCredentialSessionStorage,
  createSupabaseClientFactory,
  parseRemoteRow,
  readJwtRole,
  validateClientConfig,
  type CreateClientImpl,
  type SessionStorageBackend,
  type SupabaseClientLike,
  type SyncRemoteRow,
} from '@main/sync/client';

const REMOTE_ROW: SyncRemoteRow = {
  id: 'c1',
  user_id: '11111111-2222-4333-8444-555555555555',
  version: 3,
  updated_at: '2026-10-29T04:00:00.000Z',
  deleted_at: null,
  payload: { id: 'c1', title: 'hello' },
};

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string; status?: number } | null;
  status: number;
}

function selectChain(result: FakeResult) {
  const chain = {
    eq: () => chain,
    gt: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ): Promise<unknown> => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

interface FakeSupabaseOptions {
  selectResult?: FakeResult;
  upsertResult?: FakeResult;
  sessionError?: { message: string; status?: number; code?: string } | null;
  onAuthCallback?: (callback: (event: string, session: unknown) => void) => void;
}

function makeSupabaseLike(options: FakeSupabaseOptions = {}): SupabaseClientLike {
  const chain = selectChain(options.selectResult ?? { data: [], error: null, status: 200 });
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        if (options.onAuthCallback) options.onAuthCallback(callback);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async () => ({
        data: { session: null },
        error: options.sessionError ?? null,
      }),
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({ error: null }),
    },
    from: () => ({
      select: () => chain,
      upsert: async () =>
        options.upsertResult ?? { data: null, error: null, status: 201 },
    }),
  };
  return supabase as unknown as SupabaseClientLike;
}

function configErrorShape(run: () => void): AppErrorShape {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.shape;
    throw error;
  }
  throw new Error('expected the configuration to be rejected');
}

const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnop';

function jwtWithRole(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `${header}.${payload}.signaturepart`;
}

describe('client configuration validation', () => {
  it('accepts an HTTPS project URL and normalises a trailing slash', () => {
    const config = validateClientConfig({ url: 'https://Demo-Project.supabase.co/', anonKey: PUBLISHABLE_KEY });
    expect(config.url).toBe('https://demo-project.supabase.co');
    expect(config.anonKey).toBe(PUBLISHABLE_KEY);
  });

  it('refuses a plain-HTTP project URL', () => {
    const shape = configErrorShape(() =>
      validateClientConfig({ url: 'http://demo-project.supabase.co', anonKey: PUBLISHABLE_KEY }),
    );
    expect(shape.code).toBe('sync_config');
    expect(shape.message).toMatch(/HTTPS/i);
  });

  it('refuses an empty key and a URL with embedded credentials', () => {
    expect(
      configErrorShape(() =>
        validateClientConfig({ url: 'https://demo.supabase.co', anonKey: '   ' }),
      ).code,
    ).toBe('sync_config');
    expect(
      configErrorShape(() =>
        validateClientConfig({ url: 'https://user:pass@demo.supabase.co', anonKey: PUBLISHABLE_KEY }),
      ).code,
    ).toBe('sync_config');
  });

  it('refuses a secret/service_role key, which bypasses RLS', () => {
    const modern = configErrorShape(() =>
      validateClientConfig({ url: 'https://demo.supabase.co', anonKey: 'sb_secret_abcdefghijklmnop' }),
    );
    expect(modern.code).toBe('sync_config');
    expect(modern.message).toMatch(/service_role/i);

    const legacy = configErrorShape(() =>
      validateClientConfig({ url: 'https://demo.supabase.co', anonKey: jwtWithRole('service_role') }),
    );
    expect(legacy.code).toBe('sync_config');
  });

  it('accepts a legacy anon JWT', () => {
    const config = validateClientConfig({
      url: 'https://demo.supabase.co',
      anonKey: jwtWithRole('anon'),
    });
    expect(config.anonKey.startsWith('eyJ')).toBe(true);
  });

  it('reads the role claim of a JWT-shaped key and ignores malformed input', () => {
    expect(readJwtRole(jwtWithRole('anon'))).toBe('anon');
    expect(readJwtRole(jwtWithRole('service_role'))).toBe('service_role');
    expect(readJwtRole('not-a-jwt')).toBeNull();
    expect(readJwtRole('a.b')).toBeNull();
    expect(readJwtRole('a.%%%.c')).toBeNull();
  });
});

describe('supabase client factory', () => {
  it('passes the caller-supplied credential-store storage and safe auth flags', () => {
    const storage = createCredentialSessionStorage({
      read: () => null,
      write: () => {},
      remove: () => {},
    });
    const captured: Array<{ url: string; key: string; options: SupabaseClientOptions<'public'> }> = [];
    const impl: CreateClientImpl = (url, key, options) => {
      captured.push({ url, key, options });
      return makeSupabaseLike();
    };
    const factory = createSupabaseClientFactory({ storage, createClientImpl: impl });

    factory({ url: 'https://demo.supabase.co', anonKey: PUBLISHABLE_KEY });

    expect(captured).toHaveLength(1);
    const options = captured[0]!.options;
    expect(options.auth?.storage).toBe(storage);
    expect(options.auth?.persistSession).toBe(true);
    expect(options.auth?.autoRefreshToken).toBe(true);
    expect(options.auth?.detectSessionInUrl).toBe(false);
    expect(captured[0]!.url).toBe('https://demo.supabase.co');
    expect(captured[0]!.key).toBe(PUBLISHABLE_KEY);
  });

  it('refuses to even build a client from a secret key', () => {
    const impl: CreateClientImpl = () => {
      throw new Error('must not be called');
    };
    const factory = createSupabaseClientFactory({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      createClientImpl: impl,
    });
    expect(() =>
      factory({ url: 'https://demo.supabase.co', anonKey: 'sb_secret_abcdefghijklmnop' }),
    ).toThrowError(AppError);
  });

  it('maps the credential-store backend onto one account per session storage key', async () => {
    const accounts = new Map<string, string>();
    const backend: SessionStorageBackend = {
      read: (account) => accounts.get(account) ?? null,
      write: (account, value) => {
        accounts.set(account, value);
      },
      remove: (account) => {
        accounts.delete(account);
      },
    };
    const storage = createCredentialSessionStorage(backend);

    await storage.setItem('sb-project-auth-token', '{"refresh_token":"x"}');

    expect([...accounts.keys()]).toEqual(['__supabase_session__:sb-project-auth-token']);
    await expect(Promise.resolve(storage.getItem('sb-project-auth-token'))).resolves.toBe(
      '{"refresh_token":"x"}',
    );
    await storage.removeItem('sb-project-auth-token');
    await expect(Promise.resolve(storage.getItem('sb-project-auth-token'))).resolves.toBeNull();
  });
});

describe('cloud client adapter', () => {
  it('upserts with an explicit onConflict and reports success', async () => {
    const client = createCloudClient(makeSupabaseLike());
    const result = await client.from('conversations').upsert([REMOTE_ROW], { onConflict: 'id' });
    expect(result).toEqual({ ok: true, data: null });
  });

  it('maps a PostgREST error on upsert into a cloud error with code and status', async () => {
    const client = createCloudClient(
      makeSupabaseLike({
        upsertResult: {
          data: null,
          error: { message: 'row-level security denied', code: '42501' },
          status: 403,
        },
      }),
    );
    const result = await client.from('conversations').upsert([REMOTE_ROW], { onConflict: 'id' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('42501');
    expect(result.error.status).toBe(403);
  });

  it('returns select rows and surfaces select errors', async () => {
    const ok = createCloudClient(
      makeSupabaseLike({ selectResult: { data: [REMOTE_ROW], error: null, status: 200 } }),
    );
    const pulled = await ok.from('conversations').selectAfter({
      userId: REMOTE_ROW.user_id,
      watermark: '1970-01-01T00:00:00.000Z',
      limit: 50,
    });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) throw new Error('expected success');
    expect(pulled.data).toHaveLength(1);

    const failing = createCloudClient(
      makeSupabaseLike({
        selectResult: { data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 },
      }),
    );
    const failed = await failing.from('conversations').selectAfter({
      userId: REMOTE_ROW.user_id,
      watermark: '1970-01-01T00:00:00.000Z',
      limit: 50,
    });
    expect(failed.ok).toBe(false);
  });

  it('exposes only user id and email from a session, never the token', async () => {
    let captured: ((event: string, session: unknown) => void) | null = null;
    const client = createCloudClient(
      makeSupabaseLike({
        onAuthCallback: (callback) => {
          captured = callback;
        },
      }),
    );
    const seen: Array<{ event: string; session: unknown }> = [];
    client.auth.onAuthStateChange((event, session) => {
      seen.push({ event, session });
    });

    captured!('SIGNED_IN', {
      access_token: 'jwt-token-must-not-escape',
      user: { id: 'u1', email: 'owner@example.com' },
    });

    expect(seen).toEqual([
      {
        event: 'signed_in',
        session: { userId: 'u1', email: 'owner@example.com' },
      },
    ]);
  });

  it('maps a rejected sign-in into a cloud error', async () => {
    const client = createCloudClient(
      makeSupabaseLike({ sessionError: { message: 'Invalid login credentials', status: 400 } }),
    );
    const result = await client.auth.signInWithPassword({
      email: 'owner@example.com',
      password: 'wrong',
    });
    expect(result.session).toBeNull();
    expect(result.error?.message).toBe('Invalid login credentials');
    expect(result.error?.status).toBe(400);
  });
});

describe('parseRemoteRow', () => {
  it('accepts a well-formed row', () => {
    expect(parseRemoteRow(REMOTE_ROW)).toEqual(REMOTE_ROW);
  });

  it('rejects malformed rows instead of applying half-valid records', () => {
    expect(parseRemoteRow(null)).toBeNull();
    expect(parseRemoteRow('nope')).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, id: '' })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, version: '3' })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, version: -1 })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, version: 1.5 })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, updated_at: 'not-a-date' })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, deleted_at: 'not-a-date' })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, payload: null })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, payload: [] })).toBeNull();
    expect(parseRemoteRow({ ...REMOTE_ROW, user_id: 42 })).toBeNull();
  });
});
