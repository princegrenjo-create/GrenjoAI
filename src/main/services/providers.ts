/**
 * Provider management service.
 *
 * Owns the interaction between three stores that must never disagree:
 *  - the SQLite row (non-secret configuration),
 *  - the OS credential store (the key),
 *  - the provider adapter (how to talk to it).
 *
 * The returned `ProviderConfig` never contains the key. It carries a sha256
 * fingerprint instead, so the UI can show "the key changed" without holding it.
 */
import { PROVIDER_PRESETS } from '@shared/defaults';
import { AppError, appError, toAppError } from '@shared/errors';
import { fingerprintSecret, type CredentialStore } from '../credentials';
import { bindProviderKey, clearProviderKey, readProviderKey } from '../models/endpoint-policy';
import type {
  ConnectionTestResult,
  ProviderConfig,
  ProviderInput,
  ProviderKind,
} from '@shared/types';
import type { Database } from '@shared/repository-contract';
import type { ProviderRegistry, ProviderTransport, ProviderRuntime } from '@shared/provider-contract';
import { validateEndpointUrl } from '@shared/url-policy';
import type { Logger } from '../logger';
import { resolveModel } from '../models/catalog';
import type { AppSettings } from '@shared/types';

export interface ProviderServiceDeps {
  db: Database;
  credentials: CredentialStore;
  registry: ProviderRegistry;
  transport: ProviderTransport;
  settings: () => AppSettings;
  logger: Logger;
}

export interface ProviderService {
  list(): Promise<ProviderConfig[]>;
  upsert(input: ProviderInput): Promise<ProviderConfig>;
  remove(id: string): Promise<void>;
  setKey(id: string, apiKey: string): Promise<ProviderConfig>;
  clearKey(id: string): Promise<ProviderConfig>;
  test(id: string): Promise<ConnectionTestResult>;
  discoverModels(id: string): Promise<import('@shared/provider-contract').DiscoveredModel[]>;
}

function publicView(provider: ProviderConfig, credentials: CredentialStore): ProviderConfig {
  // A key is only "stored" while it is still bound to this provider's current
  // base URL. If the URL changed, the key is not usable and the UI must say so.
  const key = readProviderKey(credentials, provider.id, provider.baseUrl);
  return {
    ...provider,
    hasKey: key !== null,
    keyFingerprint: key === null ? null : fingerprintSecret(key),
    keyUpdatedAt: key === null ? null : provider.keyUpdatedAt,
  };
}

