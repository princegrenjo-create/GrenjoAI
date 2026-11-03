/**
 * Application entry point.
 *
 * Boot order matters and is deliberate:
 *   1. harden the process before any window exists,
 *   2. resolve a stable user-data directory outside the install tree,
 *   3. open the database and run migrations,
 *   4. build the credential store (the OS store is only available after ready),
 *   5. wire services and the validated IPC surface,
 *   6. create the window,
 *   7. release every resource on quit.
 *
 * No step here may be reordered casually: `safeStorage` before `ready` throws,
 * and the database must be open before any IPC handler can be invoked.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app, dialog, Menu, net, safeStorage, shell } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import type { AppInfo, AppPaths, AppSettings } from '@shared/types';
import { createLogger, type Logger } from './logger';
import { installGlobalHardening } from './security';
import { createMainWindow, resolveRendererEntry } from './window';
import { createCredentialStore, type CredentialStore, type EncryptionBackend } from './credentials';
import { openDatabase } from './db';
import { createProviderService } from './services/providers';
import { createModelService } from './services/models';
import { createSettingsService } from './services/settings';
import { createSyncController } from './services/sync';
import { createChatService } from './chat/service';
import { createRegistry } from './providers/registry';
import { createProviderTransport } from './providers/transport';
import { registerIpcHandlers, sendToWindow } from './ipc/register';
import { createAttachmentService } from './attachments/service';
import { createAttachmentStore } from './attachments/store';
import { createTranscriptionService } from './transcription/service';
import { MediaStore } from './media/store';
import { createMediaService, type MediaService } from './media/service';
import { createMediaAdapterRegistry } from './media/registry';
import { installMediaProtocol, registerMediaScheme } from './media/protocol';
import { resolveUserDataDir } from './profile';
import {
  createCredentialSessionStorage,
  createSupabaseClientFactory,
  createSyncEngine,
} from './sync';
import { IPC } from '@shared/api';
import { DEFAULT_SETTINGS, SUPABASE_KEY_ACCOUNT } from '@shared/defaults';
import { AppError, appError } from '@shared/errors';
import { validateEndpointUrl } from '@shared/url-policy';

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;

let mainWindow: BrowserWindow | null = null;
let logger: Logger | null = null;
let shutdown: (() => void) | null = null;

/**
 * Profile selection runs before anything that can create the default profile
 * folder (the single-instance lock does exactly that), so the migration sees the
 * real state of the disk.
 */
const profileStartup = resolveUserDataDir(app.getPath('appData'));
app.setPath('userData', profileStartup.dir);

/*
 * The media scheme must be registered before the app is ready: Chromium fixes its
 * scheme table at startup, and a later registration is silently ignored. The
 * handler is installed once the store exists, inside bootstrap.
 */
registerMediaScheme();

