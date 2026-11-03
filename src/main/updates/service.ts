/**
 * Update service: the state machine behind Settings -> About.
 *
 * Three rules shape everything here:
 *
 *  1. **Nothing happens without the user.** A check only checks. A download only
 *     downloads. `install()` is the one path to a restart, it requires the
 *     downloaded state, and only the UI calls it. The driver is configured with
 *     `autoDownload = false` and `autoInstallOnAppQuit = false`, so even a stray
 *     event cannot install anything.
 *  2. **One state machine, one source of truth.** Every consumer (IPC reply, the
 *     renderer event, the log line) reads `getState()`. There is no second copy
 *     of "is an update ready" anywhere.
 *  3. **Errors are sentences, not stack traces.** A failed check tells the user
 *     what happened and whether retrying could help; it never leaks a URL, a file
 *     path or a token into the UI.
 */
import { AppError, appError } from '@shared/errors';
import type { UpdateProgress, UpdateState } from '@shared/updates';
import type { UpdatesSettings } from '@shared/types';
import { normaliseReleaseNotes } from './driver';
import type { UpdateDriver, UpdateRelease } from './driver';

export interface UpdateServiceOptions {
  driver: UpdateDriver;
  settings: {
    get(): UpdatesSettings;
    setAutoCheck(enabled: boolean): Promise<void>;
  };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /** Called on every state change, for the renderer event. */
  onChange?: (state: UpdateState) => void;
  /** Injected so a test can drive the clock and the timers. */
  clock?: () => Date;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  /** Delay before the first automatic check, and between later ones. */
  autoCheckDelayMs?: number;
  autoCheckIntervalMs?: number;
}

export interface UpdateService {
  getState(): UpdateState;
  check(options?: { manual?: boolean }): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): void;
  setAutoCheck(enabled: boolean): Promise<UpdateState>;
  /** Arms the automatic check, when it is enabled. Safe to call once at startup. */
  start(): void;
  dispose(): void;
}

