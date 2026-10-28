/**
 * Persistence-layer errors.
 *
 * The failure kinds are deliberately tiny: `storage` for a broken database
 * operation, `not_found` for a row the caller named but which is absent or
 * soft-deleted, and `validation` for a remote payload the layer refuses to
 * write. The IPC layer maps these onto the shared `AppErrorShape` codes, so a
 * storage failure never reaches the renderer as an unhandled exception.
 */

export type DbErrorCode = 'storage' | 'not_found' | 'validation';

export interface DbErrorOptions {
  cause?: unknown;
}

export class DbError extends Error {
  readonly dbCode: DbErrorCode;

  constructor(message: string, dbCode: DbErrorCode = 'storage', options?: DbErrorOptions) {
    super(message, options);
    this.name = 'DbError';
    this.dbCode = dbCode;
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}

/** Keeps a chained cause readable without interpolating arbitrary objects. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return 'unknown error';
}
