/**
 * Preload bridge.
 *
 * This file is the entire privileged surface the renderer can reach. It is
 * bundled to CommonJS because the renderer runs sandboxed, which only supports a
 * CommonJS preload, and it imports nothing but `electron` — no node built-ins, no
 * filesystem, no child processes.
 *
 * Every method is a thin, typed wrapper over one IPC channel. Errors come back
 * as an `Error` carrying the structured `appError` shape so the UI can branch on
 * a code (`invalid_key`, `rate_limited`, …) instead of matching a message.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '@shared/api';
import type { DesktopApi, IpcResult } from '@shared/api';
import { formatIpcErrorMessage } from '@shared/errors';

function isIpcResult(value: unknown): value is IpcResult<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, payload);
  if (!isIpcResult(result)) {
    throw new Error(`Malformed response from the main process on channel "${channel}".`);
  }
  if (result.ok) return result.data as T;
  // contextBridge keeps only the message of a thrown value, so the error code is
  // carried in the message as a `code: sentence` prefix and decoded by
  // `asAppError` on the renderer side. Attaching it as a property does not work.
  throw new Error(formatIpcErrorMessage(result.error));
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => {
    listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: DesktopApi = {
  conversations: {
    list: (options) => call(IPC.conversationsList, options),
    get: (id) => call(IPC.conversationsGet, id),
    create: (input) => call(IPC.conversationsCreate, input),
    update: (id, patch) => call(IPC.conversationsUpdate, { id, patch }),
    remove: (id) => call(IPC.conversationsRemove, id),
  },
  messages: {
    list: (conversationId) => call(IPC.messagesList, conversationId),
  },
  chat: {
    send: (input) => call(IPC.chatSend, input),
    stop: (requestId) => call(IPC.chatStop, requestId),
    onEvent: (listener) => subscribe(IPC.chatEvent, listener),
  },
  providers: {
    list: () => call(IPC.providersList),
    upsert: (input) => call(IPC.providersUpsert, input),
    remove: (id) => call(IPC.providersRemove, id),
    setKey: (id, apiKey) => call(IPC.providersSetKey, { id, apiKey }),
    clearKey: (id) => call(IPC.providersClearKey, id),
    test: (id) => call(IPC.providersTest, id),
    discoverModels: (id) => call(IPC.providersDiscoverModels, id),
  },
  models: {
    list: (providerId) => call(IPC.modelsList, providerId),
    upsert: (input) => call(IPC.modelsUpsert, input),
    remove: (id) => call(IPC.modelsRemove, id),
    saveDiscovered: (providerId, models) => call(IPC.modelsSaveDiscovered, { providerId, models }),
    clearDiscovered: (providerId) => call(IPC.modelsClearDiscovered, providerId),
    test: (ref, prompt) => call(IPC.modelsTest, { ref, prompt }),
  },
  agents: {
    list: () => call(IPC.agentsList),
    get: (id) => call(IPC.agentsGet, id),
    create: (input) => call(IPC.agentsCreate, input),
    update: (id, input) => call(IPC.agentsUpdate, { id, input }),
    duplicate: (id) => call(IPC.agentsDuplicate, id),
    remove: (id) => call(IPC.agentsRemove, id),
  },
  settings: {
    get: () => call(IPC.settingsGet),
    patch: (patch) => call(IPC.settingsPatch, patch),
    reset: () => call(IPC.settingsReset),
    exportConfig: () => call(IPC.settingsExport),
    importConfig: (json) => call(IPC.settingsImport, { json }),
  },
  sync: {
    status: () => call(IPC.syncStatus),
    configure: (input) => call(IPC.syncConfigure, input),
    signIn: (input) => call(IPC.syncSignIn, input),
    signUp: (input) => call(IPC.syncSignUp, input),
    signOut: () => call(IPC.syncSignOut),
    syncNow: () => call(IPC.syncNow),
    conflicts: () => call(IPC.syncConflicts),
    resolveConflict: (id, resolution) => call(IPC.syncResolveConflict, { id, resolution }),
    onStatus: (listener) => subscribe(IPC.syncStatusEvent, listener),
  },
  app: {
    info: () => call(IPC.appInfo),
    paths: () => call(IPC.appPaths),
    openExternal: (url) => call(IPC.appOpenExternal, url),
    quit: () => call(IPC.appQuit),
  },
};

contextBridge.exposeInMainWorld('api', api);
