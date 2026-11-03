/**
 * Versioned migration runner.
 *
 * Rules the runner enforces:
 *  - `schema_migrations` is created before anything else, so an interrupted
 *    first run leaves a database that can be re-opened and retried.
 *  - Each migration executes inside its own savepoint. A migration that throws
 *    rolls back completely and its version is not recorded, so the next open
 *    applies it again from a consistent schema.
 *  - Re-running the runner is a no-op: applied versions are skipped.
 *  - A database whose recorded version is newer than this build knows about is
 *    rejected instead of being silently used with a missing table.
 */
import type { MigrationRecord, SqlRunner } from '../../../shared/repository-contract';
import { num, str } from '../codec';
import { DbError, describeError } from '../errors';
import type { DbLogger } from '../log';
import { INITIAL_SCHEMA_SQL } from './001-initial-schema';
import { MESSAGE_ATTACHMENTS_SQL } from './002-message-attachments';
import { MEDIA_SCHEMA_SQL } from './003-media';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial-schema', sql: INITIAL_SCHEMA_SQL },
  // Additive: an existing database gains a defaulted column, so a message written
  // before attachments existed reads back with an empty list rather than failing.
  { version: 2, name: 'message-attachments', sql: MESSAGE_ATTACHMENTS_SQL },
  // Additive: two new tables for generated media and the jobs that produce it.
  // No existing table or row is touched. Local-only — no sync header.
  { version: 3, name: 'media', sql: MEDIA_SCHEMA_SQL },
];

const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export function assertMigrationSet(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new DbError('The migration set is empty.', 'storage');
  }
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new DbError('A migration has an invalid version number.', 'storage');
    }
    if (migration.name.trim().length === 0) {
      throw new DbError('A migration has an empty name.', 'storage');
    }
    if (migration.version <= previous) {
      throw new DbError('Migration versions must be strictly increasing.', 'storage');
    }
    previous = migration.version;
  }
  const first = migrations[0];
  if (first === undefined || first.version !== 1) {
    throw new DbError('The migration set must start at version 1.', 'storage');
  }
}

/** Applies every pending migration and returns the resulting schema version. */
export function runMigrations(sql: SqlRunner, logger: DbLogger): number {
  assertMigrationSet(MIGRATIONS);
  sql.exec(SCHEMA_MIGRATIONS_SQL);

  const appliedRows = sql.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set<number>();
  for (const row of appliedRows) applied.add(num(row.version));

  const latestKnown = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const newestApplied = applied.size === 0 ? 0 : Math.max(...applied);
  if (newestApplied > latestKnown) {
    throw new DbError(
      `The database schema version (${newestApplied}) is newer than this build supports (${latestKnown}).`,
      'storage',
    );
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const savepoint = `pad_migration_${migration.version}`;
    let opened = false;
    try {
      sql.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      sql.exec(migration.sql);
      sql.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
      sql.exec(`RELEASE ${savepoint}`);
    } catch (error) {
      if (opened) {
        try {
          sql.exec(`ROLLBACK TO ${savepoint}`);
          sql.exec(`RELEASE ${savepoint}`);
        } catch (rollbackFailure) {
          throw new DbError(
            `Migration ${migration.version} (${migration.name}) failed and could not be rolled back.`,
            'storage',
            { cause: rollbackFailure },
          );
        }
      }
      throw new DbError(
        `Migration ${migration.version} (${migration.name}) failed: ${describeError(error)}`,
        'storage',
        { cause: error },
      );
    }
    logger.info(`Applied database migration ${migration.version} (${migration.name}).`);
  }

  const finalRow = sql.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  return finalRow === null ? 0 : num(finalRow.version, 0);
}

/** Read-only view of the applied schema versions. */
export class MigrationState {
  constructor(private readonly sql: SqlRunner) {}

  version(): number {
    const row = this.sql.get<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    return row === null ? 0 : num(row.version, 0);
  }

  history(): MigrationRecord[] {
    const rows = this.sql.query<{ version: number; name: string; applied_at: string }>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC',
    );
    return rows.map((row) => ({
      version: num(row.version),
      name: str(row.name),
      appliedAt: str(row.applied_at),
    }));
  }
}
