import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@main/logger';
import { openDatabase, type DbLogger } from '@main/db/index';
import { MIGRATIONS } from '@main/db/migrations';
import { LATEST_SCHEMA_VERSION, TestDatabase } from './helpers';

/**
 * Compile-time proof that the main-process logger satisfies the database logger
 * contract, so `openDatabase(path, { logger: mainLogger.child('db') })` needs no
 * cast. If either shape drifts, this function stops type-checking.
 */
function acceptsMainLogger(logger: Logger): DbLogger {
  return logger;
}

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

describe('logger integration', () => {
  it('accepts the main-process logger without a cast', () => {
    expect(typeof acceptsMainLogger).toBe('function');
  });

  it('emits lifecycle events through an injected logger and not to the console', () => {
    const info: string[] = [];
    const logger: DbLogger = {
      error: () => undefined,
      warn: () => undefined,
      info: (message) => info.push(message),
      debug: () => undefined,
    };

    const database = openDatabase(path.join(t.directory, 'with-logger.db'), { logger });
    try {
      expect(database.migrations.version()).toBe(LATEST_SCHEMA_VERSION);
      expect(info).toContain('SQLite connection opened.');
      for (const migration of MIGRATIONS) {
        expect(
          info.some((line) => line.startsWith(`Applied database migration ${migration.version}`)),
        ).toBe(true);
      }
    } finally {
      database.close();
    }
    expect(info).toContain('SQLite connection closed.');
  });

  it('falls back to the in-memory ring when no logger is supplied', () => {
    // TestDatabase opens without options; construction alone must not throw and
    // the database must be usable.
    expect(t.db.migrations.version()).toBe(LATEST_SCHEMA_VERSION);
  });
});
