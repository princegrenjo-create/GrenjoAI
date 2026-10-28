/**
 * Structured log for the persistence layer.
 *
 * `DbLogger` is the minimal four-method shape, so the main-process `Logger` from
 * `src/main/logger.ts` satisfies it structurally: the app passes
 * `{ logger: mainLogger.child('db') }` to `openDatabase`. When no logger is
 * supplied (a plain Node test, a migration script) the default is a bounded
 * in-memory ring, which is observable through `entries()` and writes nothing to
 * stdout/stderr — that is what keeps the layer quiet in tests.
 *
 * Security rule: a message never contains a bound SQL value, a row body, or
 * anything derived from a credential. Only constant, human-written sentences and
 * non-secret counts/identifiers may be recorded.
 */

export type DbLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface DbLogEntry {
  readonly level: DbLogLevel;
  readonly message: string;
  readonly at: string;
}

/**
 * Structural subset of `src/main/logger.ts`'s `Logger`. Keeping it structural
 * means this module never imports the main-process logger (and its file handle),
 * while still accepting it at runtime.
 */
export interface DbLogger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/** Default logger: the four methods plus read access for diagnostics. */
export interface DbLogRing extends DbLogger {
  entries(): readonly DbLogEntry[];
  clear(): void;
}

const LEVEL_WEIGHT: Record<DbLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_CAPACITY = 200;

export function createDbLogger(minLevel: DbLogLevel = 'info', capacity = DEFAULT_CAPACITY): DbLogRing {
  const limit = Math.max(1, Math.trunc(capacity));
  const threshold = LEVEL_WEIGHT[minLevel];
  const buffer: DbLogEntry[] = [];

  const record = (level: DbLogLevel, message: string): void => {
    if (LEVEL_WEIGHT[level] > threshold) return;
    buffer.push({ level, message, at: new Date().toISOString() });
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  };

  return {
    error: (message) => record('error', message),
    warn: (message) => record('warn', message),
    info: (message) => record('info', message),
    debug: (message) => record('debug', message),
    entries: () => buffer.slice(),
    clear: () => {
      buffer.length = 0;
    },
  };
}

/** Logger that retains only errors, for callers that never inspect it. */
export function createSilentDbLogger(): DbLogRing {
  return createDbLogger('error', 1);
}
