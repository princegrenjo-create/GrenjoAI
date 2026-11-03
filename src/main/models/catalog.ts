/**
 * The model catalogue resolver.
 *
 * Three sources feed the model list, in this order of authority for a given
 * (provider, modelId) pair:
 *   1. a model row the user created   (`source: 'custom'`)
 *   2. a model row discovery returned (`source: 'discovered'`)
 *   3. a built-in hint                (`source: 'catalog'`)
 *
 * A hint is a convenience so a fresh install can start a conversation before
 * discovery runs. It is never a claim about what the provider currently serves,
 * and nothing here may substitute a different model id when the requested one is
 * missing: the caller gets `null` and reports `model_not_found`.
 */
import { MODEL_HINTS } from '@shared/defaults';
import type { ModelDescriptor, ProviderKind } from '@shared/types';
import type { Database } from '@shared/repository-contract';

export function catalogId(kind: ProviderKind, modelId: string): string {
  return `catalog:${kind}:${modelId}`;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * A hint whose provider shutdown date has passed is not offered.
 *
 * Filtering here rather than in the UI keeps one rule in one place: no picker,
 * probe or resolution path can reach a retired id, and the check is a date
 * comparison instead of a list someone forgets to update.
 */
function isRetired(hint: { shutdownDate?: string }, now = new Date()): boolean {
  if (!hint.shutdownDate) return false;
  const date = new Date(`${hint.shutdownDate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.getTime() <= now.getTime();
}

/** Built-in hints for a provider family, shaped like a stored model row. */
export function listCatalogModels(providerId: string, kind: ProviderKind): ModelDescriptor[] {
  const hints = (MODEL_HINTS[kind] ?? []).filter((hint) => !isRetired(hint));
  return hints.map((hint) => ({
    id: catalogId(kind, hint.modelId),
    providerId,
    modelId: hint.modelId,
    displayName: hint.displayName,
    source: 'catalog' as const,
    capabilities: { ...hint.capabilities },
    limits: { ...hint.limits },
    description: hint.description,
    supportedParams: [...hint.supportedParams],
    weirdnessSupported: hint.weirdnessSupported,
    baseUrlOverride: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }));
}

export interface ResolvedModel {
  model: ModelDescriptor;
  providerKind: ProviderKind;
}

/** Resolve the exact model the user asked for. Returns null rather than guessing. */
export function resolveModel(
  db: Database,
  providerId: string,
  modelId: string,
): ResolvedModel | null {
  const provider = db.providers.get(providerId);
  if (!provider) return null;

  const stored = db.models.findByRef(providerId, modelId);
  if (stored) return { model: stored, providerKind: provider.kind };

  const hint = (MODEL_HINTS[provider.kind] ?? []).find((entry) => entry.modelId === modelId);
  if (!hint) return null;

  const [descriptor] = listCatalogModels(providerId, provider.kind).filter(
    (entry) => entry.modelId === modelId,
  );
  return descriptor ? { model: descriptor, providerKind: provider.kind } : null;
}

/**
 * Every model selectable for a provider: stored rows first (custom then
 * discovered), then built-in hints that are not already represented. A stored
 * row with the same modelId wins over the hint so the user's edit is respected.
 */
export function listModelsForProvider(
  db: Database,
  providerId: string,
  providerKind: ProviderKind,
): ModelDescriptor[] {
  const stored = db.models.list(providerId);
  const seen = new Set(stored.map((model) => model.modelId));
  const hints = listCatalogModels(providerId, providerKind).filter(
    (model) => !seen.has(model.modelId),
  );
  const rank: Record<ModelDescriptor['source'], number> = {
    custom: 0,
    discovered: 1,
    catalog: 2,
  };
  return [...stored, ...hints].sort((a, b) => {
    const bySource = rank[a.source] - rank[b.source];
    if (bySource !== 0) return bySource;
    return a.displayName.localeCompare(b.displayName);
  });
}

/** All models across every enabled provider, for the chat model picker. */
export function listAllModels(db: Database): ModelDescriptor[] {
  const out: ModelDescriptor[] = [];
  for (const provider of db.providers.list()) {
    out.push(...listModelsForProvider(db, provider.id, provider.kind));
  }
  return out;
}
