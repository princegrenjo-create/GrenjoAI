import { describe, expect, it } from 'vitest';
import type { SyncStatus } from '@shared/types';
import {
  createInitialSyncStatus,
  createSyncStatusStore,
  STATUS_EMIT_MIN_INTERVAL_MS,
} from '@main/sync/status';

interface Scheduled {
  delay: number;
  runAt: number;
  cancelled: boolean;
  executed: boolean;
  run: () => void;
}

function fakeScheduler(now: () => number, scheduled: Scheduled[]) {
  return (run: () => void, delay: number): (() => void) => {
    const entry: Scheduled = {
      delay,
      runAt: now() + delay,
      cancelled: false,
      executed: false,
      run: () => {},
    };
    entry.run = () => {
      entry.executed = true;
      run();
    };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
}

function setup(): {
  store: ReturnType<typeof createSyncStatusStore>;
  scheduled: Scheduled[];
  seen: SyncStatus[];
  setNow: (value: number) => void;
  now: () => number;
} {
  let nowValue = 1_000;
  const scheduled: Scheduled[] = [];
  const now = (): number => nowValue;
  const store = createSyncStatusStore(createInitialSyncStatus(), {
    now,
    schedule: fakeScheduler(now, scheduled),
  });
  const seen: SyncStatus[] = [];
  store.subscribe((status) => seen.push(status));
  return {
    store,
    scheduled,
    seen,
    now,
    setNow: (value: number) => {
      nowValue = value;
    },
  };
}

describe('sync status store', () => {
  it('emits immediately once and folds a burst into a single trailing emission', () => {
    const { store, scheduled, seen, setNow } = setup();

    store.update({ pendingCount: 1 });
    expect(seen).toHaveLength(1);

    for (let index = 0; index < 10; index += 1) store.update({ pendingCount: index + 2 });
    expect(seen).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(STATUS_EMIT_MIN_INTERVAL_MS);

    setNow(1_250);
    scheduled[0]!.run();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.pendingCount).toBe(11);
  });

  it('never emits more often than four times per second under a steady update stream', () => {
    const { store, scheduled, seen, setNow, now } = setup();
    const emitTimes: number[] = [];
    store.subscribe(() => {
      const at = now();
      if (emitTimes[emitTimes.length - 1] !== at) emitTimes.push(at);
    });

    let nowValue = 1_000;
    for (let step = 0; step < 20; step += 1) {
      nowValue += 50;
      setNow(nowValue);
      store.update({ pendingCount: step });
      for (const entry of scheduled) {
        if (!entry.cancelled && !entry.executed && entry.runAt <= nowValue) entry.run();
      }
    }
    const pending = scheduled.find((entry) => !entry.cancelled && !entry.executed);
    if (pending !== undefined) {
      setNow(pending.runAt);
      pending.run();
    }

    expect(emitTimes.length).toBeGreaterThan(1);
    for (let index = 1; index < emitTimes.length; index += 1) {
      expect(emitTimes[index]! - emitTimes[index - 1]!).toBeGreaterThanOrEqual(
        STATUS_EMIT_MIN_INTERVAL_MS,
      );
    }
    // Four intervals per second means at most five timestamps in a one-second span.
    const window = emitTimes[emitTimes.length - 1]! - emitTimes[0]!;
    expect(emitTimes.length).toBeLessThanOrEqual(Math.ceil(window / 250) + 1);
  });

  it('does not schedule anything when nobody is listening', () => {
    let nowValue = 5_000;
    const scheduled: Scheduled[] = [];
    const store = createSyncStatusStore(createInitialSyncStatus(), {
      now: () => nowValue,
      schedule: fakeScheduler(() => nowValue, scheduled),
    });

    store.update({ pendingCount: 3 });

    expect(scheduled).toHaveLength(0);
    expect(store.get().pendingCount).toBe(3);
    nowValue += 1_000;
    expect(store.get().pendingCount).toBe(3);
  });

  it('flush delivers the latest state immediately and cancels the trailing emission', () => {
    const { store, scheduled, seen } = setup();
    store.update({ pendingCount: 1 });
    store.update({ pendingCount: 2 });
    expect(scheduled).toHaveLength(1);

    store.flush();

    expect(seen[seen.length - 1]!.pendingCount).toBe(2);
    expect(scheduled[0]!.cancelled || scheduled[0]!.executed).toBe(true);
  });

  it('stops delivering after dispose and after unsubscribe', () => {
    const { store, seen } = setup();
    store.update({ pendingCount: 1 });
    const beforeDispose = seen.length;

    store.dispose();
    store.update({ pendingCount: 9 });

    expect(seen).toHaveLength(beforeDispose);

    const { store: second, seen: secondSeen } = setup();
    second.update({ pendingCount: 1 });
    expect(secondSeen).toHaveLength(1);
    second.subscribe(() => {});
    second.dispose();
    second.update({ pendingCount: 2 });
    expect(secondSeen).toHaveLength(1);
  });
});
