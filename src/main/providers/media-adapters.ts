/**
 * Which adapter runs a provider's media generation.
 *
 * Built per call rather than cached. An adapter captures the provider's base URL,
 * and the app deliberately invalidates a stored key when its base URL changes — so
 * a cached adapter would keep sending a now-invalid key to a now-wrong endpoint.
 * Constructing one is a closure; correctness is worth more than the allocation.
 *
 * The mapping is by provider *kind*, so a second OpenAI-compatible endpoint gets
 * the OpenAI adapter only when it is an OpenAI provider: a generic compatible
 * endpoint is not assumed to offer an images API.
 */
import type { ProviderConfig } from '@shared/types';
import type { MediaJobAdapter } from '@shared/media-job';
import type { ProviderTransport } from '@shared/provider-contract';
import { readProviderKey } from '../models/endpoint-policy';
import type { CredentialStore } from '../credentials';
import { createOpenAiImageAdapter } from './openaiImages';
import { createGeminiImageAdapter } from './geminiImages';
import { createGeminiVideoAdapter } from './geminiVideo';
import { createBflVideoAdapter } from './bflVideo';

export interface MediaAdapterContext {
  credentials: CredentialStore;
  transport: ProviderTransport;
}

/**
 * The adapter for a provider, or null when this build has none for its kind.
 *
 * A null is a fact the service reports ("this provider does not have a generation
 * adapter in this build") rather than a crash three layers down.
 */
export function buildMediaAdapter(
  provider: ProviderConfig,
  context: MediaAdapterContext,
): MediaJobAdapter | null {
  const apiKey = async (): Promise<string> =>
    readProviderKey(context.credentials, provider.id, provider.baseUrl) ?? '';

  switch (provider.kind) {
    case 'openai':
      return createOpenAiImageAdapter({
        baseUrl: provider.baseUrl,
        apiKey,
        transport: context.transport,
      });
    case 'gemini':
      /*
       * One provider, two media tasks. The port already carries the task, so the
       * split happens here instead of forcing the registry to know which task a
       * provider id was going to be used for.
       */
      return createGeminiMediaAdapter({
        baseUrl: provider.baseUrl,
        apiKey,
        transport: context.transport,
      });
    case 'bfl':
      return createBflVideoAdapter({
        baseUrl: provider.baseUrl,
        apiKey,
        transport: context.transport,
      });
    default:
      // deepseek, anthropic and a generic OpenAI-compatible endpoint do not
      // document an image-generation API this build supports.
      return null;
  }
}

/**
 * Gemini dispatches image and video to the two adapters that document them.
 *
 * Kept as one MediaJobAdapter because the registry is keyed by provider, not by
 * task: a provider can offer both, and the caller has already said which one it
 * wants.
 */
function createGeminiMediaAdapter(options: {
  baseUrl: string;
  apiKey(): Promise<string>;
  transport: ProviderTransport;
}): MediaJobAdapter {
  const image = createGeminiImageAdapter(options);
  const video = createGeminiVideoAdapter(options);
  return {
    supportsCancel: false,
    maxConcurrent: null,
    submit: (input) => (input.task === 'video' ? video.submit(input) : image.submit(input)),
    poll: (input) => (input.task === 'video' ? video.poll(input) : image.poll(input)),
  };
}