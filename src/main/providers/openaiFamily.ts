/**
 * The Chat Completions wire shape shared by DeepSeek, OpenAI and custom
 * OpenAI-compatible endpoints.
 *
 * These three providers genuinely share a schema, so the request builder, the
 * body parsers and the model-list parser live here once. What differs is a
 * short capability profile passed in by the adapter: which optional parameters
 * the provider documents, and therefore which values may be forwarded.
 *
 * Gemini and Anthropic are deliberately NOT expressed through this module: their
 * wire formats differ (native `contents` / `systemInstruction`, and the Messages
 * API with a top-level `system` and a required `max_tokens`). Flattening them
 * into an "OpenAI shape" helper is the mistake this split exists to prevent.
 */
import type {
  ChatCompletionRequest,
  ChatContentPart,
  ChatStreamChunk,
  DiscoveredModel,
  HttpRequestSpec,
  ProviderRuntime,
  ResponseParser,
} from '@shared/provider-contract';
import type {
  AppErrorShape,
  ConnectionTestResult,
  ProviderKind,
  TokenUsage,
} from '@shared/types';
import { appError, errorForStatus } from '@shared/errors';
import { joinUrl } from '@shared/url-policy';
import { assertApiKey, jsonHeaders, normalizeFinishReason } from './request';
import { inferCapabilities, capabilityNote, findModelHint } from './capabilities';
import {
  arrayAt,
  asRecord,
  createBufferedParser,
  firstRecord,
  numberAt,
  parseJson,
  recordAt,
  stringAt,
} from './json';
import { DONE_SENTINEL, SseFramer, type SseFrame } from './sse';

/** Which optional parameters a Chat Completions provider actually documents. */
export interface OpenAiFamilyProfile {
  kind: ProviderKind;
  forwardSeed: boolean;
  /** Maps `topK` to `top_k`. Only a compatible endpoint may claim it. */
  forwardTopK: boolean;
  /** Maps `weirdness` to `weirdness` verbatim. Never mapped onto another knob. */
  forwardWeirdness: boolean;
  /** Maps `reasoningEffort` to `reasoning_effort`. */
  forwardReasoningEffort: boolean;
  /** Ask for a trailing usage chunk while streaming. */
  includeStreamOptions: boolean;
}

const OPENAI_FINISH_REASONS: Readonly<Record<string, string>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
};

const CONTEXT_LENGTH_PATTERN =
  /context[_ ]length|maximum context|too many tokens|reduce the length|prompt is too long|input is too long/i;


/**
 * OpenAI chat messages. A text-only turn keeps the plain-string form, which is
 * what every stored conversation already contains; a turn with an image becomes
 * the content-part array the API documents.
 */
type OpenAiMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' } }
    >;

