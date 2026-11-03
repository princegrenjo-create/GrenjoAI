/**
 * Settings service: read, patch, reset, and the non-secret configuration export
 * / import.
 *
 * The export is the one place a user could accidentally leak a secret, so it is
 * built from an explicit allowlist of fields rather than by deleting known
 * secret fields from a copy. `credentials: 'excluded'` is written into the
 * document itself so a reader cannot mistake it for a complete backup.
 */
import { PROVIDER_PRESETS } from '@shared/defaults';
import { AppError, appError, toAppError } from '@shared/errors';
import { mergeSettings, normaliseSettings } from '@shared/settings';
import { validateEndpointUrl } from '@shared/url-policy';
import { GEN_PARAM_KEYS, type GenParamKey } from '@shared/types';
import type {
  Agent,
  AppSettings,
  AppSettingsPatch,
  ConfigExport,
  ConfigImportResult,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';
import type { Database } from '@shared/repository-contract';
import { toModelCapabilities } from '../db/domain-codec';
import type { Logger } from '../logger';

export interface SettingsServiceDeps {
  db: Database;
  logger: Logger;
  onChanged?: (settings: AppSettings) => void;
}

export interface SettingsService {
  get(): Promise<AppSettings>;
  patch(patch: AppSettingsPatch): Promise<AppSettings>;
  reset(): Promise<AppSettings>;
  exportConfig(): Promise<ConfigExport>;
  importConfig(json: string): Promise<ConfigImportResult>;
}

const SECRET_FIELD_HINTS = /(api[-_]?key|apikey|secret|password|token|anon[-_]?key|authorization)/i;

function looksLikeSecretValue(value: string): boolean {
  return (
    /\bsk-[A-Za-z0-9_-]{6,}/.test(value) ||
    /\bAIza[0-9A-Za-z_-]{6,}/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/.test(value) ||
    /\bsk-ant-[A-Za-z0-9_-]{6,}/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { db, logger, onChanged } = deps;
  const log = logger.child('settings');

  function apply(next: AppSettings): AppSettings {
    const stored = db.settings.replace(next);
    onChanged?.(stored);
    return stored;
  }

  return {
    async get() {
      return db.settings.get();
    },

    async patch(patch: AppSettingsPatch) {
      const next = mergeSettings(db.settings.get(), patch);
      const stored = apply(next);
      log.info('Settings updated', { sections: Object.keys(patch) });
      return stored;
    },

    async reset() {
      const stored = db.settings.reset();
      onChanged?.(stored);
      log.info('Settings reset to defaults');
      return stored;
    },

    async exportConfig() {
      const settings = db.settings.get();
      const providers = db.providers.list().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        supportsModelDiscovery: provider.supportsModelDiscovery,
        supportedParams: provider.supportedParams,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      }));
      const agents = db.agents.list();
      const customModels = db.models
        .list()
        .filter((model) => model.source === 'custom')
        .map((model) => ({
          id: model.id,
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          capabilities: model.capabilities,
          limits: model.limits,
          description: model.description,
          supportedParams: model.supportedParams,
          weirdnessSupported: model.weirdnessSupported,
          baseUrlOverride: model.baseUrlOverride,
          createdAt: model.createdAt,
          updatedAt: model.updatedAt,
        }));

      const document: ConfigExport = {
        app: 'grenjo-ai-tool',
        exportedAt: new Date().toISOString(),
        settings,
        providers,
        agents,
        customModels,
        credentials: 'excluded',
      };

      // Defence in depth: fail loudly rather than hand the user a file that
      // contains something key-shaped, whoever put it there.
      const serialised = JSON.stringify(document);
      if (looksLikeSecretValue(serialised)) {
        throw new AppError(
          appError(
            'storage',
            'The export was refused because a value looked like a credential. Nothing was written.',
          ),
        );
      }
      log.info('Configuration exported', { providers: providers.length, agents: agents.length });
      return document;
    },

    async importConfig(json: string): Promise<ConfigImportResult> {
      const applied: string[] = [];
      const skipped: string[] = [];
      const warnings: string[] = [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new AppError(appError('validation', 'That file is not valid JSON.'));
      }
      // Accept the pre-rename marker too, so an older export still imports.
      if (!isRecord(parsed) || (parsed.app !== 'grenjo-ai-tool' && parsed.app !== 'personal-ai-desk')) {
        throw new AppError(
          appError('validation', 'That is not a Grenjo AI Tool configuration export.'),
        );
      }

      // Reject secret-bearing documents outright instead of importing most of it.
      for (const [key, value] of Object.entries(parsed)) {
        if (SECRET_FIELD_HINTS.test(key) && key !== 'credentials') {
          skipped.push(key);
          warnings.push(`Ignored "${key}": credentials are never imported from a file.`);
        }
        if (typeof value === 'string' && looksLikeSecretValue(value)) {
          throw new AppError(
            appError(
              'validation',
              'That file contains something that looks like an API key. Remove it before importing: keys are never transferred by export or import.',
            ),
          );
        }
      }

      // Every write in one transaction: a half-imported configuration file is
      // worse than a rejected one, because the user cannot tell which half landed.
      const applyDocument = (): void => {
        if (isRecord(parsed.settings)) {
          apply(normaliseSettings(parsed.settings));
          applied.push('settings');
        } else {
          skipped.push('settings');
        }

        if (Array.isArray(parsed.providers)) {
          let count = 0;
          for (const raw of parsed.providers) {
            if (!isRecord(raw)) {
              skipped.push('providers[]');
              continue;
            }
            const kind = typeof raw.kind === 'string' ? raw.kind : '';
            if (!(kind in PROVIDER_PRESETS)) {
              warnings.push(`Skipped a provider with unknown type "${kind}".`);
              skipped.push('providers[]');
              continue;
            }
            const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
            const check = validateEndpointUrl(baseUrl, {
              requireHttps: true,
              allowInsecureLocalhost: true,
            });
            if (!check.ok) {
              warnings.push(`Skipped provider "${String(raw.name ?? kind)}": ${check.reason}`);
              skipped.push('providers[]');
              continue;
            }
            const preset = PROVIDER_PRESETS[kind as keyof typeof PROVIDER_PRESETS];
            const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
            const payload = {
              kind: kind as keyof typeof PROVIDER_PRESETS,
              name:
                typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : preset.defaultName,
              baseUrl: check.url,
              enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
            };
            if (id && db.providers.get(id)) db.providers.update(id, payload);
            else db.providers.create(id ? { ...payload, id } : payload);
            count += 1;
          }
          applied.push(`providers (${count})`);
        }

        if (Array.isArray(parsed.agents)) {
          let count = 0;
          for (const raw of parsed.agents) {
            if (!isRecord(raw) || typeof raw.name !== 'string') {
              skipped.push('agents[]');
              continue;
            }
            const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
            const payload = {
              name: raw.name,
              description: typeof raw.description === 'string' ? raw.description : '',
              providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
              modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
              systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
              params: isRecord(raw.params) ? raw.params : {},
            };
            if (id && db.agents.get(id)) db.agents.update(id, payload);
            else db.agents.create(id ? { ...payload, id } : payload);
            count += 1;
          }
          applied.push(`agents (${count})`);
        }

        if (Array.isArray(parsed.customModels)) {
          let count = 0;
          for (const raw of parsed.customModels) {
            if (
              !isRecord(raw) ||
              typeof raw.modelId !== 'string' ||
              typeof raw.providerId !== 'string'
            ) {
              skipped.push('customModels[]');
              continue;
            }
            // Tolerant read: an export written before the capability model has
            // the original four flags and none of the others, and must still
            // import as a working chat model rather than being skipped.
            const capabilities = toModelCapabilities(raw.capabilities);

            // Only ids this build understands; an unknown key in a hand-edited
            // file must not become a parameter the request layer then tries to map.
            const supportedParams: GenParamKey[] = Array.isArray(raw.supportedParams)
              ? raw.supportedParams.filter((entry): entry is GenParamKey =>
                  typeof entry === 'string' && (GEN_PARAM_KEYS as readonly string[]).includes(entry),
                )
              : [];
            if (Array.isArray(raw.supportedParams) && supportedParams.length !== raw.supportedParams.length) {
              warnings.push('Some unsupported parameter ids were dropped from an imported model.');
            }

            const limits = isRecord(raw.limits)
              ? {
                  contextWindow:
                    typeof raw.limits.contextWindow === 'number' ? raw.limits.contextWindow : undefined,
                  maxOutputTokens:
                    typeof raw.limits.maxOutputTokens === 'number'
                      ? raw.limits.maxOutputTokens
                      : undefined,
                }
              : {};

            db.models.upsert({
              providerId: raw.providerId,
              modelId: raw.modelId,
              displayName:
                typeof raw.displayName === 'string' && raw.displayName.trim()
                  ? raw.displayName
                  : raw.modelId,
              description: typeof raw.description === 'string' ? raw.description : '',
              capabilities,
              limits,
              supportedParams,
              weirdnessSupported: raw.weirdnessSupported === true,
              baseUrlOverride: typeof raw.baseUrlOverride === 'string' ? raw.baseUrlOverride : null,
            });
            count += 1;
          }
          applied.push(`custom models (${count})`);
        }
      };

      db.transaction(applyDocument);

      log.info('Configuration imported', { applied: applied.length, skipped: skipped.length });
      return { applied, skipped, warnings };
    },
  };
}

/** Kept exported for the IPC layer's type-only needs. */
export type { Agent, ModelDescriptor, ProviderConfig };

/** Normalise a value thrown by a JSON boundary into the shared error shape. */
export function settingsError(error: unknown) {
  return toAppError(error, 'validation');
}
