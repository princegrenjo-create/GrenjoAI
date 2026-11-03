/**
 * Auto-update contract, shared by the main process, the preload bridge and the UI.
 *
 * The state machine is deliberately small and one-directional: the app can only
 * be in one of these states, and every transition is caused by a user action or
 * by the updater reporting something. Nothing here can install an update on its
 * own — `ready` means "downloaded and waiting", and the only path out of it is
 * `install()`, which the user triggers.
 *
 * Why not just expose electron-updater's own events: they are shaped around its
 * implementation (`update-downloaded`, `download-progress`, `error`) and include
 * fields the UI must never render (file paths, URLs). A narrow, modelled state is
 * what the UI can be tested against, and it is the only thing the renderer sees.
 */

export const UPDATE_STATUSES = [
  /** Nothing has happened yet this session. */
  'idle',
  'checking',
  /** The feed answered and this build is the newest. */
  'not-available',
  /** A newer version exists and has not been downloaded. */
  'available',
  'downloading',
  /** Downloaded, verified and waiting for the user to restart. */
  'ready',
  /** Terminal error for the last action; the user can try again. */
  'error',
  /**
   * The build cannot check for updates at all — a development run, a portable
   * copy, or a platform without a feed. Distinct from `error` because retrying
   * will never help and the UI must not offer it.
   */
  'unsupported',
] as const;

export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export interface UpdateProgress {
  /** 0-100, clamped. */
  percent: number;
  transferred: number;
  total: number;
  /** Bytes per second, or null when the updater has not measured yet. */
  bytesPerSecond: number | null;
}

export interface UpdateState {
  status: UpdateStatus;
  /** The version this process is running. */
  currentVersion: string;
  /** The feed's newest version, once a check has been answered. */
  latestVersion: string | null;
  /** Release notes from the feed, trimmed; null when the feed has none. */
  releaseNotes: string | null;
  releaseDate: string | null;
  progress: UpdateProgress | null;
  /** A sentence for the user when something went wrong. */
  error: string | null;
  /** Machine-readable reason for `unsupported`, so the UI can explain it. */
  unsupportedReason: string | null;
  /** ISO timestamp of the last completed check attempt. */
  checkedAt: string | null;
  /** Whether automatic checking is on (mirrors the setting). */
  autoCheck: boolean;
  /** False when this build cannot update at all. */
  canCheck: boolean;
}

/** Screenshot- and test-friendly short forms for the status line. */
export const UPDATE_STATUS_LABEL: Record<UpdateStatus, string> = {
  idle: 'Not checked yet',
  checking: 'Checking for updates…',
  'not-available': 'You have the latest version',
  available: 'An update is available',
  downloading: 'Downloading…',
  ready: 'Ready to install',
  error: 'Update check failed',
  unsupported: 'Updates are not available for this build',
};
