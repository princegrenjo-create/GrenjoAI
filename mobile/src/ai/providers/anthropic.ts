/**
 * Anthropic adapter — the Messages API, which is not the OpenAI schema.
 *
 * Differences that must not be flattened:
 *  - the credential is `x-api-key`, and `anthropic-version` is mandatory;
 *  - `max_tokens` is REQUIRED, so a caller that supplied no limit still gets one
 *    (the app's documented default), never an omitted field;
 *  - the system prompt is a top-level `system` string, not a message;
 *  - stop sequences are `stop_sequences`, top-k is `top_k`;
 *  - responses are typed `content` blocks, and streaming arrives as named SSE
 *    events (`message_start`, `content_block_delta`, `message_delta`,
 *    `message_stop`) rather than OpenAI `choices[].delta` frames.
 */
import type {
  ChatCompletionRequest,
  ChatStreamChunk,
  DiscoveredModel,
  HttpRequestSpec,
  ProviderAdapter,
  ProviderRuntime,
  ResponseParser,
} from '@core/provider-contract';
import type { AppErrorShape, ConnectionTestResult, TokenUsage } from '@core/types';
import { appError, errorForStatus } from '@core/errors';
import { joinUrl } from '@core/url-policy';
import { PROVIDER_PRESETS } from '@core/defaults';
import { assertApiKey, jsonHeaders, normalizeFinishReason } from './request';
import { capabilityNote, findModelHint, inferCapabilities } from './capabilities';
import {
  arrayAt,
  asRecord,
  createBufferedParser,
  parseJson,
  numberAt,
  recordAt,
  stringAt,
} from './json';
import { SseFramer, type SseFrame } from './sse';

/** The only version this adapter claims to speak. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Anthropic requires `max_tokens`; matches PARAM_SPECS.maxOutputTokens.defaultValue. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 2048;

const ANTHROPIC_FINISH_REASONS: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

const CONTEXT_LENGTH_PATTERN = /prompt is too long|too many input tokens|context window|input is too long/i;

function anthropicHeaders(key: string): Record<string, string> {
  return { ...jsonHeaders(), 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION };
}

function toAnthropicBody(request: ChatCompletionRequest): Record<string, unknown> {
  const params = request.params;

  // The Messages API takes typed content blocks. A text-only turn stays a plain
  // string (the shape every existing conversation stores); an image turn becomes
  // a `text` block plus an `image` block with base64 source.
  const messages = request.turns.map((turn) => ({
    role: turn.role,
    content:
      typeof turn.content === 'string'
        ? turn.content
        : turn.content.map((part) =>
            part.type === 'text'
              ? { type: 'text' as const, text: part.text }
              : {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: part.mimeType,
                    data: part.dataBase64,
                  },
                },
          ),
  }));

  const body: Record<string, unknown> = {
    model: request.modelId,
    // Required by the API. Only falls back when the caller supplied no limit.
    max_tokens: params.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
    stream: request.stream,
  };

  const system = request.system;
  if (system !== null && system.trim().length > 0) body.system = system;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.topK !== undefined) body.top_k = params.topK;
  if (params.stop !== undefined && params.stop.length > 0) body.stop_sequences = [...params.stop];

  return body;
}

export function buildAnthropicChatRequest(
  runtime: ProviderRuntime,
  request: ChatCompletionRequest,
): HttpRequestSpec {
  const key = assertApiKey(runtime);
  return {
    url: joinUrl(runtime.baseUrl, 'messages'),
    method: 'POST',
    headers: anthropicHeaders(key),
    body: JSON.stringify(toAnthropicBody(request)),
  };
}

export function buildAnthropicListModelsRequest(runtime: ProviderRuntime): HttpRequestSpec {
  const key = assertApiKey(runtime);
  return {
    url: joinUrl(runtime.baseUrl, 'models'),
    method: 'GET',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION },
    body: null,
  };
}

function readAnthropicUsage(record: Record<string, unknown> | null): TokenUsage {
  // Anthropic reports input and output tokens, not a total. A computed total
  // would go stale as soon as a later event updates the output count, so the
  // adapter reports only what the provider said.
  const usage: TokenUsage = {};
  const input = numberAt(record, 'input_tokens');
  if (input !== null) usage.promptTokens = input;
  const output = numberAt(record, 'output_tokens');
  if (output !== null) usage.completionTokens = output;
  return usage;
}

function textFromContentBlocks(payload: Record<string, unknown>): ChatStreamChunk[] {
  const chunks: ChatStreamChunk[] = [];
  for (const block of arrayAt(payload, 'content')) {
    const record = asRecord(block);
    const type = stringAt(record, 'type');
    if (type === 'text') {
      const text = stringAt(record, 'text');
      if (text !== null && text.length > 0) chunks.push({ type: 'text', text });
    } else if (type === 'thinking') {
      const thinking = stringAt(record, 'thinking');
      if (thinking !== null && thinking.length > 0) chunks.push({ type: 'reasoning', text: thinking });
    }
  }

  const stopReason = stringAt(payload, 'stop_reason');
  if (stopReason !== null) {
    chunks.push({
      type: 'finish',
      reason: normalizeFinishReason(stopReason, ANTHROPIC_FINISH_REASONS) ?? 'stop',
    });
  }

  const usageRecord = recordAt(payload, 'usage');
  if (usageRecord) {
    const usage = readAnthropicUsage(usageRecord);
    if (Object.keys(usage).length > 0) chunks.push({ type: 'usage', usage });
  }

  return chunks;
}

/** Convert one named Anthropic stream event into chunks. */
function toAnthropicChunks(payload: Record<string, unknown>): ChatStreamChunk[] {
  const type = stringAt(payload, 'type');
  const chunks: ChatStreamChunk[] = [];

  switch (type) {
    case 'message_start': {
      const usageRecord = recordAt(recordAt(payload, 'message'), 'usage');
      if (usageRecord) {
        const usage = readAnthropicUsage(usageRecord);
        if (Object.keys(usage).length > 0) chunks.push({ type: 'usage', usage });
      }
      break;
    }
    case 'content_block_delta': {
      const delta = recordAt(payload, 'delta');
      const deltaType = stringAt(delta, 'type');
      if (deltaType === 'thinking_delta') {
        const thinking = stringAt(delta, 'thinking');
        if (thinking !== null && thinking.length > 0) chunks.push({ type: 'reasoning', text: thinking });
      } else {
        const text = stringAt(delta, 'text');
        if (text !== null && text.length > 0) chunks.push({ type: 'text', text });
      }
      break;
    }
    case 'message_delta': {
      const usageRecord = recordAt(payload, 'usage');
      if (usageRecord) {
        const usage = readAnthropicUsage(usageRecord);
        if (Object.keys(usage).length > 0) chunks.push({ type: 'usage', usage });
      }
      const stopReason = stringAt(recordAt(payload, 'delta'), 'stop_reason');
      if (stopReason !== null) {
        chunks.push({
          type: 'finish',
          reason: normalizeFinishReason(stopReason, ANTHROPIC_FINISH_REASONS) ?? 'stop',
        });
      }
      break;
    }
    default:
      // `ping`, `content_block_start`, `content_block_stop` carry no text.
      break;
  }

  return chunks;
}

