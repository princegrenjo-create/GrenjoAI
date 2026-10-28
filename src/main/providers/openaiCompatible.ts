/**
 * Generic OpenAI-compatible endpoint (self-hosted gateway, proxy, or a vendor
 * that exposes the Chat Completions shape).
 *
 * It may honour `top_k` and a provider-specific `weirdness` parameter, and the
 * shared resolver forwards those **only** when the selected model declares
 * support. This adapter therefore maps them when the caller supplied them, and
 * never strips them silently or renames them onto a different parameter.
 *
 * A model may carry its own `baseUrlOverride`; that override applies to chat
 * requests only. Discovery always uses the provider's configured base URL.
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

const OPENAI_COMPATIBLE_PROFILE: OpenAiFamilyProfile = {
  kind: 'openai-compatible',
  forwardSeed: true,
  forwardTopK: true,
  forwardWeirdness: true,
  forwardReasoningEffort: false,
  includeStreamOptions: true,
};

export function createOpenAiCompatibleAdapter(): ProviderAdapter {
  return {
    kind: 'openai-compatible',
    label: PROVIDER_PRESETS['openai-compatible'].label,
    supportedParams: PROVIDER_PRESETS['openai-compatible'].supportedParams,
    supportsModelDiscovery: PROVIDER_PRESETS['openai-compatible'].supportsModelDiscovery,
    buildTestRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    buildListModelsRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    parseListModels: (status, body) => parseOpenAiModels('openai-compatible', status, body),
    parseTestResponse: (status, body) => parseOpenAiTestResponse('openai-compatible', status, body),
    buildChatRequest: (runtime, request) => {
      const requested = request.baseUrlOverride;
      const baseUrl = requested !== null && requested !== undefined && requested.trim().length > 0
        ? requested
        : runtime.baseUrl;
      return buildOpenAiChatSpec(runtime, request, OPENAI_COMPATIBLE_PROFILE, baseUrl);
    },
    createResponseParser: (stream) =>
      stream ? createOpenAiStreamParser() : createOpenAiBufferedParser(),
    parseError: (status, body, providerId) => parseOpenAiError(status, body, providerId),
  };
}