export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const { db, credentials, registry, transport, settings, logger } = deps;
  const log = logger.child('providers');

  function requireProvider(id: string): ProviderConfig {
    const provider = db.providers.get(id);
    if (!provider) {
      throw new AppError(
        appError('not_found', 'That provider no longer exists. Refresh the provider list.'),
      );
    }
    return provider;
  }

  function runtimeFor(provider: ProviderConfig, apiKey: string): ProviderRuntime {
    const current = settings();
    return {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey,
      timeoutMs: current.generation.requestTimeoutMs,
    };
  }

  function validateBaseUrl(raw: string): string {
    const current = settings();
    const check = validateEndpointUrl(raw, {
      requireHttps: current.advanced.requireHttpsForCustomEndpoints,
      allowInsecureLocalhost: current.advanced.allowInsecureLocalhost,
    });
    if (!check.ok) {
      throw new AppError(appError('validation', check.reason));
    }
    return check.url;
  }

  return {
    async list() {
      return db.providers.list().map((provider) => publicView(provider, credentials));
    },

    async upsert(input: ProviderInput) {
      const preset = PROVIDER_PRESETS[input.kind];
      if (!preset) {
        throw new AppError(appError('validation', 'Unknown provider type.'));
      }
      const baseUrl = validateBaseUrl(input.baseUrl || preset.defaultBaseUrl);
      const name = input.name.trim();
      if (name.length === 0) {
        throw new AppError(appError('validation', 'A provider name is required.'));
      }
      const existing = input.id ? db.providers.get(input.id) : null;
      const baseUrlChanged =
        existing !== null && existing.baseUrl !== baseUrl && readProviderKey(credentials, existing.id, existing.baseUrl) !== null;

      const row = existing
        ? db.providers.update(existing.id, { ...input, name, baseUrl })
        : db.providers.create({ ...input, name, baseUrl });

      if (baseUrlChanged) {
        // The key was entered for the old host. Dropping it is the only safe
        // behaviour: keeping it would send the same secret to a new destination.
        clearProviderKey(credentials, row.id);
        db.providers.recordKeyState(row.id, null, null);
        log.warn('Provider base URL changed; the stored key was discarded', { id: row.id });
      }
      log.info('Provider saved', { id: row.id, kind: row.kind });
      return publicView(row, credentials);
    },

    async remove(id: string) {
      const provider = requireProvider(id);
      clearProviderKey(credentials, provider.id);
      db.models.clearDiscovered(id);
      db.providers.softDelete(id);
      log.info('Provider removed', { id });
    },

    async setKey(id: string, apiKey: string) {
      const provider = requireProvider(id);
      const trimmed = apiKey.trim();
      if (trimmed.length === 0) {
        throw new AppError(appError('validation', 'An API key cannot be empty.'));
      }
      // The binding records which base URL this key was entered for.
      bindProviderKey(credentials, provider.id, provider.baseUrl, trimmed);
      const fingerprint = fingerprintSecret(trimmed);
      db.providers.recordKeyState(id, fingerprint, new Date().toISOString());
      log.info('Provider key stored', { id, kind: provider.kind, fingerprint });
      return publicView(requireProvider(id), credentials);
    },

    async clearKey(id: string) {
      const provider = requireProvider(id);
      clearProviderKey(credentials, provider.id);
      db.providers.recordKeyState(id, null, null);
      log.info('Provider key cleared', { id });
      return publicView(requireProvider(id), credentials);
    },

    async test(id: string) {
      const provider = requireProvider(id);
      const apiKey = readProviderKey(credentials, provider.id, provider.baseUrl);
      if (!apiKey) {
        return {
          ok: false,
          latencyMs: null,
          message: 'No API key is stored for this provider. Add one, then test again.',
          modelsFound: null,
          error: appError('missing_key', 'No API key is stored for this provider.'),
        };
      }
      const adapter = registry.get(provider.kind);
      const started = Date.now();
      try {
        const spec = adapter.buildTestRequest(runtimeFor(provider, apiKey));
        const response = await transport.send(spec, { timeoutMs: 20000, maxRetries: 1 });
        const latencyMs = Date.now() - started;
        const result = adapter.parseTestResponse(response.status, response.body);
        log.info('Provider test finished', {
          id,
          kind: provider.kind,
          status: response.status,
          ok: result.ok,
          latencyMs,
        });
        return { ...result, latencyMs };
      } catch (error) {
        const shape = toAppError(error, 'provider_error');
        log.warn('Provider test threw', { id, code: shape.code, status: shape.status });
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: shape.message,
          modelsFound: null,
          error: shape,
        };
      }
    },

    async discoverModels(id: string) {
      const provider = requireProvider(id);
      const adapter = registry.get(provider.kind);
      if (!adapter.supportsModelDiscovery) {
        throw new AppError(
          appError(
            'bad_request',
            `${adapter.label} does not expose a model-listing API. Add models manually under Others / Custom Models.`,
          ),
        );
      }
      const apiKey = readProviderKey(credentials, provider.id, provider.baseUrl);
      if (!apiKey) {
        throw new AppError(
          appError('missing_key', 'Add an API key for this provider before discovering models.'),
        );
      }
      const spec = adapter.buildListModelsRequest(runtimeFor(provider, apiKey));
      if (!spec) {
        throw new AppError(
          appError('bad_request', `${adapter.label} does not expose a model-listing API.`),
        );
      }
      try {
        const response = await transport.send(spec, { timeoutMs: 30000, maxRetries: 1 });
        const parsed = adapter.parseListModels(response.status, response.body);
        if (parsed.error) {
          throw new AppError(parsed.error);
        }
        log.info('Model discovery finished', { id, count: parsed.models.length });
        return parsed.models;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(toAppError(error, 'provider_error'));
      }
    },
  };
}

/** Type guard used by the IPC layer to keep kinds honest. */
export function isProviderKind(value: string): value is ProviderKind {
  return value in PROVIDER_PRESETS;
}

/** Exported for the model service, which needs the same resolution rules. */
export { resolveModel };
