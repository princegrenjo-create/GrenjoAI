/**
 * OpenAI adapter — Chat Completions.
 *
 * Same wire shape as DeepSeek, with two documented extras: `seed` and
 * `reasoning_effort`. Both are forwarded only when the caller supplied them
 * (the shared resolver has already decided the model supports them); top-k is
 * not part of this API, so it is never mapped onto another sampling parameter.
 */
import type { ProviderAdapter } from '@shared/provider-contract';
import { PROVIDER_PRESETS } from '@shared/defaults';
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
  };
}
