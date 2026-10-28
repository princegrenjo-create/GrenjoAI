/**
 * Chat execution facade.
 *
 * The retry loop, error mapping and stream handling live in `ProviderTransport`
 * (the single place the app performs provider I/O). This module exposes the
 * chunk-oriented API the original provider brief described, adapting the
 * transport's text/reasoning/usage hooks onto `ChatStreamChunk` values, plus a
 * buffered helper for "test this model" flows.
 *
 * Contract note: a failed request never yields a result that could be mistaken
 * for a successful reply — every failure is thrown as the shared `AppError`.
 */
import type {
  BufferedCompletion,
  ChatCompletionRequest,
  ChatRunResult,
  ChatStreamChunk,
  ProviderAdapter,
  ProviderRuntime,
  TransportOptions,
} from '@shared/provider-contract';
import type { TokenUsage } from '@shared/types';
import { createProviderTransport } from './transport';

export interface ChatStreamHooks {
  /**
   * Every parser chunk. Text and reasoning arrive as they stream; usage arrives
   * when the provider reports it; the finish chunk is emitted once, last, when
   * the run completes.
   */
  onChunk?(chunk: ChatStreamChunk): void;
  onUsage?(usage: TokenUsage): void;
  /** Called exactly once; `null` means the provider never reported a reason. */
  onFinish?(reason: string | null): void;
}

/**
 * Run one chat completion, streaming or buffered, through the adapter.
 *
 * Retries (at most `options.maxRetries`, default 2) happen only for retryable
 * failures raised before any content was emitted. A failure after the first
 * emitted byte is surfaced, never retried.
 */
export async function runChat(
  runtime: ProviderRuntime,
  adapter: ProviderAdapter,
  request: ChatCompletionRequest,
  hooks: ChatStreamHooks = {},
  options: TransportOptions = {},
): Promise<ChatRunResult> {
  const transport = createProviderTransport();
  const result = await transport.run(
    runtime,
    adapter,
    request,
    {
      onText: (text) => hooks.onChunk?.({ type: 'text', text }),
      onReasoning: (text) => hooks.onChunk?.({ type: 'reasoning', text }),
      onUsage: (usage) => {
        hooks.onChunk?.({ type: 'usage', usage });
        hooks.onUsage?.(usage);
      },
      onFinish: (reason) => {
        hooks.onChunk?.({ type: 'finish', reason });
        hooks.onFinish?.(reason);
      },
    },
    options,
  );

  if (result.finishReason === null) hooks.onFinish?.(null);
  return result;
}

/** Buffered (non-streaming) completion, used by connection/model probes. */
export async function runBuffered(
  runtime: ProviderRuntime,
  adapter: ProviderAdapter,
  request: ChatCompletionRequest,
  options: TransportOptions = {},
): Promise<BufferedCompletion> {
  const result = await runChat(runtime, adapter, { ...request, stream: false }, {}, options);
  return { text: result.text, usage: result.usage, finishReason: result.finishReason };
}
