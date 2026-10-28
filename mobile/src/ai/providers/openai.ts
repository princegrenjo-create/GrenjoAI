/**
 * OpenAI adapter — Chat Completions.
 *
 * Same wire shape as DeepSeek, with two documented extras: `seed` and
 * `reasoning_effort`. Both are forwarded only when the caller supplied them
 * (the shared resolver has already decided the model supports them); top-k is
 * not part of this API, so it is never mapped onto another sampling parameter.
 */
import type {
  HttpRequestSpec,
  ProviderAdapter,
  ProviderRuntime,
  TranscriptionAdapter,
  TranscriptionParseResult,
  TranscriptionRequest,
} from '@core/provider-contract';
import { appError } from '@core/errors';
import { joinUrl } from '@core/url-policy';
import { PROVIDER_PRESETS } from '@core/defaults';
import { buildMultipartBody } from './multipart';
import {
  buildOpenAiChatSpec,
  buildOpenAiModelsRequest,
  createOpenAiBufferedParser,
  createOpenAiStreamParser,
  parseOpenAiError,
  parseOpenAiModels,
  parseOpenAiTestResponse,
  type OpenAiFamilyProfile,
} from './openaiFamily';

/**
 * OpenAI is the only provider in this release with a documented transcription
 * endpoint, so this is the only adapter that implements `transcription`. Its
 * absence on every other provider is what the UI reports when no OpenAI key is
 * configured — never a fabricated transcript.
 */
const OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';

function buildOpenAiTranscriptionRequest(
  runtime: ProviderRuntime,
  request: TranscriptionRequest,
): HttpRequestSpec {
  const key = runtime.apiKey.trim();
  if (key.length === 0) {
    throw new Error('missing_key');
  }
  const body = buildMultipartBody(
    {
      field: 'file',
      filename: request.filename,
      contentType: request.mimeType,
      data: request.audio,
    },
    [
      { field: 'model', value: request.model || OPENAI_TRANSCRIPTION_MODEL },
      { field: 'response_format', value: 'json' },
    ],
  );
  return {
    url: joinUrl(runtime.baseUrl, 'audio/transcriptions'),
    method: 'POST',
    headers: {
      // The key is in the header only, never in the URL or the body.
      Authorization: `Bearer ${key}`,
      'Content-Type': body.contentType,
    },
    body: null,
    bodyBytes: body.bytes,
  };
}

function parseOpenAiTranscription(
  status: number,
  body: string,
  providerId: string,
): TranscriptionParseResult {
  if (status < 200 || status >= 300) {
    return { text: null, error: parseOpenAiError(status, body, providerId) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      text: null,
      error: appError('provider_error', 'The transcription response was not valid JSON.', {
        providerId,
        status,
      }),
    };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('text' in parsed) ||
    typeof (parsed as { text: unknown }).text !== 'string'
  ) {
    return {
      text: null,
      error: appError('provider_error', 'The transcription response contained no text.', {
        providerId,
        status,
      }),
    };
  }
  const text = (parsed as { text: string }).text.trim();
  if (text.length === 0) {
    return {
      text: null,
      error: appError(
        'provider_error',
        'The transcription came back empty — the recording may contain no speech.',
        { providerId, status },
      ),
    };
  }
  return { text, error: null };
}

const OPENAI_TRANSCRIPTION: TranscriptionAdapter = {
  defaultModel: OPENAI_TRANSCRIPTION_MODEL,
  buildTranscriptionRequest: buildOpenAiTranscriptionRequest,
  parseTranscriptionResponse: parseOpenAiTranscription,
};

const OPENAI_PROFILE: OpenAiFamilyProfile = {
  kind: 'openai',
  forwardSeed: true,
  forwardTopK: false,
  forwardWeirdness: false,
  forwardReasoningEffort: true,
  includeStreamOptions: true,
};

export function createOpenAiAdapter(): ProviderAdapter {
  return {
    kind: 'openai',
    label: PROVIDER_PRESETS.openai.label,
    supportedParams: PROVIDER_PRESETS.openai.supportedParams,
    supportsModelDiscovery: PROVIDER_PRESETS.openai.supportsModelDiscovery,
    buildTestRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    buildListModelsRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    parseListModels: (status, body) => parseOpenAiModels('openai', status, body),
    parseTestResponse: (status, body) => parseOpenAiTestResponse('openai', status, body),
    buildChatRequest: (runtime, request) => buildOpenAiChatSpec(runtime, request, OPENAI_PROFILE),
    createResponseParser: (stream) =>
      stream ? createOpenAiStreamParser() : createOpenAiBufferedParser(),
    parseError: (status, body, providerId) => parseOpenAiError(status, body, providerId),
    transcription: OPENAI_TRANSCRIPTION,
  };
}
