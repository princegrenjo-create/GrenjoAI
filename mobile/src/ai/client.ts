/**
 * Chat and transcription orchestration for the mobile app.
 *
 * The provider adapters under `src/ai/providers` are copied verbatim from the
 * desktop build (`src/main/providers`), so the request shapes, SSE parsing and
 * error mapping are the same code that is unit-tested there. What is mobile-only
 * is: resolving a provider/model pair from this device's store, driving the
 * stream through `expo/fetch`, and turning the result into chat events.
 */
import { AppError, appError, errorForStatus, toAppError } from '@core/errors';
import type {
  ChatCompletionRequest,
  ChatContentPart,
  ChatStreamChunk,
  ProviderAdapter,
  ProviderRuntime,
  TranscriptionRequest,
} from '@core/provider-contract';
import type { ChatTurn } from '@core/provider-contract';
import type { GenerationParams, ModelDescriptor } from '@core/types';
import { createRegistry } from '@ai/providers/registry';
import { createRequestSignal, mobileFetch, readStream } from './transport';

export const registry = createRegistry();

export interface ChatProviderTarget {
  providerId: string;
  kind: Parameters<typeof registry.get>[0];
  baseUrl: string;
  apiKey: string;
  model: ModelDescriptor;
}

export interface StreamChatOptions {
  target: ChatProviderTarget;
  turns: ChatTurn[];
  system: string | null;
  params: GenerationParams;
  signal: AbortSignal;
  timeoutMs?: number;
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: ChatCompletionRequest extends never ? never : { promptTokens?: number }) => void;
}

export interface StreamChatResult {
  text: string;
  finishReason: string | null;
}

function runtimeFor(target: ChatProviderTarget, signal: AbortSignal, timeoutMs: number): ProviderRuntime {
  return {
    providerId: target.providerId,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    timeoutMs,
  };
}

/**
 * One streamed completion. Non-2xx responses are mapped through the adapter, so
 * the UI receives the same codes the desktop app uses (`invalid_key`,
 * `rate_limited`, …) instead of a generic failure.
 */
export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const adapter: ProviderAdapter = registry.get(options.target.kind);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const request: ChatCompletionRequest = {
    modelId: options.target.model.modelId,
    system: options.system,
    turns: options.turns,
    params: options.params,
    stream: true,
    baseUrlOverride: options.target.model.baseUrlOverride,
  };

  const runtime = runtimeFor(options.target, options.signal, timeoutMs);
  const spec = adapter.buildChatRequest(runtime, request);
  const { signal, dispose } = createRequestSignal(timeoutMs, options.signal);

  let text = '';
  let finishReason: string | null = null;
  const parser = adapter.createResponseParser(true);

  try {
    const response = await mobileFetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AppError(adapter.parseError(response.status, body, options.target.providerId));
    }

    const emit = (chunks: ChatStreamChunk[]): void => {
      for (const chunk of chunks) {
        if (chunk.type === 'text') {
          text += chunk.text;
          options.onText(chunk.text);
        } else if (chunk.type === 'reasoning') {
          options.onReasoning?.(chunk.text);
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason;
        }
      }
    };

    await readStream(response, (chunk) => emit(parser.push(chunk)), signal);
    emit(parser.end());
  } catch (error) {
    throw new AppError(toAppError(error, 'provider_error'));
  } finally {
    dispose();
  }

  return { text, finishReason };
}

export interface TranscribeOptions {
  target: ChatProviderTarget;
  fileUri: string;
  mimeType: string;
  fileName: string;
  signal?: AbortSignal;
}

/**
 * Transcription uses `FormData` with a file URI rather than a hand-built
 * multipart byte body: React Native's fetch cannot reliably send a `Uint8Array`
 * body, and `{ uri, name, type }` is the documented way to upload a file. The
 * endpoint, model id and response parsing still come from the copied adapter.
 */
export async function transcribeAudio(options: TranscribeOptions): Promise<string> {
  const adapter = registry.get(options.target.kind);
  const transcription = adapter.transcription;
  if (!transcription) {
    throw new AppError(
      appError('bad_request', `${adapter.label} cannot transcribe audio. Add an OpenAI key to transcribe.`),
    );
  }

  const form = new FormData();
  form.append('model', transcription.defaultModel);
  form.append('response_format', 'json');
  form.append('file', {
    uri: options.fileUri,
    name: options.fileName,
    type: options.mimeType,
  } as unknown as Blob);

  const { signal, dispose } = createRequestSignal(120_000, options.signal);
  try {
    const response = await mobileFetch(`${options.target.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.target.apiKey}` },
      body: form,
      signal,
    });
    const body = await response.text();
    const parsed = transcription.parseTranscriptionResponse(
      response.status,
      body,
      options.target.providerId,
    );
    if (parsed.error || parsed.text === null) {
      throw new AppError(parsed.error ?? errorForStatus(response.status, body, options.target.providerId));
    }
    return parsed.text;
  } catch (error) {
    throw new AppError(toAppError(error, 'provider_error'));
  } finally {
    dispose();
  }
}

/** Build the content parts for a turn that carries images. */
export function buildUserContent(
  text: string,
  images: ReadonlyArray<{ mimeType: string; dataBase64: string }>,
): string | ChatContentPart[] {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image' as const,
      mimeType: image.mimeType,
      dataBase64: image.dataBase64,
    })),
  ];
}
