/**
 * Google Gemini adapter — the native REST shape, not the OpenAI schema.
 *
 * Differences that must not be flattened into a shared helper:
 *  - endpoint paths are `models/{id}:generateContent` and
 *    `models/{id}:streamGenerateContent?alt=sse`;
 *  - the credential travels in `x-goog-api-key`, never in a `?key=` query
 *    string, so it cannot end up in a URL that is logged or shown;
 *  - the system prompt is `systemInstruction`, and the assistant role is
 *    `model` rather than `assistant`;
 *  - generation parameters live under `generationConfig`, renamed
 *    (`topP`, `topK`, `maxOutputTokens`, `stopSequences`);
 *  - responses are `candidates[0].content.parts[].text` with
 *    `usageMetadata` token counts.
 */
import type {
  ChatCompletionRequest,
  ChatStreamChunk,
  DiscoveredModel,
  HttpRequestSpec,
  ProviderAdapter,
  ProviderRuntime,
  ResponseParser,
} from '@shared/provider-contract';
import type { AppErrorShape, ConnectionTestResult, TokenUsage } from '@shared/types';
import { appError, errorForStatus } from '@shared/errors';
import { joinUrl } from '@shared/url-policy';
import { PROVIDER_PRESETS } from '@shared/defaults';
import { assertApiKey, jsonHeaders, normalizeFinishReason } from './request';
import { capabilityNote, findModelHint, inferCapabilities } from './capabilities';
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

const GEMINI_FINISH_REASONS: Readonly<Record<string, string>> = {
  stop: 'stop',
  max_tokens: 'length',
  safety: 'content_filter',
  recitation: 'content_filter',
  blocklist: 'content_filter',
  prohibited_content: 'content_filter',
  spii: 'content_filter',
  malformed_function_call: 'error',
  other: 'error',
};

