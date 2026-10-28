/**
 * Model discovery, in one place.
 *
 * The provider card and a discovered model's own row both offer "refresh via
 * discovery", and both must run the same two steps in the same order: enumerate
 * through the provider, then persist what came back. A single function means the
 * second path cannot forget the save.
 */
import { asAppError } from '@shared/errors';
import type { AppErrorShape } from '@shared/types';
import { getApi } from '@renderer/lib/api';

export type DiscoveryOutcome =
  | { ok: true; count: number }
  | { ok: false; error: AppErrorShape };

export async function runDiscovery(providerId: string): Promise<DiscoveryOutcome> {
  const api = getApi();
  try {
    const discovered = await api.providers.discoverModels(providerId);
    await api.models.saveDiscovered(providerId, discovered);
    return { ok: true, count: discovered.length };
  } catch (thrown) {
    return { ok: false, error: asAppError(thrown) };
  }
}