export function createAnthropicStreamParser(): ResponseParser {
  const framer = new SseFramer();
  let done = false;
  let sawFinish = false;

  function consume(frames: SseFrame[]): ChatStreamChunk[] {
    const chunks: ChatStreamChunk[] = [];
    for (const frame of frames) {
      if (done) break;
      const payload = asRecord(parseJson(frame.data));
      if (!payload) continue;

      if (stringAt(payload, 'type') === 'error') {
        // HTTP 200 with an `error` event: the transport turns this finish marker
        // into a thrown provider_error after delivering the parsed chunks.
        chunks.push({ type: 'finish', reason: 'error' });
        sawFinish = true;
        done = true;
        break;
      }

      for (const chunk of toAnthropicChunks(payload)) {
        if (chunk.type === 'finish') sawFinish = true;
        chunks.push(chunk);
      }

      if (stringAt(payload, 'type') === 'message_stop') {
        done = true;
        if (!sawFinish) {
          chunks.push({ type: 'finish', reason: 'stop' });
          sawFinish = true;
        }
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

export function createAnthropicBufferedParser(): ResponseParser {
  return createBufferedParser((body) => {
    const payload = asRecord(parseJson(body));
    if (!payload) return [];
    if (recordAt(payload, 'error')) return [{ type: 'finish', reason: 'error' }];
    return textFromContentBlocks(payload);
  });
}

export function parseAnthropicError(status: number, body: string, providerId: string): AppErrorShape {
  const payload = asRecord(parseJson(body));
  const errorRecord = recordAt(payload, 'error');
  const message = stringAt(errorRecord, 'message') ?? stringAt(payload, 'message');
  const errorType = stringAt(errorRecord, 'type') ?? '';

  if (
    (status === 400 || status === 413 || status === 422) &&
    CONTEXT_LENGTH_PATTERN.test(`${message ?? ''} ${errorType}`)
  ) {
    return appError(
      'context_length',
      `The conversation is longer than the model’s context window (HTTP ${status})${message ? ` — ${message}` : ''}`,
      { providerId, status },
    );
  }

  return errorForStatus(status, message, providerId);
}

export function parseAnthropicModels(
  status: number,
  body: string,
): { models: DiscoveredModel[]; error: AppErrorShape | null } {
  if (status < 200 || status >= 300) {
    return { models: [], error: parseAnthropicError(status, body, '') };
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

    const hint = findModelHint('anthropic', modelId);
    const profile = inferCapabilities('anthropic', modelId, hint);
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

export function parseAnthropicTestResponse(status: number, body: string): ConnectionTestResult {
  const { models, error } = parseAnthropicModels(status, body);
  if (error) {
    return { ok: false, latencyMs: null, message: error.message, modelsFound: null, error };
  }
  const message =
    models.length > 0
      ? `Connected. The provider listed ${models.length} model${models.length === 1 ? '' : 's'}.`
      : 'Connected, but the provider listed no models.';
  return { ok: true, latencyMs: null, message, modelsFound: models.length, error: null };
}

export function createAnthropicAdapter(): ProviderAdapter {
  return {
    kind: 'anthropic',
    label: PROVIDER_PRESETS.anthropic.label,
    supportedParams: PROVIDER_PRESETS.anthropic.supportedParams,
    supportsModelDiscovery: PROVIDER_PRESETS.anthropic.supportsModelDiscovery,
    buildTestRequest: (runtime) => buildAnthropicListModelsRequest(runtime),
    buildListModelsRequest: (runtime) => buildAnthropicListModelsRequest(runtime),
    parseListModels: (status, body) => parseAnthropicModels(status, body),
    parseTestResponse: (status, body) => parseAnthropicTestResponse(status, body),
    buildChatRequest: (runtime, request) => buildAnthropicChatRequest(runtime, request),
    createResponseParser: (stream) =>
      stream ? createAnthropicStreamParser() : createAnthropicBufferedParser(),
    parseError: (status, body, providerId) => parseAnthropicError(status, body, providerId),
  };
}
