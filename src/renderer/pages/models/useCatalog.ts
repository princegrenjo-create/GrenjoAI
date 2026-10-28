/**
 * Loads the two lists this screen owns — providers and their models — and keeps
 * them consistent after a mutation.
 *
 * The page holds one copy of each list; a card never keeps its own duplicate of
 * a provider, because two copies of a row that can be edited in place is how a
 * stale base URL survives a save.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { asAppError } from '@shared/errors';
import type { AppErrorShape, ModelDescriptor, ProviderConfig } from '@shared/types';
import { getApi } from '@renderer/lib/api';

export type CatalogStatus = 'loading' | 'ready' | 'error';

export interface CatalogState {
  status: CatalogStatus;
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  error: AppErrorShape | null;
  reload(): Promise<void>;
  refreshModels(): Promise<void>;
  replaceProvider(provider: ProviderConfig): void;
  removeProvider(id: string): void;
}

export function useCatalog(): CatalogState {
  const [status, setStatus] = useState<CatalogStatus>('loading');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [error, setError] = useState<AppErrorShape | null>(null);

  const ticket = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const current = ticket.current + 1;
    ticket.current = current;
    setStatus('loading');
    setError(null);
    try {
      const api = getApi();
      const [nextProviders, nextModels] = await Promise.all([
        api.providers.list(),
        api.models.list(),
      ]);
      if (!alive.current || ticket.current !== current) return;
      setProviders(nextProviders);
      setModels(nextModels);
      setStatus('ready');
    } catch (thrown) {
      if (!alive.current || ticket.current !== current) return;
      setError(asAppError(thrown));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshModels = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().models.list();
      if (alive.current) setModels(next);
    } catch {
      // A refresh after a successful write is a convenience; the write itself
      // already reported its own failure. The next reload reconciles the list.
    }
  }, []);

  const replaceProvider = useCallback((provider: ProviderConfig): void => {
    setProviders((current) => {
      const found = current.some((entry) => entry.id === provider.id);
      return found
        ? current.map((entry) => (entry.id === provider.id ? provider : entry))
        : [...current, provider];
    });
  }, []);

  const removeProvider = useCallback((id: string): void => {
    setProviders((current) => current.filter((entry) => entry.id !== id));
    setModels((current) => current.filter((entry) => entry.providerId !== id));
  }, []);

  return {
    status,
    providers,
    models,
    error,
    reload,
    refreshModels,
    replaceProvider,
    removeProvider,
  };
}
