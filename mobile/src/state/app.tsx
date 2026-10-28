/**
 * App state.
 *
 * One provider holds the database handle and the catalog (settings, providers,
 * models, agents). Screens read from it and call its actions; nothing writes the
 * database directly outside this module, so there is a single writer per atom.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Agent, AppSettings, Conversation, ModelDescriptor, ProviderConfig } from '@core/types';
import { DEFAULT_SETTINGS, MODEL_HINTS, PROVIDER_PRESETS } from '@core/defaults';
import { normaliseSettings } from '@core/settings';
import {
  deleteAgent,
  deleteConversation,
  deleteProvider,
  listAgents,
  listConversations,
  listModels,
  listProviders,
  loadSettings,
  openDatabase,
  saveAgent,
  saveModel,
  saveProvider,
  saveSettings,
  settleInterruptedMessages,
  type AgentInput,
} from '@/db/database';
import { clearProviderKey, fingerprint, getProviderKey, setProviderKey } from '@/keys/secure-store';

export interface AppState {
  ready: boolean;
  error: string | null;
  db: SQLiteDatabase | null;
  settings: AppSettings;
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  agents: Agent[];
  conversations: Conversation[];
  refresh(): Promise<void>;
  refreshConversations(): Promise<void>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  addProvider(input: { kind: ProviderConfig['kind']; name: string; baseUrl: string; apiKey: string }): Promise<void>;
  removeProvider(id: string): Promise<void>;
  discoverModels(providerId: string): Promise<number>;
  addCustomModel(input: { providerId: string; modelId: string; displayName: string; imageInput: boolean }): Promise<void>;
  removeModel(id: string): Promise<void>;
  saveAgent(input: AgentInput): Promise<void>;
  removeAgent(id: string): Promise<void>;
  removeConversation(id: string): Promise<void>;
  keyFor(provider: ProviderConfig): Promise<string | null>;
  keyFingerprint(provider: ProviderConfig): Promise<string | null>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const handle = await openDatabase();
        // A message left "streaming" belongs to a previous process that died
        // mid-answer; settle it so the UI cannot show a permanent spinner.
        await settleInterruptedMessages(handle);
        if (cancelled) return;
        setDb(handle);
        setSettings(await loadSettings(handle));
        setProviders(await listProviders(handle));
        setModels(await listModels(handle));
        setAgents(await listAgents(handle));
        setConversations(await listConversations(handle));
        setReady(true);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The local database could not be opened.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!db) return;
    setSettings(await loadSettings(db));
    setProviders(await listProviders(db));
    setModels(await listModels(db));
    setAgents(await listAgents(db));
    setConversations(await listConversations(db));
  }, [db]);

  const refreshConversations = useCallback(async () => {
    if (!db) return;
    setConversations(await listConversations(db));
  }, [db]);

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!db) return;
      const merged = normaliseSettings({ ...settings, ...patch });
      const saved = await saveSettings(db, merged);
      setSettings(saved);
    },
    [db, settings],
  );

  const addProvider = useCallback(
    async (input: { kind: ProviderConfig['kind']; name: string; baseUrl: string; apiKey: string }) => {
      if (!db) return;
      const preset = PROVIDER_PRESETS[input.kind];
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, '') || preset.defaultBaseUrl;
      if (!/^https:\/\//i.test(baseUrl)) {
        throw new Error('The endpoint must use HTTPS. Plain HTTP is not accepted for a remote host.');
      }
      const provider = await saveProvider(db, {
        kind: input.kind,
        name: input.name.trim() || preset.defaultName,
        baseUrl,
      });
      await setProviderKey(provider.id, provider.baseUrl, input.apiKey);
      // A fresh provider with no models is useless; seed the built-in hints so
      // the first message can be sent before discovery runs.
      const hints = MODEL_HINTS[input.kind] ?? [];
      for (const hint of hints) {
        await saveModel(db, {
          id: `hint:${provider.id}:${hint.modelId}`,
          providerId: provider.id,
          modelId: hint.modelId,
          displayName: hint.displayName,
          source: 'catalog',
          capabilities: hint.capabilities,
          limits: hint.limits,
          description: hint.description,
          supportedParams: hint.supportedParams,
          weirdnessSupported: hint.weirdnessSupported,
          baseUrlOverride: null,
        });
      }
      setProviders(await listProviders(db));
      setModels(await listModels(db));
    },
    [db],
  );

  const removeProvider = useCallback(
    async (id: string) => {
      if (!db) return;
      await clearProviderKey(id);
      await deleteProvider(db, id);
      setProviders(await listProviders(db));
      setModels(await listModels(db));
    },
    [db],
  );

  const discoverModels = useCallback(
    async (providerId: string) => {
      if (!db) return 0;
      const provider = providers.find((entry) => entry.id === providerId);
      if (!provider) throw new Error('That provider no longer exists.');
      const key = await getProviderKey(provider.id, provider.baseUrl);
      if (!key) throw new Error('Add an API key for this provider before discovering models.');

      const { registry } = await import('@/ai/client');
      const adapter = registry.get(provider.kind);
      const spec = adapter.buildListModelsRequest({
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: key,
        timeoutMs: 30_000,
      });
      if (!spec) throw new Error(`${adapter.label} does not expose a model list.`);

      const { mobileFetch } = await import('@/ai/transport');
      const response = await mobileFetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
      });
      const body = await response.text();
      const parsed = adapter.parseListModels(response.status, body);
      if (parsed.error) throw new Error(parsed.error.message);

      for (const model of parsed.models) {
        await saveModel(db, {
          id: `disc:${provider.id}:${model.modelId}`,
          providerId: provider.id,
          modelId: model.modelId,
          displayName: model.displayName,
          source: 'discovered',
          capabilities: model.capabilities,
          limits: model.limits,
          description: model.description,
          supportedParams: model.supportedParams,
          weirdnessSupported: model.weirdnessSupported,
          baseUrlOverride: null,
        });
      }
      setModels(await listModels(db));
      return parsed.models.length;
    },
    [db, providers],
  );

  const addCustomModel = useCallback(
    async (input: { providerId: string; modelId: string; displayName: string; imageInput: boolean }) => {
      if (!db) return;
      const provider = providers.find((entry) => entry.id === input.providerId);
      if (!provider) throw new Error('Choose a provider first.');
      await saveModel(db, {
        id: `custom:${provider.id}:${input.modelId.trim()}`,
        providerId: provider.id,
        modelId: input.modelId.trim(),
        displayName: input.displayName.trim() || input.modelId.trim(),
        source: 'custom',
        capabilities: { chat: true, streaming: true, imageInput: input.imageInput, toolCalling: false },
        limits: {},
        description: 'Added by hand on this device.',
        supportedParams: ['temperature', 'topP', 'maxOutputTokens'],
        weirdnessSupported: false,
        baseUrlOverride: null,
      });
      setModels(await listModels(db));
    },
    [db, providers],
  );

  const removeModel = useCallback(
    async (id: string) => {
      if (!db) return;
      const { deleteModel } = await import('@/db/database');
      await deleteModel(db, id);
      setModels(await listModels(db));
    },
    [db],
  );

  const saveAgentAction = useCallback(
    async (input: AgentInput) => {
      if (!db) return;
      await saveAgent(db, input);
      setAgents(await listAgents(db));
    },
    [db],
  );

  const removeAgentAction = useCallback(
    async (id: string) => {
      if (!db) return;
      await deleteAgent(db, id);
      setAgents(await listAgents(db));
    },
    [db],
  );

  const removeConversationAction = useCallback(
    async (id: string) => {
      if (!db) return;
      await deleteConversation(db, id);
      setConversations(await listConversations(db));
    },
    [db],
  );

  const keyFor = useCallback(
    async (provider: ProviderConfig) => getProviderKey(provider.id, provider.baseUrl),
    [],
  );

  const keyFingerprint = useCallback(async (provider: ProviderConfig) => {
    const key = await getProviderKey(provider.id, provider.baseUrl);
    return key === null ? null : fingerprint(key);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      error,
      db,
      settings,
      providers,
      models,
      agents,
      conversations,
      refresh,
      refreshConversations,
      patchSettings,
      addProvider,
      removeProvider,
      discoverModels,
      addCustomModel,
      removeModel,
      saveAgent: saveAgentAction,
      removeAgent: removeAgentAction,
      removeConversation: removeConversationAction,
      keyFor,
      keyFingerprint,
    }),
    [
      ready, error, db, settings, providers, models, agents, conversations,
      refresh, refreshConversations, patchSettings, addProvider, removeProvider,
      discoverModels, addCustomModel, removeModel, saveAgentAction,
      removeAgentAction, removeConversationAction, keyFor, keyFingerprint,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
