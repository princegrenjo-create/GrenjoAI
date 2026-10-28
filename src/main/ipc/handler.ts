/**
 * The IPC message runner, extracted from `register.ts` so it can be tested
 * without Electron.
 *
 * Two guarantees live here and nowhere else:
 *  1. a message from any web contents other than the app's only window is
 *     rejected before the payload is even parsed;
 *  2. the payload is schema-validated before the handler runs, and a failure is
 *     returned as a structured `validation` envelope rather than a thrown string.
 */
import type { z } from 'zod';
import type { IpcResult } from '@shared/api';
import { AppError, appError, toAppError } from '@shared/errors';
import { formatZodError } from '@shared/schemas';
import type { Logger } from '../logger';

export interface HandlerDefinition<TIn, TOut> {
  schema: z.ZodType<TIn> | null;
  handler: (input: TIn) => TOut | Promise<TOut>;
  /** Throws when the sender is not the app's own window. */
  assertSender: (senderId: number) => void;
  label: string;
  logger?: Logger;
}

export type Invoker<TOut> = (raw: unknown, senderId: number) => Promise<IpcResult<TOut>>;

export function createInvoker<TIn, TOut>(definition: HandlerDefinition<TIn, TOut>): Invoker<TOut> {
  return async (raw, senderId) => {
    try {
      definition.assertSender(senderId);

      let input: TIn;
      if (definition.schema === null) {
        input = undefined as TIn;
      } else {
        const parsed = definition.schema.safeParse(raw ?? undefined);
        if (!parsed.success) {
          throw new AppError(appError('validation', formatZodError(parsed.error)));
        }
        input = parsed.data;
      }

      const data = (await definition.handler(input)) as TOut;
      return { ok: true, data };
    } catch (error) {
      // A designed error (AppError) carries a message written for the user and a
      // code the UI can branch on. Anything else is unexpected: the real text
      // goes to the log, and the renderer receives a generic sentence rather
      // than a raw exception message that may contain an internal path.
      if (!(error instanceof AppError)) {
        const shape = toAppError(error, 'unknown');
        if (shape.code === 'unknown') {
          definition.logger?.error('Unhandled failure in an IPC handler', {
            channel: definition.label,
            detail: error instanceof Error ? error.message : String(error),
          });
          return {
            ok: false,
            error: {
              code: 'unknown',
              message:
                'Something went wrong while handling that request. The details were written to the application log.',
              retryable: false,
            },
          };
        }
        definition.logger?.debug('IPC call failed', {
          channel: definition.label,
          code: shape.code,
          status: shape.status,
        });
        return { ok: false, error: shape };
      }

      definition.logger?.debug('IPC call failed', {
        channel: definition.label,
        code: error.shape.code,
        status: error.shape.status,
      });
      return { ok: false, error: error.shape };
    }
  };
}
