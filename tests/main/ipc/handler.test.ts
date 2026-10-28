import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInvoker } from '@main/ipc/handler';
import { AppError, appError } from '@shared/errors';
import { createNullLogger } from '@main/logger';

const schema = z.object({ name: z.string().trim().min(1).max(10), count: z.number().int().min(0) }).strict();

function invoker(handler: (input: { name: string; count: number }) => unknown, trustedId = 7) {
  const assertSender = vi.fn((senderId: number) => {
    if (senderId !== trustedId) throw new AppError(appError('validation', 'Untrusted caller.'));
  });
  return {
    assertSender,
    invoke: createInvoker({
      schema,
      handler,
      assertSender,
      label: 'test:channel',
      logger: createNullLogger(),
    }),
  };
}

describe('IPC message runner', () => {
  it('runs the handler with validated input and wraps the result', async () => {
    const handler = vi.fn(() => ({ echoed: true }));
    const { invoke } = invoker(handler);
    const result = await invoke({ name: 'abc', count: 2 }, 7);
    expect(result).toEqual({ ok: true, data: { echoed: true } });
    expect(handler).toHaveBeenCalledWith({ name: 'abc', count: 2 });
  });

  it('rejects a message from a web contents that is not the app window', async () => {
    const handler = vi.fn();
    const { invoke, assertSender } = invoker(handler);
    const result = await invoke({ name: 'abc', count: 1 }, 99);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
    expect(assertSender).toHaveBeenCalledWith(99);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range value before the handler runs', async () => {
    const handler = vi.fn();
    const { invoke } = invoker(handler);
    const result = await invoke({ name: 'abc', count: -3 }, 7);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
    expect(result.ok === false ? result.error.message : '').toMatch(/count/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unknown key on a strict schema instead of ignoring it', async () => {
    const handler = vi.fn();
    const { invoke } = invoker(handler);
    const result = await invoke({ name: 'abc', count: 1, rouge: true }, 7);
    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a payload of the wrong type', async () => {
    const { invoke } = invoker(vi.fn());
    const result = await invoke({ name: 5, count: 'many' }, 7);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
  });

  it('rejects a missing payload for a schema that requires one', async () => {
    const { invoke } = invoker(vi.fn());
    const result = await invoke(undefined, 7);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
  });

  it('preserves the error code of a thrown AppError', async () => {
    const { invoke } = invoker(() => {
      throw new AppError(appError('rate_limited', 'Slow down.', { retryable: true }));
    });
    const result = await invoke({ name: 'abc', count: 1 }, 7);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('maps an unexpected throw to a generic message instead of leaking the exception', async () => {
    const { invoke } = invoker(() => {
      throw new Error('boom at C:\\secret\\path.ts:42');
    });
    const result = await invoke({ name: 'abc', count: 1 }, 7);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('unknown');
      expect(result.error.message).toMatch(/written to the application log/i);
      expect(result.error.message).not.toContain('secret');
      expect(result.error.message).not.toMatch(/at .*:\d+/);
    }
  });

  it('redacts a credential that appears in a designed error message', async () => {
    const { invoke } = invoker(() => {
      throw new AppError(appError('provider_error', 'bad key sk-live-abcdef1234567890'));
    });
    const result = await invoke({ name: 'abc', count: 1 }, 7);
    expect(result.ok === false ? result.error.message : '').not.toContain(
      'sk-live-abcdef1234567890',
    );
  });

  it('supports a handler with no payload schema', async () => {
    const invoke = createInvoker({
      schema: null,
      handler: () => 42,
      assertSender: () => undefined,
      label: 'test:no-payload',
    });
    expect(await invoke(undefined, 1)).toEqual({ ok: true, data: 42 });
  });
});
