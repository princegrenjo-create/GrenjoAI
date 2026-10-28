import { describe, expect, it } from 'vitest';
import { createHarness, makeLocalRow, makeRemoteRow } from './helpers/fakes';
import type { Harness } from './helpers/fakes';

async function signIn(harness: Harness): Promise<void> {
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

function conflictHarness(): Harness {
  return createHarness({
    rows: [
      makeLocalRow({
        entity: 'conversation',
        id: 'c1',
        version: 2,
        dirty: true,
        payload: { id: 'c1', title: 'mine' },
      }),
    ],
    remote: [
      {
        table: 'conversations',
        row: makeRemoteRow({
          id: 'c1',
          version: 5,
          updated_at: '2026-10-29T04:00:00.000Z',
          payload: { id: 'c1', title: 'theirs' },
        }),
      },
    ],
  });
}

describe('sync engine — conflicts', () => {
  it('records a conflict when a newer remote row meets a dirty local row and does not overwrite it', async () => {
    const harness = conflictHarness();
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.conflictsRecorded).toBe(1);
    expect(summary.pulled).toBe(0);
    expect(harness.db.conflictRecords).toHaveLength(1);
    const conflict = harness.db.conflictRecords[0]!;
    expect(conflict.entity).toBe('conversation');
    expect(conflict.entityId).toBe('c1');
    expect(conflict.localRevision).toBe(2);
    expect(conflict.remoteRevision).toBe(5);
    expect(conflict.resolution).toBe('unresolved');
    expect(conflict.summary.length).toBeGreaterThan(0);

    const local = harness.db.rows.get('conversation:c1');
    expect(local?.payload).toMatchObject({ title: 'mine' });
    expect(local?.dirty).toBe(true);
    expect(local?.version).toBe(2);
    expect(harness.engine.status().conflictCount).toBe(1);
    // The stale local row must not be pushed over the newer remote row.
    expect(harness.cloud.upserts).toHaveLength(0);
  });

  it('does not duplicate the conflict on a later sync and still refuses to push the stale row', async () => {
    const harness = conflictHarness();
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();

    const second = await harness.engine.syncNow();

    expect(second.conflictsRecorded).toBe(0);
    expect(harness.db.conflictRecords).toHaveLength(1);
    expect(harness.engine.status().conflictCount).toBe(1);
    expect(harness.cloud.upserts).toHaveLength(0);
    expect(harness.engine.status().pendingCount).toBe(1);
  });

  it('kept_local resolves the conflict and pushes a local revision past the remote one', async () => {
    const harness = conflictHarness();
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();
    const conflictId = harness.db.conflictRecords[0]!.id;

    harness.engine.resolveConflict(conflictId, 'kept_local');
    expect(harness.db.retries).toEqual([{ entity: 'conversation', entityId: 'c1' }]);

    const summary = await harness.engine.syncNow();

    expect(summary.pushed).toBe(1);
    expect(harness.cloud.upserts).toHaveLength(1);
    const pushed = harness.cloud.upserts[0]!.rows[0]!;
    expect(pushed.version).toBe(6);
    expect(pushed.payload).toMatchObject({ title: 'mine' });
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(false);
    expect(harness.engine.status().conflictCount).toBe(0);
  });

  it('kept_remote adopts the remote payload without a further push', async () => {
    const harness = conflictHarness();
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();
    const conflictId = harness.db.conflictRecords[0]!.id;

    harness.engine.resolveConflict(conflictId, 'kept_remote');
    const summary = await harness.engine.syncNow();

    expect(summary.pushed).toBe(0);
    expect(harness.cloud.upserts).toHaveLength(0);
    const local = harness.db.rows.get('conversation:c1');
    expect(local?.payload).toMatchObject({ title: 'theirs' });
    expect(local?.version).toBe(5);
    expect(local?.dirty).toBe(false);
  });
});
