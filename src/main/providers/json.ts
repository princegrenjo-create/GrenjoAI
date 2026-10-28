/**
 * Small, explicit JSON helpers for provider payloads.
 *
 * `JSON.parse` has an `any` type, and the provider is an untrusted boundary, so
 * every field read goes through one of these narrowing functions instead of a
 * cast. Nothing here throws: a truncated or malformed payload is reported as
 * "not usable" and the caller skips it, which is what keeps a broken frame from
 * aborting a stream.
 */
import type { ChatStreamChunk, ResponseParser } from '@shared/provider-contract';
import type { TokenUsage } from '@shared/types';

/** Parse a JSON text, or `null` when the text is empty or malformed. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value;
  } catch {
    // Malformed JSON is data the caller must skip, not an exception to surface.
    return null;
  }
}

/** True for a JSON object (not `null`, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function recordAt(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!record) return null;
  return asRecord(record[key]);
}

export function arrayAt(record: Record<string, unknown> | null, key: string): unknown[] {
  if (!record) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function stringAt(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** First object inside an array, skipping anything that is not an object. */
export function firstRecord(values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

/**
 * Merge token counts without letting an `undefined` field overwrite a value an
 * earlier chunk already reported.
 */
export function mergeUsage(previous: TokenUsage | null, next: TokenUsage): TokenUsage {
  const merged: TokenUsage = previous ? { ...previous } : {};
  if (next.promptTokens !== undefined) merged.promptTokens = next.promptTokens;
  if (next.completionTokens !== undefined) merged.completionTokens = next.completionTokens;
  if (next.totalTokens !== undefined) merged.totalTokens = next.totalTokens;
  return merged;
}

/**
 * Parser for a provider that returns one whole JSON document. The body is
 * accumulated and parsed once at `end`, so a caller may feed it in arbitrary
 * chunks.
 */
export function createBufferedParser(parse: (body: string) => ChatStreamChunk[]): ResponseParser {
  let buffer = '';
  let ended = false;
  return {
    push(chunk: string): ChatStreamChunk[] {
      if (ended) return [];
      buffer += chunk;
      return [];
    },
    end(): ChatStreamChunk[] {
      if (ended) return [];
      ended = true;
      const body = buffer;
      buffer = '';
      return parse(body);
    },
  };
}
