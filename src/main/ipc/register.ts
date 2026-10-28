/**
 * IPC handler registration.
 *
 * Every handler is registered through one wrapper that:
 *  - rejects a message that did not come from the app's own window,
 *  - validates the payload with the shared zod schema before any side effect,
 *  - returns a serialisable envelope instead of throwing across the bridge, so
 *    the renderer receives the error *code* rather than a stringified stack.
 *
 * No handler accepts a model id, a URL or a limit that has not been schema
 * checked: the renderer is a web page, and a rendering bug must not be able to
 * turn into a write of arbitrary data.
 */
import { ipcMain, shell, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/api';
import { AppError, appError } from '@shared/errors';
import { createInvoker } from './handler';
import {
  agentInputSchema,
  attachmentIngestSchema,
  chatSendSchema,
  conversationCreateSchema,
  conversationPatchSchema,
  customModelInputSchema,
  discoveredModelsSchema,
  generationParamsSchema,
  modelRefSchema,
  providerInputSchema,
  settingsPatchSchema,
  syncAuthSchema,
  syncConfigSchema,
  syncResolveSchema,
  transcriptionInputSchema,
} from '@shared/schemas';
import { isExternalLinkAllowed } from '@shared/url-policy';
import type { AgentInput, AppInfo, AppPaths, AppSettingsPatch, ChatSendInput, ConversationCreateInput, ConversationPatch, CustomModelInput, ProviderInput } from '@shared/types';
import type { Database } from '@shared/repository-contract';
import type { Logger } from '../logger';
import type { ProviderService } from '../services/providers';
import type { ModelService } from '../services/models';
import type { SettingsService } from '../services/settings';
import type { ChatService } from '../chat/service';
import type { CredentialStore } from '../credentials';
import type { SyncController } from '../services/sync';
import type { AttachmentService } from '../attachments/service';

export interface IpcDependencies {
  db: Database;
  providers: ProviderService;
  models: ModelService;
  settings: SettingsService;
  chat: ChatService;
  attachments: AttachmentService;
  credentials: CredentialStore;
  sync: SyncController;
  appInfo: () => AppInfo;
  paths: AppPaths;
  logger: Logger;
  getWindow: () => BrowserWindow | null;
  quit: () => void;
}

type Handler<TIn> = (input: TIn) => unknown | Promise<unknown>;

const idSchema = z.string().trim().min(1).max(128);
const optionalIdSchema = z.string().trim().max(128).nullish();
const listOptionsSchema = z
  .object({
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .nullish();

export function registerIpcHandlers(deps: IpcDependencies): void {
  const {
    db,
    providers,
    models,
    settings,
    chat,
    credentials,
    sync,
    appInfo,
    paths,
    logger,
    getWindow,
  } = deps;
  const log = logger.child('ipc');
  let registered = 0;

  function assertSender(senderId: number): void {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      throw new AppError(appError('storage', 'The application window is not available.'));
    }
    if (senderId !== window.webContents.id) {
      log.warn('Rejected an IPC call from an unexpected web contents', { sender: senderId });
      throw new AppError(appError('validation', 'Untrusted caller.'));
    }
  }

  function handle<TIn, TOut>(
    channel: string,
    schema: z.ZodType<TIn> | null,
    handler: Handler<TIn>,
  ): void {
    registered += 1;
    const invoke = createInvoker<TIn, TOut>({
      schema,
      handler: handler as (input: TIn) => TOut | Promise<TOut>,
      assertSender,
      label: channel,
      logger: log,
    });
    ipcMain.handle(channel, (event, raw: unknown) => invoke(raw, event.sender.id));
  }

  /* ------------------------------------------------------- conversations -- */

  handle(IPC.conversationsList, listOptionsSchema, (options) =>
    db.conversations.list({
      ...(typeof options?.search === 'string' && options.search.length > 0
        ? { search: options.search }
        : {}),
      limit: options?.limit ?? 200,
    }),
  );
  handle(IPC.conversationsGet, idSchema, (id: string) => {
    const conversation = db.conversations.get(id);
    if (!conversation) {
      throw new AppError(appError('not_found', 'That conversation no longer exists.'));
    }
    return { conversation, messages: db.messages.listByConversation(id) };
  });
  handle(IPC.conversationsCreate, conversationCreateSchema, (input) =>
    db.conversations.create(input as ConversationCreateInput),
  );
  handle(
    IPC.conversationsUpdate,
    z.object({ id: idSchema, patch: conversationPatchSchema }),
    ({ id, patch }: { id: string; patch: ConversationPatch }) => db.conversations.update(id, patch),
  );
  handle(IPC.conversationsRemove, idSchema, (id: string) => {
    db.conversations.softDelete(id);
    return { removed: true };
  });

  handle(IPC.messagesList, idSchema, (id: string) => db.messages.listByConversation(id));

  /* --------------------------------------------------------- attachments -- */

  handle(IPC.attachmentsPick, null, () => deps.attachments.pick());
  handle(IPC.attachmentsIngestBytes, attachmentIngestSchema, (input) =>
    deps.attachments.ingestBytes(input),
  );
  handle(IPC.attachmentsGet, idSchema, (id: string) => deps.attachments.get(id));
  handle(IPC.attachmentsRemove, idSchema, async (id: string) => {
    await deps.attachments.remove(id);
    return { removed: true };
  });
  handle(IPC.attachmentsReadImage, idSchema, (id: string) => deps.attachments.readImage(id));
  handle(IPC.attachmentsTranscribe, transcriptionInputSchema, (input) =>
    deps.attachments.transcribe(input),
  );
  handle(IPC.attachmentsTranscriptionStatus, null, () => deps.attachments.transcriptionStatus());

  /* ---------------------------------------------------------------- chat -- */

  handle(IPC.chatSend, chatSendSchema, (input) => chat.send(input as ChatSendInput));
  handle(IPC.chatStop, idSchema, async (requestId: string) => {
    await chat.stop(requestId);
    return { stopped: true };
  });

  /* ----------------------------------------------------------- providers -- */

  handle(IPC.providersList, null, () => providers.list());
  handle(IPC.providersUpsert, providerInputSchema, (input) =>
    providers.upsert(input as ProviderInput),
  );
  handle(IPC.providersRemove, idSchema, async (id: string) => {
    await providers.remove(id);
    return { removed: true };
  });
  handle(
    IPC.providersSetKey,
    z.object({ id: idSchema, apiKey: z.string().min(1).max(4096) }),
    ({ id, apiKey }: { id: string; apiKey: string }) => providers.setKey(id, apiKey),
  );
  handle(IPC.providersClearKey, idSchema, (id: string) => providers.clearKey(id));
  handle(IPC.providersTest, idSchema, (id: string) => providers.test(id));
  handle(IPC.providersDiscoverModels, idSchema, (id: string) => providers.discoverModels(id));

  /* -------------------------------------------------------------- models -- */

  handle(IPC.modelsList, optionalIdSchema, (providerId) =>
    models.list(typeof providerId === 'string' && providerId.length > 0 ? providerId : undefined),
  );
  handle(IPC.modelsUpsert, customModelInputSchema, (input) =>
    models.upsert(input as CustomModelInput),
  );
  handle(IPC.modelsRemove, idSchema, async (id: string) => {
    await models.remove(id);
    return { removed: true };
  });
  handle(IPC.modelsSaveDiscovered, discoveredModelsSchema, (input) => {
    const parsed = discoveredModelsSchema.parse(input);
    return models.saveDiscovered(parsed.providerId, parsed.models);
  });
  handle(IPC.modelsClearDiscovered, idSchema, async (providerId: string) => {
    await models.clearDiscovered(providerId);
    return { cleared: true };
  });
  handle(
    IPC.modelsTest,
    z.object({ ref: modelRefSchema, prompt: z.string().max(2000).optional() }),
    ({ ref, prompt }: { ref: { providerId: string; modelId: string }; prompt?: string }) =>
      models.test(ref, prompt),
  );

  /* -------------------------------------------------------------- agents -- */

  handle(IPC.agentsList, null, () => db.agents.list());
  handle(IPC.agentsGet, idSchema, (id: string) => {
    const agent = db.agents.get(id);
    if (!agent) throw new AppError(appError('not_found', 'That agent no longer exists.'));
    return agent;
  });
  handle(IPC.agentsCreate, agentInputSchema, (input) => db.agents.create(input as AgentInput));
  handle(
    IPC.agentsUpdate,
    z.object({ id: idSchema, input: agentInputSchema }),
    ({ id, input }: { id: string; input: AgentInput }) => db.agents.update(id, input),
  );
  handle(IPC.agentsDuplicate, idSchema, (id: string) => db.agents.duplicate(id));
  handle(IPC.agentsRemove, idSchema, (id: string) => {
    db.agents.softDelete(id);
    return { removed: true };
  });

  /* ------------------------------------------------------------ settings -- */

  handle(IPC.settingsGet, null, () => settings.get());
  handle(IPC.settingsPatch, settingsPatchSchema, (patch) =>
    settings.patch(patch as AppSettingsPatch),
  );
  handle(IPC.settingsReset, null, () => settings.reset());
  handle(IPC.settingsExport, null, () => settings.exportConfig());
  handle(IPC.settingsImport, z.object({ json: z.string().min(2) }), ({ json }: { json: string }) =>
    settings.importConfig(json),
  );

  /* ---------------------------------------------------------------- sync -- */

  handle(IPC.syncStatus, null, () => sync.status());
  handle(IPC.syncConfigure, syncConfigSchema, (input) => sync.configure(input));
  handle(IPC.syncSignIn, syncAuthSchema, (input) => sync.signIn(input));
  handle(IPC.syncSignUp, syncAuthSchema, (input) => sync.signUp(input));
  handle(IPC.syncSignOut, null, () => sync.signOut());
  handle(IPC.syncNow, null, () => sync.syncNow());
  handle(IPC.syncConflicts, null, () => sync.conflicts());
  handle(IPC.syncResolveConflict, syncResolveSchema, ({ id, resolution }) =>
    sync.resolveConflict(id, resolution),
  );

  /* ----------------------------------------------------------------- app -- */

  handle(IPC.appInfo, null, () => appInfo());
  handle(IPC.appPaths, null, () => paths);
  handle(IPC.appOpenExternal, z.string().max(2048), async (url: string) => {
    if (!isExternalLinkAllowed(url)) {
      throw new AppError(appError('validation', 'Only HTTPS links can be opened externally.'));
    }
    await shell.openExternal(url);
    return { opened: true };
  });
  handle(IPC.appQuit, null, () => {
    deps.quit();
    return { quitting: true };
  });

  log.info('IPC handlers registered', {
    count: registered,
    secureStorageAvailable: credentials.isAvailable(),
  });
}

/** Sends a main -> renderer event, tolerating a closed window. */
export function sendToWindow(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}
