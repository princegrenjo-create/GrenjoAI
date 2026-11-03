/**
 * The update driver: the only module that knows electron-updater exists.
 *
 * Everything else — the service, the IPC layer, the UI, the tests — talks to the
 * `UpdateDriver` port below, so a test can drive every state without a network,
 * without Electron and without a packaged build. That split is what makes
 * "update failed" and "invalid release metadata" testable at all: electron-updater
 * emits those as events from the inside of a download, and there is no way to
 * provoke them from a unit test otherwise.
 */
import type { UpdateProgress } from '@shared/updates';

/*
 * The main bundle is CommonJS (see vite.main.config.ts), so `require` exists at
 * runtime and electron-updater stays external — it is resolved from node_modules
 * inside the asar rather than bundled. Declaring it here keeps the load out of the
 * bundler's import graph, which is what makes the dependency optional: a build
 * without it degrades to "updates are not available" instead of failing to start.
 */
declare const require: (id: string) => unknown;

/** The parts of electron-updater's UpdateInfo this app uses. */
export interface UpdateRelease {
  version: string;
  releaseNotes: string | null;
  releaseDate: string | null;
}

export interface UpdateDriverCallbacks {
  onChecking(): void;
  onAvailable(release: UpdateRelease): void;
  onNotAvailable(release: UpdateRelease | null): void;
  onProgress(progress: UpdateProgress): void;
  onDownloaded(release: UpdateRelease): void;
  onError(error: unknown): void;
}

export interface UpdateDriver {
  readonly currentVersion: string;
  /** False when this build cannot check at all (dev run, portable copy, no feed). */
  readonly canCheck: boolean;
  /** Why `canCheck` is false, in a sentence the UI can show verbatim. */
  readonly unsupportedReason: string | null;
  /** Called once, before any check. */
  configure(callbacks: UpdateDriverCallbacks): void;
  check(): Promise<void>;
  download(): Promise<void>;
  /** Restarts the app into the downloaded version. Only ever called on user action. */
  quitAndInstall(): void;
  dispose(): void;
}

/**
 * Release notes arrive as a string, an array of per-version notes, or nothing.
 * They can contain HTML; this app renders them as plain text, so tags are reduced
 * to their text and the rest is left alone. Never `dangerouslySetInnerHTML`.
 */
export function normaliseReleaseNotes(notes: unknown): string | null {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && 'note' in entry) {
            return String((entry as { note?: unknown }).note ?? '');
          }
          return '';
        })
        .filter((part) => part.length > 0)
        .join('\n\n');
    }
    return '';
  };

  const text = flatten(notes)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text.slice(0, 8000) : null;
}

/**
 * Builds the real driver, or null when updates cannot work in this process.
 *
 * electron-updater is required lazily: a development run, or a copy where the
 * module is missing, must degrade to "updates are not available" instead of
 * failing the whole app at startup. It is also kept out of the bundle (see
 * vite.main.config.ts) and shipped as a production dependency.
 */
export function createElectronUpdateDriver(options: {
  isPackaged: boolean;
  appVersion: string;
  /** Injected so a test can exercise the mapping without Electron. */
  loadUpdater?: () => unknown;
}): UpdateDriver {
  const { isPackaged, appVersion } = options;

  if (!isPackaged) {
    return {
      currentVersion: appVersion,
      canCheck: false,
      unsupportedReason:
        'This is a development build, so there is no update feed to check. Install the app to receive updates.',
      configure: () => undefined,
      check: async () => undefined,
      download: async () => undefined,
      quitAndInstall: () => undefined,
      dispose: () => undefined,
    };
  }

  type UpdaterLike = {
    currentVersion: { version: string };
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowPrerelease: boolean;
    allowDowngrade: boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  };

  let updater: UpdaterLike | null = null;
  let callbacks: UpdateDriverCallbacks | null = null;
  let unavailableReason: string | null = null;

  const load = (): UpdaterLike | null => {
    if (updater) return updater;
    try {
      const loaded = options.loadUpdater
        ? options.loadUpdater()
        : (require('electron-updater') as { autoUpdater?: UpdaterLike }).autoUpdater;
      if (!loaded) {
        unavailableReason = 'The update component is missing from this installation.';
        return null;
      }
      updater = loaded as UpdaterLike;
      return updater;
    } catch (error) {
      unavailableReason =
        'The update component could not be loaded, so this build cannot check for updates.';
      callbacks?.onError(error);
      return null;
    }
  };

  const toRelease = (info: unknown): UpdateRelease => {
    const record = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
    return {
      version: typeof record.version === 'string' ? record.version : '',
      releaseNotes: normaliseReleaseNotes(record.releaseNotes),
      releaseDate: typeof record.releaseDate === 'string' ? record.releaseDate : null,
    };
  };

  return {
    get currentVersion(): string {
      return appVersion;
    },
    get canCheck(): boolean {
      return unavailableReason === null;
    },
    get unsupportedReason(): string | null {
      return unavailableReason;
    },

    configure(next: UpdateDriverCallbacks) {
      callbacks = next;
      const instance = load();
      if (!instance) return;
      /*
       * Deliberately explicit: nothing downloads or installs without the user
       * asking. electron-updater's defaults would download on check and install
       * on quit, which is exactly the forced-update behaviour this app must not
       * have.
       */
      instance.autoDownload = false;
      instance.autoInstallOnAppQuit = false;
      instance.allowPrerelease = false;
      instance.allowDowngrade = false;

      instance.on('checking-for-update', () => callbacks?.onChecking());
      instance.on('update-available', (info) => callbacks?.onAvailable(toRelease(info)));
      instance.on('update-not-available', (info) => callbacks?.onNotAvailable(toRelease(info)));
      instance.on('download-progress', (progress) => {
        const record = (typeof progress === 'object' && progress !== null ? progress : {}) as Record<
          string,
          unknown
        >;
        const percent = typeof record.percent === 'number' ? record.percent : 0;
        callbacks?.onProgress({
          percent: Math.max(0, Math.min(100, Math.round(percent * 10) / 10)),
          transferred: typeof record.transferred === 'number' ? record.transferred : 0,
          total: typeof record.total === 'number' ? record.total : 0,
          bytesPerSecond:
            typeof record.bytesPerSecond === 'number' && record.bytesPerSecond > 0
              ? record.bytesPerSecond
              : null,
        });
      });
      instance.on('update-downloaded', (info) => callbacks?.onDownloaded(toRelease(info)));
      instance.on('error', (error) => callbacks?.onError(error));
    },

    async check() {
      const instance = load();
      if (!instance) throw new Error(unavailableReason ?? 'Updates are unavailable.');
      await instance.checkForUpdates();
    },

    async download() {
      const instance = load();
      if (!instance) throw new Error(unavailableReason ?? 'Updates are unavailable.');
      await instance.downloadUpdate();
    },

    quitAndInstall() {
      // (isSilent, isForceRunAfter): restart into the new version after installing.
      updater?.quitAndInstall(false, true);
    },

    dispose() {
      updater = null;
      callbacks = null;
    },
  };
}