// A single instance keeps one writer on the SQLite file and one credential file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Must precede `ready`: sandbox every renderer, including any future one.
  app.enableSandbox();
  app.setAppUserModelId('com.grenjo.aitool');

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error('Fatal error during startup', { message });
    // The window does not exist yet, so the only honest channel is the log plus
    // a non-zero exit. A failed bootstrap must not look like an empty app.
    process.exitCode = 1;
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });

  app.on('before-quit', () => {
    shutdown?.();
  });

  process.on('uncaughtException', (error) => {
    logger?.error('Uncaught exception', { message: error.message });
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error('Unhandled rejection', { reason: String(reason) });
  });
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const paths: AppPaths = {
    userData,
    database: path.join(userData, 'data', 'app.db'),
    logs: path.join(userData, 'logs', 'main.log'),
    credentials: path.join(userData, 'credentials.bin'),
  };

  logger = createLogger({
    filePath: paths.logs,
    level: isDev ? 'debug' : 'info',
    echo: isDev,
  });
  const log = logger;
  log.info('Starting Grenjo AI Tool', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    userData,
    profile: profileStartup.migration,
  });
  if (profileStartup.migration === 'renamed') {
    log.info('Renamed the profile folder from the previous product name', { userData });
  }
  if (profileStartup.migration === 'copied') {
    log.info(
      'Copied the previous profile into the new folder; the old folder was left untouched',
      { userData },
    );
  }
  if (profileStartup.migration === 'kept-legacy') {
    log.warn(
      'Could not migrate the previous profile folder (in use?); continuing with it so no data is lost',
      { userData },
    );
  }

  // --- database -----------------------------------------------------------
  const db = openDatabase(paths.database, { logger: log.child('db') });
  log.info('Database ready', { version: db.migrations.version() });

  // A message left in `streaming` means the previous run ended mid-answer (a
  // crash, or a quit during generation). Leaving it would make the UI show a
  // permanent spinner, so it is settled as stopped on the next launch.
  try {
    const recovered = db.sql.run(
      "UPDATE messages SET status = 'stopped', updated_at = ? WHERE status = 'streaming'",
      [new Date().toISOString()],
    );
    if (recovered.changes > 0) {
      log.warn('Marked an interrupted streaming message as stopped', {
        count: recovered.changes,
      });
    }
  } catch (error) {
    log.warn('Could not settle an interrupted streaming message', { error });
  }

  // --- settings -----------------------------------------------------------
  let currentSettings: AppSettings = db.settings.get();
  if (!currentSettings || typeof currentSettings !== 'object') {
    currentSettings = DEFAULT_SETTINGS;
  }
  log.setLevel(currentSettings.advanced.logLevel ?? (isDev ? 'debug' : 'info'));

  // --- credentials --------------------------------------------------------
  const safeStorageBackend: EncryptionBackend = {
    kind: 'dpapi-safe-storage',
    isAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (cipher: Buffer) => safeStorage.decryptString(cipher),
  };
  const credentials: CredentialStore = createCredentialStore({
    filePath: paths.credentials,
    backend: safeStorageBackend,
    logger: log.child('credentials'),
  });
  if (!credentials.isAvailable()) {
    log.warn(
      'OS credential encryption is unavailable. API keys cannot be saved until it is; nothing will be written in plain text.',
    );
  }

  // --- services -----------------------------------------------------------
  const settingsService = createSettingsService({
    db,
    logger: log,
    onChanged: (next) => {
      currentSettings = next;
      log.setLevel(next.advanced.logLevel);
    },
  });
  const readSettings = (): AppSettings => currentSettings;

  const registry = createRegistry();
  const transport = createProviderTransport();

  const providerService = createProviderService({
    db,
    credentials,
    registry,
    transport,
    settings: readSettings,
    logger: log,
  });
  const modelService = createModelService({
    db,
    credentials,
    registry,
    transport,
    settings: readSettings,
    logger: log,
  });

  /*
   * Attachments and transcription.
   *
   * The picker is the only place that touches `dialog`; the attachment service
   * itself is Electron-free so it can be tested, and so a future web client can
   * supply its own file source.
   */
  const transcriptionService = createTranscriptionService({
    db,
    credentials,
    registry,
    transport,
    logger: log,
  });
  const attachmentStore = createAttachmentStore({
    directory: path.join(userData, 'attachments'),
    logger: log,
  });
  const attachmentService = createAttachmentService({
    store: attachmentStore,
    logger: log,
    transcription: transcriptionService,
    dialogs: {
      pickFiles: async (filters) => {
        /*
         * The filter list is built by the attachment service from the
         * extractor's own format tables, so the dialog offers exactly the types
         * the service accepts. This closure only hands it to Electron: a pick
         * with no kinds arrives as `undefined` and the dialog is unchanged.
         */
        const options: OpenDialogOptions = {
          title: 'Attach files',
          buttonLabel: 'Attach',
          properties: ['openFile', 'multiSelections'],
          ...(filters === undefined
            ? {}
            : {
                filters: filters.map((filter) => ({
                  name: filter.name,
                  extensions: [...filter.extensions],
                })),
              }),
        };
        const window = mainWindow;
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        return { canceled: result.canceled, paths: result.filePaths };
      },
    },
  });

  const chatService = createChatService({
    db,
    credentials,
    registry,
    transport,
    settings: readSettings,
    logger: log,
    isOnline: () => {
      try {
        return net.isOnline();
      } catch {
        return true;
      }
    },
    emit: (event) => {
      sendToWindow(mainWindow, IPC.chatEvent, event);
    },
    attachments: attachmentService,
  });

  /*
   * Generated media.
   *
   * The store lives inside the profile (next to the database and the logs), so a
   * moved or renamed profile keeps its images. The adapter registry is empty in
   * this build: the image adapters register themselves here, and until one is
   * registered the service refuses a generation with a sentence that says so
   * rather than failing three layers down.
   */
  const mediaStore = new MediaStore({ rootDir: path.join(userData, 'media') });
  const mediaAdapters = createMediaAdapterRegistry();
  const mediaService: MediaService = createMediaService({
    db,
    store: mediaStore,
    adapterFor: (providerId) => mediaAdapters.get(providerId),
    settings: readSettings,
    logger: log.child('media'),
    dialogs: {
      async chooseExportPath(suggestedName) {
        const options = {
          title: 'Export generated media',
          defaultPath: suggestedName,
          buttonLabel: 'Save',
        };
        // The window overload is only available once a window exists; the call
        // happens from a user action, so it does.
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      revealInFolder(absolutePath) {
        shell.showItemInFolder(absolutePath);
      },
    },
    onJobChange: (job) => {
      sendToWindow(mainWindow, IPC.mediaEvent, job);
    },
  });
  installMediaProtocol(mediaStore);
  mediaService.start();

  // Cloud sync is optional. The engine is constructed here because it needs the
  // database and the credential store, but `start()` — the only call that touches
  // the network — runs only when the owner has switched sync on.
  let syncEngine: ReturnType<typeof createSyncEngine> | null = null;
  try {
    syncEngine = createSyncEngine({
      db,
      clientFactory: createSupabaseClientFactory({
        storage: createCredentialSessionStorage({
          read: (account) => credentials.get(account),
          write: (account, value) => {
            credentials.set(account, value);
          },
          remove: (account) => {
            credentials.delete(account);
          },
        }),
      }),
      credentialProvider: async () => {
        const url = currentSettings.sync.supabaseUrl;
        const anonKey = credentials.get(SUPABASE_KEY_ACCOUNT);
        return url.length > 0 && anonKey ? { url, anonKey } : null;
      },
      onStatus: (status) => {
        sendToWindow(mainWindow, IPC.syncStatusEvent, status);
      },
      isOnline: () => {
        try {
          return net.isOnline();
        } catch {
          return true;
        }
      },
      isEnabled: () => currentSettings.sync.enabled,
    });
  } catch (error) {
    log.warn('Cloud sync engine could not be constructed; sync stays off', { error });
    syncEngine = null;
  }

  const syncController = createSyncController({
    engine: syncEngine,
    isEnabled: () => currentSettings.sync.enabled,
    isConfigured: () => currentSettings.sync.supabaseUrl.length > 0,
    isOnline: () => {
      try {
        return net.isOnline();
      } catch {
        return true;
      }
    },
    saveConfig: async (input) => {
      const check = validateEndpointUrl(input.supabaseUrl, {
        requireHttps: true,
        allowInsecureLocalhost: currentSettings.advanced.allowInsecureLocalhost,
      });
      if (!check.ok) {
        throw new AppError(
          appError('validation', `Supabase URL rejected: ${check.reason}`),
        );
      }
      credentials.set(SUPABASE_KEY_ACCOUNT, input.anonKey.trim());
      await settingsService.patch({ sync: { enabled: true, supabaseUrl: check.url } });
    },
  });

  const appInfo = (): AppInfo => ({
    name: 'Grenjo AI Tool',
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: paths.userData,
    databasePath: paths.database,
    logPath: paths.logs,
    packaged: app.isPackaged,
    secureStorageAvailable: credentials.isAvailable(),
  });

  // --- hardening + window -------------------------------------------------
  // The allowed origin is exact, not the loose `file://` scheme: a navigation to
  // any other local file must be refused just as firmly as a remote one.
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  const allowedOrigin = DEV_SERVER_URL ?? `${pathToFileURL(rendererRoot).href}/`;
  installGlobalHardening({ isDev, allowedOrigin, logger: log.child('security') });

  registerIpcHandlers({
    db,
    providers: providerService,
    models: modelService,
    settings: settingsService,
    chat: chatService,
    attachments: attachmentService,
    credentials,
    sync: syncController,
    media: mediaService,
    appInfo,
    paths,
    logger: log,
    getWindow: () => mainWindow,
    quit: () => app.quit(),
  });

  Menu.setApplicationMenu(
    isDev
      ? Menu.buildFromTemplate([
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
            ],
          },
        ])
      : null,
  );

  mainWindow = createMainWindow({
    preloadPath: path.join(__dirname, '..', 'preload', 'index.cjs'),
    devServerUrl: DEV_SERVER_URL,
    rendererEntry: resolveRendererEntry(path.join(__dirname, '..')),
    isDev,
    logger: log.child('window'),
    onRendererGone: () => {
      log.error('Renderer is gone; the window will be recreated on next launch');
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  // A packaged-app self check. Verifies from inside the shipped runtime that the
  // preload bridge exists, that Node is NOT reachable from the renderer, that
  // React mounted, and that the CSP meta tag survived the build. The result is
  // written to a file because a GUI process's stdout is not reliable on Windows.
  const smokeOut = process.argv.find((arg) => arg.startsWith('--smoke-out='));
  const attachProbe = process.argv.find((arg) => arg.startsWith('--attach-probe='));
  if (process.argv.includes('--smoke-test')) {
    await runSmokeTest(
      mainWindow,
      smokeOut ? smokeOut.slice('--smoke-out='.length) : null,
      appInfo(),
      log.child('smoke'),
      // Proves from inside the shipped runtime that the document parsers really
      // load, instead of only in a Node test process.
      attachProbe ? attachProbe.slice('--attach-probe='.length) : null,
    );
  }

  let closed = false;
  shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      chatService.dispose();
    } catch (error) {
      log.warn('Error disposing the chat service', { error });
    }
    try {
      syncController.dispose();
    } catch (error) {
      log.warn('Error disposing the sync controller', { error });
    }
    try {
      // Pending attachments are transient: the on-disk mirror is cleaned up so an
      // unsent file does not outlive the session. Sent ones are already persisted.
      attachmentService.dispose();
    } catch (error) {
      log.warn('Error disposing the attachment service', { error });
    }
    try {
      db.checkpoint();
      db.close();
      log.info('Database closed');
    } catch (error) {
      log.error('Error closing the database', { error });
    }
    log.close();
  };

  log.info('Startup complete');

  // Only now touch the network, and only if the owner asked for sync.
  if (syncEngine && currentSettings.sync.enabled) {
    void syncEngine.start().catch((error: unknown) => {
      log.warn('Cloud sync did not start', { error });
    });
  }
}

