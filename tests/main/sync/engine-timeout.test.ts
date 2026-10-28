/**
 * Regression guard for the "silent hang" finding.
 *
 * A socket that connects and then stalls must not leave a sync promise pending forever.
 * Every request the engine makes is bounded by `requestTimeoutMs` (30 s default), the
 * timeout is reported as the shared `timeout` error shape, and the in-flight latch is
 * released so a later sync can still run.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, makeLocalRow } from './helpers/fakes';
import type { Harness, ScheduledTimeout } from './helpers/fakes';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function waitFor(check: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForLiveTimeout(harness: Harness): Promise<ScheduledTimeout> {
  await waitFor(() => harness.nextLiveTimeout() !== undefined, 'a request timeout to be scheduled');
  const timer = harness.nextLiveTimeout();
  if (timer === undefined) throw new Error('No request timeout was scheduled');
  return timer;
}

async function startAndSignIn(harness: Harness): Promise<void> {
  await harness.engine.start();
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

function queuedRow(): ReturnType<typeof makeLocalRow> {
  return makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } });
}

describe('sync engine — request timeout and latch release', () => {
  it('times out a stalled pull with the default 30 s budget and reports a Supabase timeout', async () => {
    const harness = createHarness({ rows: [queuedRow()], hangSelect: true });
    await startAndSignIn(harness);

    const pending = harness.engine.syncNow();
    await waitFor(() => harness.cloud.selects.length > 0, 'the pull query to start');
    const timer = await waitForLiveTimeout(harness);
    expect(timer.delayMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);

    expect(harness.fireNextTimeout()).not.toBeNull();
    const summary = await pending;

    expect(summary.ok).toBe(false);
    expect(summary.phase).toBe('error');
    expect(harness.engine.status().phase).toBe('error');
    expect(harness.engine.status().phase).not.toBe('syncing');
    expect(harness.engine.status().lastError?.code).toBe('timeout');
    expect(harness.engine.status().lastError?.retryable).toBe(true);
    expect(harness.engine.status().lastError?.message).toMatch(/Supabase/);
    // Nothing was pushed and the row is still in the outbox.
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(true);
    expect(harness.db.pushes).toHaveLength(0);
  });

  it('clears the in-flight latch after a timeout so a later healthy sync completes', async () => {
    const harness = createHarness({ rows: [queuedRow()], hangSelect: true });
    await startAndSignIn(harness);

    const stalled = harness.engine.syncNow();
    await waitFor(() => harness.cloud.selects.length > 0, 'the pull query to start');
    await waitForLiveTimeout(harness);
    harness.fireNextTimeout();

    const stalledSummary = await stalled;
    expect(stalledSummary.phase).toBe('error');
    expect(harness.engine.status().phase).not.toBe('syncing');

    harness.cloud.setHangSelect(false);

    const healthy = harness.engine.syncNow();
    expect(healthy).not.toBe(stalled);
    const healthySummary = await healthy;

    expect(healthySummary.ok).toBe(true);
    expect(healthySummary.pushed).toBe(1);
    expect(harness.engine.status().phase).toBe('idle');
    expect(harness.engine.status().lastError).toBeNull();
  });

  it('reports syncing only while a cycle is actually running', async () => {
    const harness = createHarness({ rows: [queuedRow()], hangSelect: true });
    await startAndSignIn(harness);

    const pending = harness.engine.syncNow();
    await waitFor(() => harness.cloud.selects.length > 0, 'the pull query to start');
    expect(harness.engine.status().phase).toBe('syncing');

    await waitForLiveTimeout(harness);
    harness.fireNextTimeout();
    await pending;

    expect(harness.engine.status().phase).not.toBe('syncing');
    expect(harness.engine.status().phase).toBe('error');
  });

  it('times out a stalled push, exhausts the retry budget and keeps the row queued', async () => {
    const harness = createHarness({ rows: [queuedRow()], hangUpsert: true });
    await startAndSignIn(harness);
    const startedAt = harness.clock.now();

    const pending = harness.engine.syncNow();
    await waitFor(() => harness.cloud.upserts.length > 0, 'the push to start');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const timer = await waitForLiveTimeout(harness);
      expect(timer.delayMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(harness.fireNextTimeout()).not.toBeNull();
    }
    const summary = await pending;

    expect(harness.cloud.upserts).toHaveLength(3);
    expect(harness.sleeps).toEqual([800, 1600]);
    expect(summary.failed).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(summary.ok).toBe(false);
    expect(summary.phase).toBe('error');

    const row = harness.db.rows.get('conversation:c1');
    expect(row?.dirty).toBe(true);
    expect(row?.attempts).toBe(1);
    expect(harness.db.pushes).toHaveLength(0);
    expect(harness.db.failures).toHaveLength(1);
    expect(Date.parse(harness.db.failures[0]!.nextAttemptAt) - startedAt).toBe(3200);
    expect(harness.engine.status().lastError?.code).toBe('timeout');
    expect(harness.engine.status().lastError?.retryable).toBe(true);
    expect(harness.engine.status().phase).toBe('error');
  });

  it('never reports syncing after dispose interrupts an in-flight cycle', async () => {
    const harness = createHarness({ rows: [queuedRow()], hangSelect: true });
    await startAndSignIn(harness);

    const pending = harness.engine.syncNow();
    await waitFor(() => harness.cloud.selects.length > 0, 'the pull query to start');
    await waitForLiveTimeout(harness);

    harness.engine.dispose();
    expect(harness.engine.status().phase).not.toBe('syncing');

    harness.fireNextTimeout();
    await pending;
    expect(harness.engine.status().phase).not.toBe('syncing');
  });

  it('honours a configured requestTimeoutMs', async () => {    const harness = createHarness({
      rows: [queuedRow()],
      hangSelect: true,
      requestTimeoutMs: 5_000,
    });
    await startAndSignIn(harness);

    const pending = harness.engine.syncNow();
    await waitFor(() => harness.cloud.selects.length > 0, 'the pull query to start');
    const timer = await waitForLiveTimeout(harness);
    expect(timer.delayMs).toBe(5_000);

    harness.fireNextTimeout();
    const summary = await pending;

    expect(summary.phase).toBe('error');
    expect(harness.engine.status().lastError?.code).toBe('timeout');
    expect(harness.engine.status().lastError?.message).toContain('5000');
  });
});