const DEFAULT_AUTO_DELAY_MS = 10_000;
const DEFAULT_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Maps a thrown updater error onto a sentence and an app error code. */
export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.toLowerCase();

  if (text.includes('net::') || text.includes('enotfound') || text.includes('etimedout') || text.includes('econn')) {
    return 'Could not reach the update server. Check your connection and try again.';
  }
  if (text.includes('404') || text.includes('no published versions') || text.includes('cannot find latest')) {
    return 'No published release was found for this build. Nothing is wrong with your installation.';
  }
  if (text.includes('sha512') || text.includes('checksum') || text.includes('integrity')) {
    return 'The downloaded file did not match its published checksum, so it was discarded. Try again, or download the installer from the releases page.';
  }
  if (text.includes('code signature') || text.includes('signature')) {
    return 'The update could not be verified. It was not installed.';
  }
  if (text.includes('eperm') || text.includes('eacces') || text.includes('access is denied')) {
    return 'Windows would not let the updater write to the install folder. Try running the app from the same account that installed it.';
  }
  if (text.includes('application is not packed') || text.includes('dev')) {
    return 'This build cannot check for updates.';
  }
  return raw.length > 0 && raw.length <= 240
    ? `The update failed: ${raw}`
    : 'The update failed for an unknown reason. Try again.';
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  const { driver, settings, logger } = options;
  const now = options.clock ?? (() => new Date());
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const autoDelay = options.autoCheckDelayMs ?? DEFAULT_AUTO_DELAY_MS;
  const autoInterval = options.autoCheckIntervalMs ?? DEFAULT_AUTO_INTERVAL_MS;

  let state: UpdateState = {
    status: driver.canCheck ? 'idle' : 'unsupported',
    currentVersion: driver.currentVersion,
    latestVersion: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    error: null,
    unsupportedReason: driver.unsupportedReason,
    checkedAt: null,
    autoCheck: settings.get().autoCheck,
    canCheck: driver.canCheck,
  };

  let timer: unknown = null;
  let started = false;
  let disposed = false;

  /*
   * Read the status through a function: the driver's callbacks mutate state while
   * an wait is suspended, which the compiler's flow analysis cannot see.
   */
  const statusNow = (): UpdateState['status'] => state.status;

  const emit = (): UpdateState => {
    options.onChange?.(state);
    return state;
  };

  const set = (patch: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...patch };
    return emit();
  };

  /*
   * The service normalises notes again even though the driver already did: the
   * text the UI shows is the service's responsibility, and a different driver
   * (a test double, a future provider) must not be able to put markup in front of
   * the user.
   */
  const applyRelease = (release: UpdateRelease): Partial<UpdateState> => ({
    latestVersion: release.version.length > 0 ? release.version : state.latestVersion,
    releaseNotes: normaliseReleaseNotes(release.releaseNotes),
    releaseDate: release.releaseDate,
  });

  /** Arms the next automatic check, if automatic checking is on. */
  const arm = (delayMs: number): void => {
    if (disposed || !driver.canCheck || !state.autoCheck) return;
    if (timer !== null) cancelSchedule(timer);
    timer = schedule(() => {
      timer = null;
      if (disposed || !state.autoCheck) return;
      void service
        .check({ manual: false })
        .catch(() => undefined)
        .finally(() => {
          arm(autoInterval);
        });
    }, delayMs);
  };

  driver.configure({
    onChecking: () => {
      set({ status: 'checking', error: null, progress: null });
    },
    onAvailable: (release) => {
      set({ status: 'available', progress: null, error: null, ...applyRelease(release) });
    },
    onNotAvailable: (release) => {
      set({
        status: 'not-available',
        progress: null,
        error: null,
        checkedAt: now().toISOString(),
        ...(release ? applyRelease(release) : {}),
      });
    },
    onProgress: (progress: UpdateProgress) => {
      set({ status: 'downloading', progress, error: null });
    },
    onDownloaded: (release) => {
      set({ status: 'ready', progress: null, error: null, ...applyRelease(release) });
    },
    onError: (error) => {
      // The driver reports load failures before any check; those are an
      // availability problem, not a failed check.
      if (!driver.canCheck) {
        set({ status: 'unsupported', unsupportedReason: driver.unsupportedReason, error: null });
        return;
      }
      logger.warn('Update check or download failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      set({ status: 'error', error: describeUpdateError(error), progress: null });
    },
  });

  const service: UpdateService = {
    getState(): UpdateState {
      return state;
    },

    async check(input = {}) {
      const manual = input.manual ?? true;
      if (state.status === 'checking') return state;
      if (state.status === 'downloading') return state;
      if (!driver.canCheck) {
        return set({
          status: 'unsupported',
          unsupportedReason: driver.unsupportedReason,
          error: manual ? null : state.error,
        });
      }

      set({ status: 'checking', error: null, progress: null });
      try {
        await driver.check();
      } catch (error) {
        logger.warn('Update check threw', {
          manual,
          message: error instanceof Error ? error.message : String(error),
        });
        set({ status: 'error', error: describeUpdateError(error), progress: null });
      }
      // A check that produced no event (a null result from the provider) is still
      // a completed check, and saying so beats leaving the spinner running.
      if (statusNow() === 'checking') {
        set({ status: 'not-available', checkedAt: now().toISOString() });
      }
      return state;
    },

    async download() {
      if (state.status !== 'available') {
        throw new AppError(
          appError('validation', 'There is no available update to download. Check for updates first.'),
        );
      }
      set({ status: 'downloading', progress: null, error: null });
      try {
        await driver.download();
      } catch (error) {
        set({ status: 'error', error: describeUpdateError(error), progress: null });
        return state;
      }
      if (statusNow() === 'downloading') {
        set({
          status: 'error',
          error: 'The download finished but the updater did not confirm it. Try again.',
          progress: null,
        });
      }
      return state;
    },

    install() {
      /*
       * The single door to a restart. Guarded by the downloaded state, because an
       * install request with nothing to install is a bug in the caller, not a
       * user action to be swallowed.
       */
      if (state.status !== 'ready') {
        throw new AppError(
          appError('validation', 'There is no downloaded update to install.'),
        );
      }
      logger.info('Installing an update and restarting', { version: state.latestVersion });
      driver.quitAndInstall();
    },

    async setAutoCheck(enabled: boolean) {
      await settings.setAutoCheck(enabled);
      set({ autoCheck: enabled });
      if (enabled) arm(autoDelay);
      else if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      return state;
    },

    start() {
      if (started || disposed) return;
      started = true;
      if (!driver.canCheck) {
        set({ status: 'unsupported', unsupportedReason: driver.unsupportedReason });
        return;
      }
      arm(autoDelay);
    },

    dispose() {
      disposed = true;
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      driver.dispose();
    },
  };

  return service;
}
