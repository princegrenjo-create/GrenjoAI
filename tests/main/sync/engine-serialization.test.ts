import { describe, expect, it } from 'vitest';
import { createHarness, makeLocalRow } from './helpers/fakes';
import type { Harness } from './helpers/fakes';

async function signIn(harness: Harness): Promise<void> {
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

describe('sync engine — serialization', () => {
  it('joins an in-flight sync instead of starting a second one', async () => {
    const harness = createHarness({
      rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    });
    await harness.engine.start();
    await signIn(harness);

    const release = harness.cloud.gateUpserts();
    const first = harness.engine.syncNow();
    const second = harness.engine.syncNow();

    expect(second).toBe(first);

    release();
    const summary = await first;

    expect(summary.pushed).toBe(1);
    expect(harness.cloud.upserts).toHaveLength(1);
    expect(harness.cloud.selects.filter((entry) => entry.table === 'conversations')).toHaveLength(1);
  });

  it('runs a fresh cycle after the in-flight one settles', async () => {
    const harness = createHarness({
      rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    });
    await harness.engine.start();
    await signIn(harness);

    const first = harness.engine.syncNow();
    await first;
    const second = harness.engine.syncNow();
    await second;

    expect(second).not.toBe(first);
    expect(harness.cloud.upserts).toHaveLength(1);
    expect(harness.cloud.selects.filter((entry) => entry.table === 'conversations')).toHaveLength(2);
  });
});