interface SmokeProbe {
  apiType: string;
  hasChatSend: boolean;
  requireType: string;
  processType: string;
  rootChildren: number;
  title: string;
  cspPresent: boolean;
}

/**
 * Runs the packaged-app self check, writes the result, then exits with a code
 * that the smoke script can assert on.
 */
async function runSmokeTest(
  window: BrowserWindow,
  outputPath: string | null,
  info: AppInfo,
  log: Logger,
  attachProbePath: string | null,
): Promise<never> {
  const result: Record<string, unknown> = {
    ok: false,
    at: new Date().toISOString(),
    app: info,
    probe: null,
    attachmentProbe: null,
    error: null,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the renderer did not finish loading within 25s')),
        25000,
      );
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Give the renderer one frame plus a little room to mount.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const probe = (await window.webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById('root');
        return {
          apiType: typeof window.api,
          hasChatSend: typeof (window.api && window.api.chat && window.api.chat.send) === 'function',
          requireType: typeof window.require,
          processType: typeof window.process,
          rootChildren: root ? root.childElementCount : -1,
          title: document.title,
          cspPresent: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
        };
      })()`,
      true,
    )) as SmokeProbe;

    result.probe = probe;
    result.ok =
      probe.apiType === 'object' &&
      probe.hasChatSend &&
      probe.requireType === 'undefined' &&
      probe.processType === 'undefined' &&
      probe.rootChildren > 0 &&
      probe.cspPresent;
    log.info('Smoke probe result', { ...probe, ok: result.ok });

    if (attachProbePath) {
      // Optional: extract a real document through the shipped parsers. This is
      // what proves pdfjs and mammoth load from inside the packaged app rather
      // than only in a test process.
      const { extractText } = await import('./attachments/extract');
      const output = await extractText({
        filePath: attachProbePath,
        name: path.basename(attachProbePath),
        mimeType: '',
        sizeBytes: fs.statSync(attachProbePath).size,
      });
      result.attachmentProbe = {
        status: output.contentStatus,
        chars: output.text?.length ?? 0,
        note: output.note,
        head: output.text?.slice(0, 40) ?? null,
      };
      log.info('Attachment extraction probe', result.attachmentProbe as Record<string, unknown>);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log.error('Smoke probe failed', { error: result.error });
  }

  if (outputPath) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
    } catch (error) {
      log.error('Could not write the smoke result file', { error });
    }
  }

  const code = result.ok ? 0 : 1;
  app.exit(code);
  // `app.exit` does not return, but the type system does not know that.
  return new Promise<never>(() => undefined);
}
