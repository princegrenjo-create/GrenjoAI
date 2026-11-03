/**
 * Model management service: list, create/edit/delete custom models, persist
 * discovery results, and probe a single model with a real (tiny) request.
 */
import { hasCapability } from '@shared/capabilities';
import { AppError, appError, toAppError } from '@shared/errors';
import type { CredentialStore } from '../credentials';
import type {
  AppSettings,
  CustomModelInput,
  ModelDescriptor,
  ModelRef,
  ModelTestResult,
} from '@shared/types';
import type { Database } from '@shared/repository-contract';
import type {
  DiscoveredModel,
  ProviderRegistry,
  ProviderTransport,
  ProviderRuntime,
} from '@shared/provider-contract';
import { validateEndpointUrl } from '@shared/url-policy';
import type { Logger } from '../logger';
import { listAllModels, listModelsForProvider, resolveModel } from '../models/catalog';
import { readProviderKey, resolveRequestEndpoint } from '../models/endpoint-policy';
import type { ChatCompletionRequest } from '@shared/provider-contract';

export interface ModelServiceDeps {
  db: Database;
  credentials: CredentialStore;
  registry: ProviderRegistry;
  transport: ProviderTransport;
  settings: () => AppSettings;
  logger: Logger;
}

export interface ModelService {
  list(providerId?: string): Promise<ModelDescriptor[]>;
  upsert(input: CustomModelInput): Promise<ModelDescriptor>;
  remove(id: string): Promise<void>;
  saveDiscovered(providerId: string, models: DiscoveredModel[]): Promise<ModelDescriptor[]>;
  clearDiscovered(providerId: string): Promise<void>;
  test(ref: ModelRef, prompt?: string): Promise<ModelTestResult>;
}

export function createModelService(deps: ModelServiceDeps): ModelService {
  const { db, credentials, registry, transport, settings, logger } = deps;
  const log = logger.child('models');

  function checkEndpoint(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const current = settings();
    const check = validateEndpointUrl(trimmed, {
      requireHttps: current.advanced.requireHttpsForCustomEndpoints,
      allowInsecureLocalhost: current.advanced.allowInsecureLocalhost,
    });
    if (!check.ok) throw new AppError(appError('validation', check.reason));
    return check.url;
  }

  return {
    async list(providerId?: string) {
      if (!providerId) return listAllModels(db);
      const provider = db.providers.get(providerId);
      if (!provider) return [];
      return listModelsForProvider(db, provider.id, provider.kind);
    },

    async upsert(input: CustomModelInput) {
      const provider = db.providers.get(input.providerId);
      if (!provider) {
        throw new AppError(appError('not_found', 'The selected provider no longer exists.'));
      }
      const modelId = input.modelId.trim();
      const displayName = input.displayName.trim();
      if (modelId.length === 0) {
        throw new AppError(appError('validation', 'The exact model id is required.'));
      }
      if (displayName.length === 0) {
        throw new AppError(appError('validation', 'A display name is required.'));
      }
      const baseUrlOverride = checkEndpoint(input.baseUrlOverride);
      const row = db.models.upsert({ ...input, modelId, displayName, baseUrlOverride });
      log.info('Custom model saved', { id: row.id, providerId: row.providerId });
      return row;
    },

    async remove(id: string) {
      const model = db.models.get(id);
      if (!model) {
        throw new AppError(appError('not_found', 'That model no longer exists.'));
      }
      if (model.source !== 'custom') {
        throw new AppError(
          appError(
            'bad_request',
            'Only models you added yourself can be deleted. Discovered models are refreshed by discovery.',
          ),
        );
      }
      db.models.softDelete(id);
      log.info('Custom model removed', { id });
    },

    async saveDiscovered(providerId: string, models: DiscoveredModel[]) {
      const provider = db.providers.get(providerId);
      if (!provider) {
        throw new AppError(appError('not_found', 'The selected provider no longer exists.'));
      }
      const now = new Date().toISOString();
      const rows: ModelDescriptor[] = models.map((model) => ({
        id: `disc:${providerId}:${model.modelId}`,
        providerId,
        modelId: model.modelId,
        displayName: model.displayName || model.modelId,
        source: 'discovered',
        capabilities: model.capabilities,
        limits: model.limits,
        description: model.description,
        supportedParams: model.supportedParams,
        weirdnessSupported: model.weirdnessSupported,
        baseUrlOverride: null,
        createdAt: now,
        updatedAt: now,
      }));
      db.models.replaceDiscovered(providerId, rows);
      log.info('Discovered models saved', { providerId, count: rows.length });
      return db.models.list(providerId);
    },

    async clearDiscovered(providerId: string) {
      db.models.clearDiscovered(providerId);
      log.info('Discovered models cleared', { providerId });
    },

    async test(ref: ModelRef, prompt?: string) {
      const resolved = resolveModel(db, ref.providerId, ref.modelId);
      if (!resolved) {
        return {
          ok: false,
          latencyMs: null,
          sample: null,
          error: appError(
            'model_not_found',
            'That model is not registered for this provider. Discover it or add it under Others / Custom Models.',
          ),
        };
      }
      const provider = db.providers.get(ref.providerId);
      if (!provider) {
        return {
          ok: false,
          latencyMs: null,
          sample: null,
          error: appError('not_found', 'The provider for this model no longer exists.'),
        };
      }
      const apiKey = readProviderKey(credentials, provider.id, provider.baseUrl);
      if (!apiKey) {
        return {
          ok: false,
          latencyMs: null,
          sample: null,
          error: appError('missing_key', 'Add an API key for this provider first.'),
        };
      }
      let endpoint: string;
      try {
        endpoint = resolveRequestEndpoint(provider.baseUrl, resolved.model.baseUrlOverride);
      } catch (error) {
        return { ok: false, latencyMs: null, sample: null, error: toAppError(error, 'validation') };
      }
      const adapter = registry.get(provider.kind);
      /*
       * The probe is a chat completion, so it is only meaningful for a model that
       * declares text generation. Sending `chat/completions` at an image or video
       * model would produce a provider error that looks like a broken model
       * rather than a probe that cannot apply.
       */
      if (!hasCapability(resolved.model.capabilities, 'chat')) {
        return {
          ok: false,
          latencyMs: null,
          sample: null,
          error: appError(
            'validation',
            'This model does not accept chat requests, so a chat prompt cannot test it. It is still listed and can be selected for the task it does support.',
          ),
        };
      }
      const runtime: ProviderRuntime = {
        providerId: provider.id,
        baseUrl: endpoint,
        apiKey,
        timeoutMs: 30000,
      };
      const request: ChatCompletionRequest = {
        modelId: resolved.model.modelId,
        system: null,
        turns: [{ role: 'user', content: prompt?.trim() || 'Reply with exactly one word: ok' }],
        params: { maxOutputTokens: 64 },
        stream: false,
        baseUrlOverride: resolved.model.baseUrlOverride,
      };
      const started = Date.now();
      try {
        const result = await transport.run(runtime, adapter, request, {}, { timeoutMs: 30000, maxRetries: 0 });
        const sample = result.text.trim().slice(0, 400);
        log.info('Model test finished', {
          providerId: provider.id,
          modelId: resolved.model.modelId,
          latencyMs: Date.now() - started,
        });
        return { ok: true, latencyMs: Date.now() - started, sample, error: null };
      } catch (error) {
        const shape = toAppError(error, 'provider_error');
        log.warn('Model test failed', { providerId: provider.id, code: shape.code });
        return { ok: false, latencyMs: Date.now() - started, sample: null, error: shape };
      }
    },
  };
}
