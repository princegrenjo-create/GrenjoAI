import { describe, expect, it } from 'vitest';
import { createHarness, makeLocalRow, TEST_USER_ID } from './helpers/fakes';
import type { Harness } from './helpers/fakes';

async function signIn(harness: Harness): Promise<void> {
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

describe('sync engine — offline, sign-out and configuration', () => {
  it('leaves rows pending and reports offline without throwing, then resumes when online', async () => {
    const harness = createHarness({
      rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    });
    await harness.engine.start();
    await signIn(harness);
    harness.setOnline(false);

    const offlineSummary = await harness.engine.syncNow();

    expect(offlineSummary.phase).toBe('offline');
    expect(offlineSummary.pushed).toBe(0);
    expect(offlineSummary.pulled).toBe(0);
    expect(harness.engine.status().phase).toBe('offline');
    expect(harness.engine.status().online).toBe(false);
    expect(harness.cloud.selects).toHaveLength(0);
    expect(harness.cloud.upserts).toHaveLength(0);
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(true);

    harness.setOnline(true);
    const onlineSummary = await harness.engine.syncNow();

    expect(onlineSummary.pushed).toBe(1);
    expect(onlineSummary.ok).toBe(true);
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(false);
    expect(harness.engine.status().phase).toBe('idle');
  });

  it('sign-out keeps every local row and only clears the session', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } }),
        makeLocalRow({ entity: 'message', id: 'm1', payload: { id: 'm1' } }),
      ],
    });
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();
    expect(harness.db.rows.size).toBe(2);

    harness.db.put({ entity: 'agent', id: 'a1', payload: { id: 'a1' } });
    await harness.engine.signOut();

    expect(harness.cloud.signOutCalls).toBe(1);
    expect(harness.db.rows.size).toBe(3);
    expect(harness.db.rows.has('conversation:c1')).toBe(true);
    expect(harness.db.rows.has('message:m1')).toBe(true);
    expect(harness.db.rows.get('agent:a1')?.dirty).toBe(true);
    expect(harness.engine.status().signedIn).toBe(false);
    expect(harness.engine.status().email).toBeNull();
    expect(harness.engine.status().userId).toBeNull();
  });

  it('reports needs_config when no URL or key is stored, without throwing on sync', async () => {
    const harness = createHarness({
      credentials: null,
      rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    });
    await harness.engine.start();

    expect(harness.engine.status().phase).toBe('needs_config');
    expect(harness.engine.status().enabled).toBe(false);

    const summary = await harness.engine.syncNow();

    expect(summary.phase).toBe('needs_config');
    expect(summary.ok).toBe(false);
    expect(harness.cloud.upserts).toHaveLength(0);
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(true);
  });

  it('maps a rejected sign-in to sync_auth and surfaces it on status', async () => {
    const harness = createHarness({
      signInError: { message: 'Invalid login credentials', status: 400 },
    });
    await harness.engine.start();

    await expect(
      harness.engine.signIn({ email: 'owner@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ shape: { code: 'sync_auth' } });

    expect(harness.engine.status().phase).toBe('error');
    expect(harness.engine.status().lastError?.code).toBe('sync_auth');
    expect(harness.engine.status().lastError?.message).not.toMatch(/Invalid login credentials/);
  });

  it('reports needs_email_confirmation when sign-up creates no session', async () => {
    const harness = createHarness({ requiresEmailConfirmation: true });
    await harness.engine.start();

    const outcome = await harness.engine.signUp({
      email: 'owner@example.com',
      password: 'a-long-password',
    });

    expect(outcome.signedIn).toBe(false);
    expect(outcome.needsEmailConfirmation).toBe(true);
    expect(harness.engine.status().signedIn).toBe(false);
  });

  it('drives SyncStatus from onAuthStateChange events', async () => {
    const harness = createHarness();
    await harness.engine.start();

    harness.cloud.emitAuth('signed_in', { userId: TEST_USER_ID, email: 'owner@example.com' });
    expect(harness.engine.status().signedIn).toBe(true);
    expect(harness.engine.status().userId).toBe(TEST_USER_ID);
    expect(harness.engine.status().email).toBe('owner@example.com');

    harness.cloud.emitAuth('signed_out', null);
    expect(harness.engine.status().signedIn).toBe(false);
    expect(harness.engine.status().email).toBeNull();
    expect(harness.engine.status().userId).toBeNull();
  });

  it('returns a disposed engine safe no-op summary instead of throwing', async () => {
    const harness = createHarness();
    harness.engine.dispose();
    const summary = await harness.engine.syncNow();
    expect(summary.ok).toBe(false);
    expect(summary.phase).toBe('error');
    expect(summary.pushed).toBe(0);
  });
});
