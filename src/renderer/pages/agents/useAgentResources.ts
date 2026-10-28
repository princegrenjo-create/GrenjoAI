/**
 * Loads what the Agents screen needs: the agents themselves, plus the providers
 * and models the editor's pickers and its parameter gating depend on.
 *
 * One hook, one load, so the picker can never show a model that the parameter
 * panel disagrees about.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { asAppError } from '@shared/errors';
import type {
  Agent,
  AppErrorShape,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';
import { getApi } from '@renderer/lib/api';

export type ResourcesStatus = 'loading' | 'ready' | 'error';

export interface AgentResources {
  status: ResourcesStatus;
  agents: Agent[];
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  error: AppErrorShape | null;
  reload(): Promise<void>;
  replaceAgent(agent: Agent): void;
  removeAgent(id: string): void;
}

export function useAgentResources(): AgentResources {
  const [status, setStatus] = useState<ResourcesStatus>('loading');
  const [agents, setAgents] = useState<Agent[]>([]);
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
      const [nextAgents, nextProviders, nextModels] = await Promise.all([
        api.agents.list(),
        api.providers.list(),
        api.models.list(),
      ]);
      if (!alive.current || ticket.current !== current) return;
      setAgents(nextAgents);
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

  const replaceAgent = useCallback((agent: Agent): void => {
    setAgents((current) => {
      const found = current.some((entry) => entry.id === agent.id);
      return found
        ? current.map((entry) => (entry.id === agent.id ? agent : entry))
        : [...current, agent];
    });
  }, []);

  const removeAgent = useCallback((id: string): void => {
    setAgents((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return { status, agents, providers, models, error, reload, replaceAgent, removeAgent };
}
