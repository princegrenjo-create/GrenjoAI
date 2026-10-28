/**
 * `node:sqlite` connection behind the shared `SqlRunner` interface.
 *
 * Design points that matter to the rest of the layer:
 *  - Every statement is prepared once per SQL text and cached; SQLite re-compiles
 *    a statement when the schema changes, so a cached handle stays valid.
 *  - Values are always bound, never interpolated. The only strings concatenated
 *    into SQL are column/table names chosen by this module.
 *  - `transaction()` is savepoint-based, which makes nesting safe: a nested call
 *    either commits into its parent savepoint or rolls back to it, and an outer
 *    failure still undoes everything.
 *  - A closed connection throws a `DbError`, not the driver's opaque
 *    `ERR_INVALID_STATE`, so a call after `close()` is diagnosable.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RunResult, SqlRunner, SqlValue } from '../../shared/repository-contract';
import type { DbRow } from './codec';
import { DbError, describeError } from './errors';
import { createDbLogger, type DbLogger } from './log';

const MEMORY_PATH = ':memory:';

export interface ConnectionOptions {
  logger?: DbLogger;
}

export interface DbContext {
  readonly sql: SqlRunner;
  transaction<T>(fn: () => T): T;
}

export class SqliteConnection implements SqlRunner, DbContext {
  readonly filePath: string;

  private readonly db: DatabaseSync;
  private readonly logger: DbLogger;
  private readonly statements = new Map<string, StatementSync>();
  private savepointDepth = 0;
  private isClosed = false;

  constructor(filePath: string, options: ConnectionOptions = {}) {
    this.filePath = filePath;
    this.logger = options.logger ?? createDbLogger();

    if (filePath !== MEMORY_PATH) {
      const parent = dirname(filePath);
      if (parent.length > 0 && parent !== '.') mkdirSync(parent, { recursive: true });
    }

    this.db = new DatabaseSync(filePath);
    try {
      // WAL keeps a reader from blocking the writer while a chat turn streams.
      this.db.exec('PRAGMA journal_mode = WAL');
      // Referential integrity is enforced per connection, so it must be set here.
      this.db.exec('PRAGMA foreign_keys = ON');
      // A second writer (a backup tool, a second window) waits instead of failing.
      this.db.exec('PRAGMA busy_timeout = 5000');
      // NORMAL is durable across process crashes in WAL mode and much faster
      // than FULL; a power loss can only lose the last transaction.
      this.db.exec('PRAGMA synchronous = NORMAL');
    } catch (error) {
      this.db.close();
      throw new DbError('The SQLite connection could not be configured.', 'storage', {
        cause: error,
      });
    }

    this.logger.info('SQLite connection opened.');
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  /** The connection is its own runner; the getter keeps `DbContext` uniform. */
  get sql(): SqlRunner {
    return this;
  }

  exec(sql: string): void {
    this.ensureOpen();
    try {
      this.db.exec(sql);
    } catch (error) {
      throw new DbError('A SQL statement failed to execute.', 'storage', { cause: error });
    }
  }

  run(sql: string, params?: readonly SqlValue[]): RunResult {
    const statement = this.statement(sql);
    try {
      const result = statement.run(...(params ?? []));
      return { changes: Number(result.changes) };
    } catch (error) {
      throw new DbError('A SQL write failed.', 'storage', { cause: error });
    }
  }

  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): T[] {
    return this.readRows(sql, params) as unknown as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): T | null {
    const statement = this.statement(sql);
    try {
      const row: unknown = statement.get(...(params ?? []));
      return row === undefined ? null : (row as T);
    } catch (error) {
      throw new DbError('A SQL read failed.', 'storage', { cause: error });
    }
  }

  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    this.savepointDepth += 1;
    const name = `pad_sp_${this.savepointDepth}`;
    let opened = false;

    try {
      this.db.exec(`SAVEPOINT ${name}`);
      opened = true;
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      if (opened) {
        try {
          this.db.exec(`ROLLBACK TO ${name}`);
          this.db.exec(`RELEASE ${name}`);
        } catch (rollbackFailure) {
          throw new DbError(
            `A transaction could not be rolled back after: ${describeError(error)}`,
            'storage',
            { cause: rollbackFailure },
          );
        }
      }
      // The caller's own error is rethrown unchanged so validation and
      // not-found failures keep their type and message.
      throw error;
    } finally {
      this.savepointDepth -= 1;
    }
  }

  checkpoint(): void {
    this.ensureOpen();
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      throw new DbError('The write-ahead log could not be checkpointed.', 'storage', { cause: error });
    }
    this.logger.debug('Write-ahead log checkpointed.');
  }

  close(): void {
    if (this.isClosed) return;
    this.db.close();
    this.isClosed = true;
    this.statements.clear();
    this.logger.info('SQLite connection closed.');
  }

  private readRows(sql: string, params?: readonly SqlValue[]): DbRow[] {
    const statement = this.statement(sql);
    try {
      // `Record<string, SQLOutputValue>` is assignable to `Record<string, unknown>`.
      return statement.all(...(params ?? []));
    } catch (error) {
      throw new DbError('A SQL read failed.', 'storage', { cause: error });
    }
  }

  private statement(sql: string): StatementSync {
    this.ensureOpen();
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;

    let prepared: StatementSync;
    try {
      prepared = this.db.prepare(sql);
    } catch (error) {
      throw new DbError('A SQL statement could not be prepared.', 'storage', { cause: error });
    }
    this.statements.set(sql, prepared);
    return prepared;
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new DbError('The database connection is closed.', 'storage');
  }
}
