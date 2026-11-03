/**
 * Test harness for the persistence layer.
 *
 * Each test gets its own database file inside the run sink
 * (`.work/<run>/tmp/db-tests/`), never in the repository tree and never in the
 * OS temp directory, so `git status` stays clean and a failed test leaves its
 * database behind for inspection only under the ignored sink.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Database } from '@shared/repository-contract';
import type { ProviderConfig } from '@shared/types';
import { openDatabase } from '@main/db/index';
import { MIGRATIONS } from '@main/db/migrations';

function workspaceRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.cwd();
}

/**
 * Every test run writes under the same runtime sink, never into a dated
 * directory owned by a previous run: a fixed date in the path means the next
 * `npm test` silently appends to an old run's evidence and that directory can
 * never be cleaned up without breaking the suite.
 */
const SINK_ROOT = path.join(workspaceRoot(), '.work', 'test-runtime', 'db-tests');

export class TestDatabase {
  readonly directory: string;
  readonly filePath: string;
  db: Database;

  constructor() {
    mkdirSync(SINK_ROOT, { recursive: true });
    this.directory = mkdtempSync(path.join(SINK_ROOT, 'run-'));
    this.filePath = path.join(this.directory, 'test.db');
    this.db = openDatabase(this.filePath);
  }

  /** Close and re-open the same file, for durability assertions. */
  reopen(): Database {
    this.db.close();
    this.db = openDatabase(this.filePath);
    return this.db;
  }

  dispose(): void {
    this.db.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** A provider with no credential; enough for models and message/model refs. */
export function seedProvider(db: Database, name = 'Test endpoint'): ProviderConfig {
  return db.providers.create({
    kind: 'openai-compatible',
    name,
    baseUrl: 'https://example.test/v1',
  });
}

export const PAST = '2000-01-01T00:00:00.000Z';
export const FUTURE = '2999-01-01T00:00:00.000Z';

/**
 * The schema version this build produces. Tests assert against this instead of a
 * hardcoded number so adding migration 3 does not break every DB test at once.
 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Migration `name` values in application order. */
export const MIGRATION_NAMES: readonly string[] = MIGRATIONS.map((migration) => migration.name);
