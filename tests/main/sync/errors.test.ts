import { describe, expect, it } from 'vitest';
import { appError } from '@shared/errors';
import { isRetryableSyncError, mapSyncError, redactKnownSecrets } from '@main/sync/errors';

describe('sync error mapping', () => {
  it('maps an RLS refusal (42501) to sync_auth', () => {
    const mapped = mapSyncError({ message: 'new row violates row-level security policy', code: '42501', status: 42501 });
    expect(mapped.code).toBe('sync_auth');
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toMatch(/row-level security/i);
  });

  it('maps a 429 to rate_limited and keeps it retryable', () => {
    const mapped = mapSyncError({ message: 'Too Many Requests', status: 429 });
    expect(mapped.code).toBe('rate_limited');
    expect(mapped.retryable).toBe(true);
    expect(isRetryableSyncError(mapped)).toBe(true);
  });

  it('maps 401/403 and invalid-credential text to sync_auth', () => {
    expect(mapSyncError({ message: 'Unauthorized', status: 401 }).code).toBe('sync_auth');
    expect(mapSyncError({ message: 'Forbidden', status: 403 }).code).toBe('sync_auth');
    expect(mapSyncError({ message: 'Invalid login credentials', status: 400 }).code).toBe(
      'sync_auth',
    );
  });

  it('maps a missing table to sync_config and names the migration', () => {
    const mapped = mapSyncError({ message: 'relation does not exist', code: 'PGRST205' });
    expect(mapped.code).toBe('sync_config');
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toMatch(/0001_init\.sql/);
  });

  it('maps network failures to offline', () => {
    const mapped = mapSyncError(new TypeError('fetch failed'));
    expect(mapped.code).toBe('offline');
    expect(mapped.retryable).toBe(true);
    expect(mapSyncError({ message: 'getaddrinfo ENOTFOUND example.supabase.co' }).code).toBe(
      'offline',
    );
  });

  it('maps a bad key/url to sync_config', () => {
    expect(mapSyncError({ message: 'Invalid API key', status: 401 }).code).toBe('sync_auth');
    expect(mapSyncError({ message: 'supabaseUrl is required' }).code).toBe('sync_config');
  });

  it('maps 5xx to a retryable provider_error and 400/422 to a non-retryable one', () => {
    const server = mapSyncError({ message: 'Bad Gateway', status: 503 });
    expect(server.code).toBe('provider_error');
    expect(server.retryable).toBe(true);

    const rejected = mapSyncError({ message: 'invalid input syntax', status: 400 });
    expect(rejected.code).toBe('provider_error');
    expect(rejected.retryable).toBe(false);
  });

  it('never lets a credential survive in a mapped message', () => {
    const mapped = mapSyncError({ message: 'request failed for key sk-live-abcdef123456' });
    expect(mapped.message).not.toMatch(/sk-live-abcdef123456/);
    expect(mapped.message).toMatch(/sk-REDACTED/);
  });

  it('passes an AppErrorShape through and re-redacts it', () => {
    const shape = appError('provider_error', 'failed with sk-abcdef123456', { retryable: false });
    const mapped = mapSyncError({ shape });
    expect(mapped.code).toBe('provider_error');
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).not.toMatch(/sk-abcdef123456/);
  });

  it('scrubs a configured publishable key from a message', () => {
    const shape = appError('provider_error', 'the key sb_publishable_abcdefghij was rejected');
    const scrubbed = redactKnownSecrets(shape, ['sb_publishable_abcdefghij']);
    expect(scrubbed.message).not.toContain('sb_publishable_abcdefghij');
    expect(scrubbed.message).toContain('[redacted]');
  });
});
