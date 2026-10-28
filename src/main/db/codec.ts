/**
 * Primitive coercion at the SQLite boundary.
 *
 * `node:sqlite` hands back `Record<string, SQLOutputValue>` — untyped rows whose
 * values are the driver's own union. Every read goes through one of these
 * helpers so a column that is NULL, a number stored as text, or a JSON document
 * that no longer parses degrades to a documented fallback instead of becoming an
 * `undefined` that leaks into the domain objects.
 */
import { randomUUID } from 'node:crypto';
import type { SqlValue } from '../../shared/repository-contract';

export type DbRow = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function isRow(value: unknown): value is DbRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

export function nullableNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return fallback;
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Non-negative integer, clamped; used for limits and offsets read from callers. */
export function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * JSON value -> decoded value, or `null` when the input is absent/corrupt.
 *
 * Accepts both forms the layer sees: a JSON text column, and an already-decoded
 * value from a remote sync payload. A decode failure returns `null` so every
 * caller applies its own default instead of failing a read on one bad document.
 */
export function parseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value;
  return null;
}

/** JSON column known to hold an object -> object, otherwise `null`. */
export function parseJsonObject(value: unknown): DbRow | null {
  const parsed = parseJson(value);
  return isRow(parsed) ? parsed : null;
}

/** Domain value -> JSON column text, with `null`/`undefined` stored as SQL NULL. */
export function jsonOrNull(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

export function pickOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return isOneOf(value, allowed) ? value : fallback;
}

/**
 * Escapes the `LIKE` metacharacters so a user searching for `100%` matches the
 * literal text instead of every row. Paired with `ESCAPE '\'` in the query.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
