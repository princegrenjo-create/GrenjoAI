/**
 * Black Forest Labs, as a *media-only* provider.
 *
 * BFL documents image and video generation APIs and no chat completion API, so this
 * adapter exists only to satisfy the provider registry's shape: a provider that can
 * be configured, hold a key, be listed and be error-mapped like any other.
 *
 * The chat surface is a deliberate guard rail, not an implementation:
 *  - `buildChatRequest` and `buildTestRequest` throw with a sentence that explains
 *    the provider has no chat endpoint;
 *  - nothing can reach them in the running app, because a model is only offered for
 *    chat when its capabilities declare `chat`, and no BFL model declares it. A test
 *    asserts that gate rather than trusting the comment.
 *
 * If a future BFL endpoint is documented, it belongs in a real adapter, not here.
 */
import { AppError, appError } from '@shared/errors';
import type { AppErrorShape, ConnectionTestResult, GenParamKey, ProviderKind } from '../../shared/types';
import type {
  ChatCompletionRequest,
  DiscoveredModel,
  HttpRequestSpec,
  ProviderAdapter,
  ProviderRuntime,
  ResponseParser,
} from '../../shared/provider-contract';
import { createBufferedParser } from './json';
import { parseOpenAiError } from './openaiFamily';

const NO_CHAT =
  'Black Forest Labs provides image and video generation, not chat. Configure its models for image or video generation instead.';

function refuse(): never {
  throw new AppError(appError('validation', NO_CHAT));
}

export function createBflAdapter(): ProviderAdapter {
  const kind: ProviderKind = 'bfl';
  return {
    kind,
    label: 'Black Forest Labs',
    // No chat parameters exist for this provider.
    supportedParams: [] as readonly GenParamKey[],
    supportsModelDiscovery: false,

    buildTestRequest(): HttpRequestSpec {
      return refuse();
    },
    buildListModelsRequest(): HttpRequestSpec | null {
      // BFL publishes no model-list endpoint, so discovery is simply absent.
      return null;
    },
    parseListModels(): { models: DiscoveredModel[]; error: AppErrorShape | null } {
      return {
        models: [],
        error: appError('validation', 'Black Forest Labs has no model discovery; add the model you use by hand.'),
      };
    },
    parseTestResponse(): ConnectionTestResult {
      return {
        ok: false,
        latencyMs: null,
        message: NO_CHAT,
        modelsFound: null,
        error: appError('validation', NO_CHAT),
      };
    },
    buildChatRequest(_runtime: ProviderRuntime, _request: ChatCompletionRequest): HttpRequestSpec {
      return refuse();
    },
    createResponseParser(): ResponseParser {
      // A buffered parser keeps the shape without pretending BFL can answer; the
      // chat path cannot reach it because no BFL model declares the capability.
      return createBufferedParser(() => refuse());
    },
    parseError(status: number, body: string, providerId: string): AppErrorShape {
      // BFL's error envelope is the OpenAI-compatible one, which is what this maps.
      return parseOpenAiError(status, body, providerId);
    },
  };
}
