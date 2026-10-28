/**
 * Shared base for the SQLite repositories.
 */
import type { WriteOptions } from '../../../shared/repository-contract';
import type { DbContext } from '../connection';

export abstract class BaseRepository {
  constructor(protected readonly ctx: DbContext) {}

  protected get sql() {
    return this.ctx.sql;
  }

  protected transaction<T>(fn: () => T): T {
    return this.ctx.transaction(fn);
  }
}

/**
 * `dirty` defaults to 1: a local write is unsynchronised until a push succeeds.
 * A remote apply passes `{ dirty: false }` so it never echoes back.
 */
export function dirtyFlag(options?: WriteOptions): number {
  return options?.dirty === false ? 0 : 1;
}
