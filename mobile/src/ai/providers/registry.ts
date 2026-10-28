/**
 * Provider registry: one adapter per `ProviderKind`.
 *
 * Consumers (chat service, settings IPC, discovery) ask for an adapter by kind
 * and never import a concrete adapter module, so adding a provider is a change
 * in this directory and nowhere else.
 *
 * The registry is built in `PROVIDER_ORDER` order so the settings UI lists
 * providers deterministically.
 */
import type { ProviderAdapter, ProviderRegistry } from '@core/provider-contract';
import type { ProviderKind } from '@core/types';
import { PROVIDER_ORDER } from '@core/defaults';
import { AppError, appError } from '@core/errors';
import { createDeepSeekAdapter } from './deepseek';
import { createOpenAiAdapter } from './openai';
import { createGeminiAdapter } from './gemini';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAiCompatibleAdapter } from './openaiCompatible';

function createAdapter(kind: ProviderKind): ProviderAdapter {
  switch (kind) {
    case 'deepseek':
      return createDeepSeekAdapter();
    case 'openai':
      return createOpenAiAdapter();
    case 'gemini':
      return createGeminiAdapter();
    case 'anthropic':
      return createAnthropicAdapter();
    case 'openai-compatible':
      return createOpenAiCompatibleAdapter();
  }
}

export function createRegistry(): ProviderRegistry {
  const adapters: ProviderAdapter[] = PROVIDER_ORDER.map((kind) => createAdapter(kind));
  const index = new Map<ProviderKind, ProviderAdapter>();
  for (const adapter of adapters) index.set(adapter.kind, adapter);

  return {
    get(kind: ProviderKind): ProviderAdapter {
      const adapter = index.get(kind);
      if (!adapter) {
        throw new AppError(
          appError('not_found', `No adapter is registered for provider kind “${kind}”.`),
        );
      }
      return adapter;
    },
    all(): ProviderAdapter[] {
      return [...adapters];
    },
  };
}
