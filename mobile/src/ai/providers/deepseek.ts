/**
 * DeepSeek adapter — DeepSeek's documented OpenAI-compatible Chat Completions
 * surface.
 *
 * DeepSeek documents temperature, top-p, frequency/presence penalty, a max-token
 * limit and stop sequences; it does not document top-k, seed or reasoning
 * effort. Those values are therefore not forwarded even when a caller sets them:
 * the shared resolver strips them first, and this adapter does not invent a
 * mapping for them.
 */
import type { ProviderAdapter } from '@core/provider-contract';
import { PROVIDER_PRESETS } from '@core/defaults';
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

const DEEPSEEK_PROFILE: OpenAiFamilyProfile = {
  kind: 'deepseek',
  forwardSeed: false,
  forwardTopK: false,
  forwardWeirdness: false,
  forwardReasoningEffort: false,
  includeStreamOptions: true,
};

export function createDeepSeekAdapter(): ProviderAdapter {
  return {
    kind: 'deepseek',
    label: PROVIDER_PRESETS.deepseek.label,
    supportedParams: PROVIDER_PRESETS.deepseek.supportedParams,
    supportsModelDiscovery: PROVIDER_PRESETS.deepseek.supportsModelDiscovery,
    buildTestRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    buildListModelsRequest: (runtime) => buildOpenAiModelsRequest(runtime),
    parseListModels: (status, body) => parseOpenAiModels('deepseek', status, body),
    parseTestResponse: (status, body) => parseOpenAiTestResponse('deepseek', status, body),
    buildChatRequest: (runtime, request) => buildOpenAiChatSpec(runtime, request, DEEPSEEK_PROFILE),
    createResponseParser: (stream) =>
      stream ? createOpenAiStreamParser() : createOpenAiBufferedParser(),
    parseError: (status, body, providerId) => parseOpenAiError(status, body, providerId),
  };
}
