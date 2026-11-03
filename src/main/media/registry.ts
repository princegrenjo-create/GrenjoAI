/**
 * Which adapter serves which provider for media generation.
 *
 * Kept separate from the provider registry because media generation is an
 * *optional* capability: a provider can be configured for chat and have no media
 * adapter at all, and that must be a fact the service reports rather than a null
 * pointer three layers down.
 *
 * The registry holds adapters keyed by provider id, so two providers of the same
 * kind (two OpenAI-compatible endpoints, say) can carry different base URLs and
 * different credentials without sharing state.
 */
import type { MediaJobAdapter } from '@shared/media-job';

export interface MediaAdapterRegistry {
  get(providerId: string): MediaJobAdapter | null;
  set(providerId: string, adapter: MediaJobAdapter): void;
  remove(providerId: string): void;
  ids(): string[];
}

export function createMediaAdapterRegistry(): MediaAdapterRegistry {
  const adapters = new Map<string, MediaJobAdapter>();
  return {
    get(providerId) {
      return adapters.get(providerId) ?? null;
    },
    set(providerId, adapter) {
      adapters.set(providerId, adapter);
    },
    remove(providerId) {
      adapters.delete(providerId);
    },
    ids() {
      return [...adapters.keys()];
    },
  };
}
