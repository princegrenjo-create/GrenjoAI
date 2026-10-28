/**
 * Bounded request timeout.
 *
 * Supabase-js applies no default request timeout: a socket that connects and then stalls
 * leaves the fetch promise pending forever. The sync engine therefore runs every cloud
 * operation through `withTimeout`, so a stalled request fails as the shared, retryable
 * `timeout` error instead of wedging the sync cycle and the in-flight latch.
 *
 * The timer is injected (`setTimer`) so the behaviour is tested deterministically without
 * a real clock and without waiting 30 seconds.
 */

export const REQUEST_TIMEOUT_MS_DEFAULT = 30_000;
export const SYNC_TIMEOUT_CODE = 'SYNC_TIMEOUT';

/** Schedule one timeout; the returned function cancels it. */
export type TimerScheduler = (callback: () => void, delayMs: number) => () => void;

export type SyncRequestOperation =
  | 'session'
  | 'pull'
  | 'push'
  | 'sign-in'
  | 'sign-up'
  | 'sign-out';

const OPERATION_LABEL: Record<SyncRequestOperation, string> = {
  session: 'session',
  pull: 'read',
  push: 'write',
  'sign-in': 'sign-in',
  'sign-up': 'sign-up',
  'sign-out': 'sign-out',
};

export class SyncTimeoutError extends Error {
  readonly code = SYNC_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly operation: SyncRequestOperation;

  constructor(operation: SyncRequestOperation, timeoutMs: number) {
    super(
      `The Supabase ${OPERATION_LABEL[operation]} request did not complete within ${timeoutMs} ms.`,
    );
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutOptions {
  timeoutMs: number;
  /** Test seam; production uses `setTimeout`. */
  setTimer?: TimerScheduler;
}

export function defaultTimerScheduler(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Race `task` against a bounded deadline. A late resolution or rejection from the losing
 * task is ignored (Promise.race keeps the handler attached, so it is not an unhandled
 * rejection), and the timer is always cancelled on settle.
 */
export function withTimeout<T>(
  operation: SyncRequestOperation,
  task: Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;

  const schedule = options.setTimer ?? defaultTimerScheduler;
  let cancel: (() => void) | null = null;

  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = schedule(() => {
      reject(new SyncTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([task, deadline]).finally(() => {
    if (cancel !== null) {
      cancel();
      cancel = null;
    }
  });
}
