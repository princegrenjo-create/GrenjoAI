/**
 * The supporting data the Settings screen needs beside the settings document: the
 * agent and model lists its pickers depend on, the data locations, and the build
 * information for the About panel.
 *
 * Each resource is loaded and tracked on its own. One failing read must degrade
 * only the control that needed it — a failing `agents.list()` is not a reason to
 * hide the theme selector, and a hung `app.paths()` must not hold the page in a
 * skeleton forever.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { asAppError } from '@shared/errors';
import type {
  Agent,
  AppErrorShape,
  AppInfo,
  AppPaths,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';
import { getApi } from '@renderer/lib/api';

export type ResourceKey = 'agents' | 'providers' | 'models' | 'info' | 'paths';

export interface SettingsResources {
  agents: Agent[];
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  info: AppInfo | null;
  paths: AppPaths | null;
  /** Per-resource failure. A key is present only while that read is failing. */
  errors: Partial<Record<ResourceKey, AppErrorShape>>;
  /** True until the first attempt at every resource has settled. */
  loading: boolean;
  reload(): Promise<void>;
  retry(key: ResourceKey): Promise<void>;
}

export function useSettingsResources(): SettingsResources {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ResourceKey, AppErrorShape>>>({});
  const [loading, setLoading] = useState(true);

  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const clearError = useCallback((key: ResourceKey): void => {
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const fail = useCallback((key: ResourceKey, thrown: unknown): void => {
    setErrors((current) => ({ ...current, [key]: asAppError(thrown) }));
  }, []);

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().agents.list();
      if (!alive.current) return;
      setAgents(next);
      clearError('agents');
    } catch (thrown) {
      if (!alive.current) return;
      fail('agents', thrown);
    }
  }, [clearError, fail]);

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().providers.list();
      if (!alive.current) return;
      setProviders(next);
      clearError('providers');
    } catch (thrown) {
      if (!alive.current) return;
      fail('providers', thrown);
    }
  }, [clearError, fail]);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().models.list();
      if (!alive.current) return;
      setModels(next);
      clearError('models');
    } catch (thrown) {
      if (!alive.current) return;
      fail('models', thrown);
    }
  }, [clearError, fail]);

  const loadInfo = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().app.info();
      if (!alive.current) return;
      setInfo(next);
      clearError('info');
    } catch (thrown) {
      if (!alive.current) return;
      fail('info', thrown);
    }
  }, [clearError, fail]);

  const loadPaths = useCallback(async (): Promise<void> => {
    try {
      const next = await getApi().app.paths();
      if (!alive.current) return;
      setPaths(next);
      clearError('paths');
    } catch (thrown) {
      if (!alive.current) return;
      fail('paths', thrown);
    }
  }, [clearError, fail]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    await Promise.all([loadAgents(), loadProviders(), loadModels(), loadInfo(), loadPaths()]);
    if (alive.current) setLoading(false);
  }, [loadAgents, loadProviders, loadModels, loadInfo, loadPaths]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const retry = useCallback(
    async (key: ResourceKey): Promise<void> => {
      switch (key) {
        case 'agents':
          await loadAgents();
          break;
        case 'providers':
          await loadProviders();
          break;
        case 'models':
          await loadModels();
          break;
        case 'info':
          await loadInfo();
          break;
        case 'paths':
        default:
          await loadPaths();
          break;
      }
    },
    [loadAgents, loadProviders, loadModels, loadInfo, loadPaths],
  );

  return { agents, providers, models, info, paths, errors, loading, reload, retry };
}