/** Percent-encode each path segment of the model id, preserving slashes. */
function encodeModelPath(modelId: string): string {
  return modelId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function geminiHeaders(key: string): Record<string, string> {
  return { ...jsonHeaders(), 'x-goog-api-key': key };
}

function toGeminiContents(
  turns: ChatCompletionRequest['turns'],
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  return turns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
}

function toGeminiBody(request: ChatCompletionRequest): Record<string, unknown> {
  const contents = toGeminiContents(request.turns);
  const body: Record<string, unknown> = { contents };

  const system = request.system;
  if (system !== null && system.trim().length > 0) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const params = request.params;
  const config: Record<string, unknown> = {};
  if (params.temperature !== undefined) config.temperature = params.temperature;
  if (params.topP !== undefined) config.topP = params.topP;
  if (params.topK !== undefined) config.topK = params.topK;
  if (params.maxOutputTokens !== undefined) config.maxOutputTokens = params.maxOutputTokens;
  if (params.stop !== undefined && params.stop.length > 0) config.stopSequences = [...params.stop];
  if (params.seed !== undefined) config.seed = params.seed;
  if (Object.keys(config).length > 0) body.generationConfig = config;

  return body;
}

export function buildGeminiChatRequest(
  runtime: ProviderRuntime,
  request: ChatCompletionRequest,
): HttpRequestSpec {
  const key = assertApiKey(runtime);
  const suffix = request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return {
    url: joinUrl(runtime.baseUrl, `models/${encodeModelPath(request.modelId)}:${suffix}`),
    method: 'POST',
    headers: geminiHeaders(key),
    body: JSON.stringify(toGeminiBody(request)),
  };
}

export function buildGeminiListModelsRequest(runtime: ProviderRuntime): HttpRequestSpec {
  const key = assertApiKey(runtime);
  return {
    url: joinUrl(runtime.baseUrl, 'models'),
    method: 'GET',
    headers: { 'x-goog-api-key': key },
    body: null,
  };
}

function readGeminiUsage(record: Record<string, unknown> | null): TokenUsage {
  const usage: TokenUsage = {};
  const prompt = numberAt(record, 'promptTokenCount');
  if (prompt !== null) usage.promptTokens = prompt;
  const completion = numberAt(record, 'candidatesTokenCount');
  if (completion !== null) usage.completionTokens = completion;
  const total = numberAt(record, 'totalTokenCount');
  if (total !== null) usage.totalTokens = total;
  return usage;
}

/** Convert one Gemini payload (streamed chunk or whole body) into chunks. */
function toGeminiChunks(payload: Record<string, unknown>): ChatStreamChunk[] {
  const chunks: ChatStreamChunk[] = [];

  const usageRecord = recordAt(payload, 'usageMetadata');
  if (usageRecord) {
    const usage = readGeminiUsage(usageRecord);
    if (Object.keys(usage).length > 0) chunks.push({ type: 'usage', usage });
  }

  const candidate = firstRecord(arrayAt(payload, 'candidates'));
  if (candidate) {
    const content = recordAt(candidate, 'content');
    for (const part of arrayAt(content, 'parts')) {
      const partRecord = asRecord(part);
      const text = stringAt(partRecord, 'text');
      if (text === null || text.length === 0) continue;
      // Thinking models return their trace as a part flagged `thought: true`.
      const isThought = partRecord?.['thought'] === true;
      chunks.push(isThought ? { type: 'reasoning', text } : { type: 'text', text });
    }

    const finish = stringAt(candidate, 'finishReason');
    if (finish !== null) {
      chunks.push({ type: 'finish', reason: normalizeFinishReason(finish, GEMINI_FINISH_REASONS) ?? 'stop' });
    }
  }

  const feedback = recordAt(payload, 'promptFeedback');
  if (feedback && stringAt(feedback, 'blockReason') !== null) {
    chunks.push({ type: 'finish', reason: 'content_filter' });
  }

  return chunks;
}

export function createGeminiStreamParser(): ResponseParser {
  const framer = new SseFramer();
  let done = false;

  function consume(frames: SseFrame[]): ChatStreamChunk[] {
    const chunks: ChatStreamChunk[] = [];
    for (const frame of frames) {
      if (done) break;
      if (frame.data === DONE_SENTINEL) {
        done = true;
        break;
      }
      const payload = asRecord(parseJson(frame.data));
      if (!payload) continue;
      if (recordAt(payload, 'error')) {
        // HTTP 200 with an error object: the transport turns this finish marker
        // into a thrown provider_error after delivering the parsed chunks.
        chunks.push({ type: 'finish', reason: 'error' });
        done = true;
        break;
      }
      chunks.push(...toGeminiChunks(payload));
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

export function createGeminiBufferedParser(): ResponseParser {
  return createBufferedParser((body) => {
    const payload = asRecord(parseJson(body));
    if (!payload) return [];
    if (recordAt(payload, 'error')) return [{ type: 'finish', reason: 'error' }];
    return toGeminiChunks(payload);
  });
}

export function parseGeminiError(status: number, body: string, providerId: string): AppErrorShape {
  const payload = asRecord(parseJson(body));
  const errorRecord = recordAt(payload, 'error');
  const message = stringAt(errorRecord, 'message') ?? stringAt(payload, 'message');
  const statusText = stringAt(errorRecord, 'status') ?? '';
  const details = arrayAt(errorRecord, 'details');
  const detailText = JSON.stringify(details).slice(0, 500);
  const haystack = `${message ?? ''} ${statusText} ${detailText}`.toLowerCase();

  // Gemini reports an invalid key as HTTP 400 with `API_KEY_INVALID`, not 401.
  if (/api_key_invalid|api key not valid|invalid api key|api key expired/.test(haystack)) {
    return appError(
      'invalid_key',
      `The provider rejected the API key (HTTP ${status})${message ? ` — ${message}` : ''}`,
      { providerId, status, retryable: false },
    );
  }
  if (
    (status === 400 || status === 413) &&
    /context|token count exceeds|too long|exceeds the maximum/.test(haystack)
  ) {
    return appError(
      'context_length',
      `The conversation is longer than the model’s context window (HTTP ${status})${message ? ` — ${message}` : ''}`,
      { providerId, status },
    );
  }

  return errorForStatus(status, message, providerId);
}

function readStringArray(values: unknown[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') strings.push(value);
  }
  return strings;
}

export function parseGeminiModels(
  status: number,
  body: string,
): { models: DiscoveredModel[]; error: AppErrorShape | null } {
  if (status < 200 || status >= 300) {
    return { models: [], error: parseGeminiError(status, body, '') };
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

  for (const entry of arrayAt(payload, 'models')) {
    const record = asRecord(entry);
    const name = stringAt(record, 'name');
    if (!name) continue;

    const methods = readStringArray(arrayAt(record, 'supportedGenerationMethods'));
    // Only models that can actually answer a chat request belong in the picker.
    if (methods.length > 0 && !methods.includes('generateContent')) continue;

    const modelId = name.startsWith('models/') ? name.slice('models/'.length) : name;
    if (modelId.length === 0 || seen.has(modelId)) continue;
    seen.add(modelId);

    const hint = findModelHint('gemini', modelId);
    const profile = inferCapabilities('gemini', modelId, hint);
    const limits = { ...profile.limits };
    const contextWindow = numberAt(record, 'inputTokenLimit');
    if (contextWindow !== null) limits.contextWindow = contextWindow;
    const maxOutputTokens = numberAt(record, 'outputTokenLimit');
    if (maxOutputTokens !== null) limits.maxOutputTokens = maxOutputTokens;

    const description =
      stringAt(record, 'description') ?? hint?.description ?? 'Discovered from the provider’s model list.';
    models.push({
      modelId,
      displayName: stringAt(record, 'displayName') ?? hint?.displayName ?? modelId,
      description: `${description} ${capabilityNote(profile)}`,
      capabilities: profile.capabilities,
      limits,
      supportedParams: profile.supportedParams,
      weirdnessSupported: profile.weirdnessSupported,
    });
  }

  return { models, error: null };
}

export function parseGeminiTestResponse(status: number, body: string): ConnectionTestResult {
  const { models, error } = parseGeminiModels(status, body);
  if (error) {
    return { ok: false, latencyMs: null, message: error.message, modelsFound: null, error };
  }
  const message =
    models.length > 0
      ? `Connected. The provider listed ${models.length} chat model${models.length === 1 ? '' : 's'}.`
      : 'Connected, but the provider listed no chat models.';
  return { ok: true, latencyMs: null, message, modelsFound: models.length, error: null };
}

export function createGeminiAdapter(): ProviderAdapter {
  return {
    kind: 'gemini',
    label: PROVIDER_PRESETS.gemini.label,
    supportedParams: PROVIDER_PRESETS.gemini.supportedParams,
    supportsModelDiscovery: PROVIDER_PRESETS.gemini.supportsModelDiscovery,
    buildTestRequest: (runtime) => buildGeminiListModelsRequest(runtime),
    buildListModelsRequest: (runtime) => buildGeminiListModelsRequest(runtime),
    parseListModels: (status, body) => parseGeminiModels(status, body),
    parseTestResponse: (status, body) => parseGeminiTestResponse(status, body),
    buildChatRequest: (runtime, request) => buildGeminiChatRequest(runtime, request),
    createResponseParser: (stream) =>
      stream ? createGeminiStreamParser() : createGeminiBufferedParser(),
    parseError: (status, body, providerId) => parseGeminiError(status, body, providerId),
  };
}
