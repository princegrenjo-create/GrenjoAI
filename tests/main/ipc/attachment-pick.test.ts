/**
 * The attachment picker's payload is validated before the OS dialog opens.
 *
 * `kinds` is a renderer-supplied string that reaches a native dialog, so it is
 * checked exactly like every other value on the boundary: a closed enum, a
 * strict object, and no handler call at all when the value is not one the
 * dialog has a filter for.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInvoker } from '@main/ipc/handler';
import { createNullLogger } from '@main/logger';
import { attachmentPickSchema } from '@shared/schemas';

type PickPayload = { kinds?: 'file' | 'image' } | undefined;

function pickInvoker(handler: (input: PickPayload) => unknown) {
  return createInvoker<PickPayload, unknown>({
    schema: attachmentPickSchema,
    handler,
    assertSender: () => undefined,
    label: 'attachments:pick',
    logger: createNullLogger(),
  });
}

describe('attachments:pick payload', () => {
  it('accepts a call with no argument, as every existing caller makes', async () => {
    const handler = vi.fn(() => 'picked');
    const invoke = pickInvoker(handler);

    expect(await invoke(undefined, 1)).toEqual({ ok: true, data: 'picked' });
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('accepts an empty options object', async () => {
    const handler = vi.fn(() => 'picked');
    const invoke = pickInvoker(handler);

    expect(await invoke({}, 1)).toEqual({ ok: true, data: 'picked' });
    expect(handler).toHaveBeenCalledWith({});
  });

  it('accepts the image kind and hands it to the handler', async () => {
    const handler = vi.fn(() => 'picked');
    const invoke = pickInvoker(handler);

    expect(await invoke({ kinds: 'image' }, 1)).toEqual({ ok: true, data: 'picked' });
    expect(handler).toHaveBeenCalledWith({ kinds: 'image' });
  });

  it('accepts the file kind', async () => {
    const handler = vi.fn(() => 'picked');
    const invoke = pickInvoker(handler);

    expect(await invoke({ kinds: 'file' }, 1)).toEqual({ ok: true, data: 'picked' });
    expect(handler).toHaveBeenCalledWith({ kinds: 'file' });
  });

  it('rejects a kind the dialog has no filter for', async () => {
    const handler = vi.fn();
    const invoke = pickInvoker(handler);

    const result = await invoke({ kinds: 'video' }, 1);

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects audio: the enum is closed, and recordings come from the recorder', async () => {
    const handler = vi.fn();
    const invoke = pickInvoker(handler);

    const result = await invoke({ kinds: 'audio' }, 1);

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unknown key instead of ignoring it', async () => {
    const handler = vi.fn();
    const invoke = pickInvoker(handler);

    const result = await invoke({ kinds: 'image', extensions: ['exe'] }, 1);

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.code : null).toBe('validation');
    expect(handler).not.toHaveBeenCalled();
  });
});
