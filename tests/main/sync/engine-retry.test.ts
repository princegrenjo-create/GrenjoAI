import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  computeBackoffMs,
  MAX_PUSH_ATTEMPTS_DEFAULT,
} from '@main/sync/engine';
import { createHarness, makeLocalRow } from './helpers/fakes';
import type { Harness } from './helpers/fakes';

async function signIn(harness: Harness): Promise<void> {
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

function retryHarness(upsertError: Parameters<Harness['cloud']['setUpsertError']>[0]): Harness {
  return createHarness({
    rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    upsertError,
  });
}

describe('sync engine — retry and backoff', () => {
  it('retries a temporary 503 with increasing delays and then succeeds', async () => {
    const harness = retryHarness(({ attempt }) =>
      attempt <= 2 ? { message: 'Service Unavailable', status: 503 } : null,
    );
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(harness.sleeps).toEqual([800, 1600]);
    expect(summary.pushed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.ok).toBe(true);
    expect(harness.db.failures).toHaveLength(0);
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(false);
  });

  it('records a failure with a bounded next-attempt time after the retry budget is spent', async () => {
    const harness = retryHarness(() => ({ message: 'Service Unavailable', status: 503 }));
    await harness.engine.start();
    await signIn(harness);
    const startedAt = harness.clock.now();

    const summary = await harness.engine.syncNow();

    expect(harness.sleeps).toEqual([800, 1600]);
    expect(summary.pushed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.phase).toBe('error');
    expect(harness.db.failures).toHaveLength(1);
    const failure = harness.db.failures[0]!;
    expect(Date.parse(failure.nextAttemptAt)).toBe(startedAt + 3200);
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(true);
    expect(harness.engine.status().lastError?.code).toBe('provider_error');
    expect(harness.engine.status().phase).toBe('error');
  });

  it('does not retry a non-retryable 400', async () => {
    const harness = retryHarness(() => ({
      message: 'The server rejected the record',
      status: 400,
    }));
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(harness.sleeps).toEqual([]);
    expect(summary.failed).toBe(1);
    expect(harness.db.failures).toHaveLength(1);
    expect(harness.engine.status().lastError?.code).toBe('provider_error');
    expect(harness.engine.status().lastError?.retryable).toBe(false);
  });

  it('treats a 429 as retryable', async () => {
    const harness = retryHarness(({ attempt }) =>
      attempt === 1 ? { message: 'Too many requests', status: 429 } : null,
    );
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(harness.sleeps).toEqual([800]);
    expect(summary.pushed).toBe(1);
    expect(harness.engine.status().lastError).toBeNull();
  });

  it('never returns a negative, unbounded or non-finite backoff', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(800);
    expect(computeBackoffMs(2, () => 0)).toBe(1600);
    expect(computeBackoffMs(3, () => 0)).toBe(3200);
    expect(computeBackoffMs(1, () => 1)).toBe(960);
    expect(computeBackoffMs(20, () => 0)).toBe(BACKOFF_MAX_MS);
    expect(computeBackoffMs(20, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(computeBackoffMs(-4, () => 0)).toBe(800);
    expect(computeBackoffMs(Number.NaN, () => 0)).toBe(800);
    expect(computeBackoffMs(1, () => Number.NaN)).toBe(800);
    expect(computeBackoffMs(1, () => Number.POSITIVE_INFINITY)).toBe(800);
    expect(MAX_PUSH_ATTEMPTS_DEFAULT).toBe(3);
  });
});