function toOpenAiContent(content: string | ChatContentPart[]): OpenAiMessageContent {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : {
          type: 'image_url' as const,
          image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}`, detail: 'auto' as const },
        },
  );
}

function buildMessages(
  request: ChatCompletionRequest,
): Array<{ role: string; content: OpenAiMessageContent }> {
  const messages: Array<{ role: string; content: OpenAiMessageContent }> = [];
  const system = request.system;
  if (system !== null && system.trim().length > 0) {
    messages.push({ role: 'system', content: system });
  }
  for (const turn of request.turns) {
    messages.push({ role: turn.role, content: toOpenAiContent(turn.content) });
  }
  return messages;
}

function toOpenAiBody(
  request: ChatCompletionRequest,
  profile: OpenAiFamilyProfile,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: buildMessages(request),
    stream: request.stream,
  };

  const params = request.params;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.maxOutputTokens !== undefined) body.max_tokens = params.maxOutputTokens;
  if (params.stop !== undefined && params.stop.length > 0) body.stop = [...params.stop];

  // Forwarded only when the caller supplied them AND this provider documents
  // them. A value the caller did not supply is never invented; a parameter the
  // provider does not document is never smuggled into a different field.
  if (profile.forwardSeed && params.seed !== undefined) body.seed = params.seed;
  if (profile.forwardTopK && params.topK !== undefined) body.top_k = params.topK;
  if (profile.forwardWeirdness && params.weirdness !== undefined) body.weirdness = params.weirdness;
  if (profile.forwardReasoningEffort && params.reasoningEffort !== undefined) {
    body.reasoning_effort = params.reasoningEffort;
  }

  if (request.stream && profile.includeStreamOptions) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

export function buildOpenAiChatSpec(
  runtime: ProviderRuntime,
  request: ChatCompletionRequest,
  profile: OpenAiFamilyProfile,
  baseUrl: string = runtime.baseUrl,
): HttpRequestSpec {
  const key = assertApiKey(runtime);
  return {
    url: joinUrl(baseUrl, 'chat/completions'),
    method: 'POST',
    headers: { ...jsonHeaders(), Authorization: `Bearer ${key}` },
    body: JSON.stringify(toOpenAiBody(request, profile)),
  };
}

export function buildOpenAiModelsRequest(runtime: ProviderRuntime, baseUrl: string = runtime.baseUrl): HttpRequestSpec {
  const key = assertApiKey(runtime);
  return {
    url: joinUrl(baseUrl, 'models'),
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    body: null,
  };
}

export function readOpenAiUsage(record: Record<string, unknown> | null): TokenUsage {
  const usage: TokenUsage = {};
  const prompt = numberAt(record, 'prompt_tokens');
  if (prompt !== null) usage.promptTokens = prompt;
  const completion = numberAt(record, 'completion_tokens');
  if (completion !== null) usage.completionTokens = completion;
  const total = numberAt(record, 'total_tokens');
  if (total !== null) usage.totalTokens = total;
  return usage;
}

/** Convert OpenAI-style JSON payloads (streamed or whole) into chunks. */
function toOpenAiChunks(payload: Record<string, unknown>): ChatStreamChunk[] {
  const chunks: ChatStreamChunk[] = [];

  const usageRecord = recordAt(payload, 'usage');
  if (usageRecord) chunks.push({ type: 'usage', usage: readOpenAiUsage(usageRecord) });

  const choice = firstRecord(arrayAt(payload, 'choices'));
  if (!choice) return chunks;

  const delta = recordAt(choice, 'delta');
  const message = recordAt(choice, 'message');
  const carrier = delta ?? message;

  if (carrier) {
    const content = carrier['content'];
    if (typeof content === 'string') {
      if (content.length > 0) chunks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      // Some compatible gateways return the content as typed parts.
      for (const part of content) {
        const text = stringAt(asRecord(part), 'text');
        if (text !== null && text.length > 0) chunks.push({ type: 'text', text });
      }
    }
    const reasoning = stringAt(carrier, 'reasoning_content') ?? stringAt(carrier, 'reasoning');
    if (reasoning !== null && reasoning.length > 0) chunks.push({ type: 'reasoning', text: reasoning });
  }

  const finish = stringAt(choice, 'finish_reason');
  if (finish !== null) chunks.push({ type: 'finish', reason: normalizeFinishReason(finish, OPENAI_FINISH_REASONS) ?? 'stop' });

  return chunks;
}

/**
 * Incremental parser for an OpenAI-style SSE stream.
 *
 * Emits text / reasoning / usage / finish chunks and stops at `[DONE]`. A frame
 * that is not JSON (a keep-alive comment already filtered by the framer, or a
 * truncated payload) is skipped without throwing: a broken frame must not take
 * the rest of the answer down with it.
 */
export function createOpenAiStreamParser(): ResponseParser {
  const framer = new SseFramer();
  let done = false;
  let sawFinish = false;

  function consume(frames: SseFrame[]): ChatStreamChunk[] {
    const chunks: ChatStreamChunk[] = [];
    for (const frame of frames) {
      if (done) break;
      if (frame.data === DONE_SENTINEL) {
        done = true;
        if (!sawFinish) {
          chunks.push({ type: 'finish', reason: 'stop' });
          sawFinish = true;
        }
        break;
      }
      const payload = asRecord(parseJson(frame.data));
      if (!payload) continue;
      if (recordAt(payload, 'error')) {
        // HTTP 200 with an error object: a failed request, not a reply. The
        // transport turns this finish marker into a thrown provider_error after
        // the chunks already parsed from this same read have been delivered.
        chunks.push({ type: 'finish', reason: 'error' });
        sawFinish = true;
        done = true;
        break;
      }
      for (const chunk of toOpenAiChunks(payload)) {
        if (chunk.type === 'finish') sawFinish = true;
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  return {
    push(chunk: string): ChatStreamChunk[] {
      if (done) return [];
      return consume(framer.push(chunk));
    },
    end(): ChatStreamChunk[] {
      if (done) return [];
      return consume(framer.end());
    },
  };
}

/** Parser for a buffered (non-streaming) Chat Completions response. */
export function createOpenAiBufferedParser(): ResponseParser {
  return createBufferedParser((body) => {
    const payload = asRecord(parseJson(body));
    if (!payload) return [];
    if (recordAt(payload, 'error')) return [{ type: 'finish', reason: 'error' }];
    return toOpenAiChunks(payload);
  });
}

export function parseOpenAiError(status: number, body: string, providerId: string): AppErrorShape {
  const payload = asRecord(parseJson(body));
  const errorRecord = recordAt(payload, 'error');
  const message =
    stringAt(errorRecord, 'message') ?? stringAt(payload, 'message') ?? firstLine(body);
  const code = stringAt(errorRecord, 'code') ?? stringAt(errorRecord, 'type') ?? '';
  const haystack = `${message ?? ''} ${code}`;

  // OpenAI reports an over-long conversation as a 400 with
  // `context_length_exceeded`. Only a client-error status is reclassified: a 5xx
  // that happens to mention context is still a provider failure.
  if (
    (status === 400 || status === 413 || status === 422) &&
    CONTEXT_LENGTH_PATTERN.test(haystack)
  ) {
    const detail = message ? ` — ${message}` : '';
    return appError(
      'context_length',
      `The conversation is longer than the model’s context window (HTTP ${status})${detail}`,
      { providerId, status },
    );
  }

  return errorForStatus(status, message, providerId);
}

function firstLine(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 300);
}

export interface ModelListResult {
  models: DiscoveredModel[];
  error: AppErrorShape | null;
}

/** Parse `{ data: [{ id, display_name? , description? }] }`. */
export function parseOpenAiModels(kind: ProviderKind, status: number, body: string): ModelListResult {
  if (status < 200 || status >= 300) {
    return { models: [], error: parseOpenAiError(status, body, '') };
  }

  const payload = asRecord(parseJson(body));
  if (!payload) {
    return {
      models: [],
      error: appError('provider_error', 'The provider returned a model list that could not be parsed.', {
        status,
      }),
    };
  }

  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const entry of arrayAt(payload, 'data')) {
    const record = asRecord(entry);
    const modelId = stringAt(record, 'id');
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);

    const hint = findModelHint(kind, modelId);
    const profile = inferCapabilities(kind, modelId, hint);
    const description =
      stringAt(record, 'description') ?? hint?.description ?? 'Discovered from the provider’s model list.';
    models.push({
      modelId,
      displayName: stringAt(record, 'display_name') ?? hint?.displayName ?? modelId,
      description: `${description} ${capabilityNote(profile)}`,
      capabilities: profile.capabilities,
      limits: profile.limits,
      supportedParams: profile.supportedParams,
      weirdnessSupported: profile.weirdnessSupported,
    });
  }

  return { models, error: null };
}

export function parseOpenAiTestResponse(
  kind: ProviderKind,
  status: number,
  body: string,
): ConnectionTestResult {
  const { models, error } = parseOpenAiModels(kind, status, body);
  if (error) {
    return { ok: false, latencyMs: null, message: error.message, modelsFound: null, error };
  }
  const message =
    models.length > 0
      ? `Connected. The provider listed ${models.length} chat model${models.length === 1 ? '' : 's'}.`
      : 'Connected, but the provider listed no chat models.';
  return { ok: true, latencyMs: null, message, modelsFound: models.length, error: null };
}
