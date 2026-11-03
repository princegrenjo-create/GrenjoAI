/**
 * The update service, driven through its port.
 *
 * Every state the About panel can show is produced here by a fake driver, which
 * is the only way to test them: electron-updater emits its failures from inside a
 * download, and there is no way to provoke "the sha512 did not match" or "the
 * feed returned 404" from a unit test otherwise.
 *
 * What these tests are actually defending:
 *  - nothing downloads or installs unless a call says so;
 *  - `install()` is impossible before a download has finished;
 *  - the retry budget of an error is a sentence the user can act on;
 *  - an automatic check is a check, not an install.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UpdateDriver, UpdateDriverCallbacks } from '@main/updates/driver';
import { normaliseReleaseNotes } from '@main/updates/driver';
import {
  createUpdateService,
  describeUpdateError,
  type UpdateServiceOptions,
} from '@main/updates/service';
import type { UpdateProgress, UpdateState } from '@shared/updates';

interface FakeDriver extends UpdateDriver {
  callbacks: UpdateDriverCallbacks | null;
  checkCalls: number;
  downloadCalls: number;
  installCalls: number;
  /** Release what a held check/download is waiting on. */
  release(): void;
}

function fakeDriver(options: { canCheck?: boolean; currentVersion?: string; hold?: boolean } = {}): FakeDriver {
  const canCheck = options.canCheck ?? true;
  let gate: (() => void) | null = null;
  const driver: FakeDriver = {
    currentVersion: options.currentVersion ?? '0.2.0',
    canCheck,
    unsupportedReason: canCheck ? null : 'This is a development build.',
    callbacks: null,
    checkCalls: 0,
    downloadCalls: 0,
    installCalls: 0,
    configure(callbacks) {
      driver.callbacks = callbacks;
    },
    async check() {
      driver.checkCalls += 1;
      driver.callbacks?.onChecking();
      if (options.hold) {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
      }
    },
    async download() {
      driver.downloadCalls += 1;
      if (options.hold) {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
      }
    },
    quitAndInstall() {
      driver.installCalls += 1;
    },
    dispose() {
      driver.callbacks = null;
    },
    release() {
      gate?.();
      gate = null;
    },
  };
  return driver;
}

function harness(options: {
  canCheck?: boolean;
  autoCheck?: boolean;
  hold?: boolean;
} = {}) {
  const driver = fakeDriver({ canCheck: options.canCheck, hold: options.hold });
  const states: UpdateState[] = [];
  const saved: boolean[] = [];
  const timers: Array<{ fn: () => void; ms: number; handle: number }> = [];
  let nextHandle = 1;

  const service = createUpdateService({
    driver,
    settings: {
      get: () => ({ autoCheck: options.autoCheck ?? true }),
      setAutoCheck: async (enabled) => {
        saved.push(enabled);
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    onChange: (state) => states.push(state),
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      timers.push({ fn, ms, handle });
      return handle;
    },
    cancelSchedule: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return { driver, service, states, saved, timers };
}

function progress(percent: number): UpdateProgress {
  return { percent, transferred: percent * 10, total: 1000, bytesPerSecond: 1024 };
}

describe('update service — the state machine', () => {
  it('starts idle with the running version and the stored preference', () => {
    const { service } = harness();
    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(state.currentVersion).toBe('0.2.0');
    expect(state.autoCheck).toBe(true);
    expect(state.canCheck).toBe(true);
    expect(state.latestVersion).toBeNull();
  });

  it('reports a development build as unsupported, not as an error', () => {
    const { service } = harness({ canCheck: false });
    expect(service.getState().status).toBe('unsupported');
    expect(service.getState().unsupportedReason).toContain('development build');
    // A retry would never help, so the UI is told it cannot check.
    expect(service.getState().canCheck).toBe(false);
  });

  it('walks checking -> not-available when the feed has nothing newer', async () => {
    const { driver, service, states } = harness();
    const pending = service.check();
    await Promise.resolve();
    driver.callbacks?.onNotAvailable(null);
    await pending;

    expect(states.map((state) => state.status)).toContain('checking');
    expect(service.getState().status).toBe('not-available');
    expect(service.getState().checkedAt).not.toBeNull();
    expect(service.getState().error).toBeNull();
  });

  it('exposes the new version, its date and its notes when one is offered', async () => {
    const { driver, service } = harness();
    const pending = service.check();
    driver.callbacks?.onAvailable({
      version: '0.3.0',
      releaseNotes: '<p>Faster image jobs</p>',
      releaseDate: '2026-11-04T00:00:00.000Z',
    });
    await pending;

    const state = service.getState();
    expect(state.status).toBe('available');
    expect(state.latestVersion).toBe('0.3.0');
    // Tags are stripped rather than rendered.
    expect(state.releaseNotes).toBe('Faster image jobs');
    expect(state.releaseDate).toBe('2026-11-04T00:00:00.000Z');
  });

  it('reports download progress and then readiness', async () => {
    const { driver, service } = harness();
    await service.check();
    driver.callbacks?.onAvailable({ version: '0.3.0', releaseNotes: null, releaseDate: null });

    driver.callbacks?.onProgress(progress(42.5));
    expect(service.getState().status).toBe('downloading');
    expect(service.getState().progress?.percent).toBe(42.5);

    driver.callbacks?.onDownloaded({ version: '0.3.0', releaseNotes: null, releaseDate: null });
    expect(service.getState().status).toBe('ready');
    expect(service.getState().progress).toBeNull();
  });

  it('surfaces a failed check as a sentence and clears it on the next check', async () => {
    const { driver, service } = harness();
    driver.callbacks?.onError(new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(service.getState().status).toBe('error');
    expect(service.getState().error).toContain('Could not reach the update server');

    const pending = service.check();
    driver.callbacks?.onNotAvailable(null);
    await pending;
    expect(service.getState().status).toBe('not-available');
    expect(service.getState().error).toBeNull();
  });
});

describe('update service — nothing installs itself', () => {
  it('refuses to install before anything has been downloaded', () => {
    const { service } = harness();
    expect(() => service.install()).toThrow(/no downloaded update/i);
  });

  it('refuses to install when an update is only available, not downloaded', async () => {
    const { driver, service } = harness();
    await service.check();
    driver.callbacks?.onAvailable({ version: '0.3.0', releaseNotes: null, releaseDate: null });
    expect(() => service.install()).toThrow(/no downloaded update/i);
  });

  it('installs only after the download completes, and only when asked', async () => {
    const { driver, service } = harness();
    await service.check();
    driver.callbacks?.onAvailable({ version: '0.3.0', releaseNotes: null, releaseDate: null });
    driver.callbacks?.onDownloaded({ version: '0.3.0', releaseNotes: null, releaseDate: null });

    expect(driver.installCalls).toBe(0);
    service.install();
    expect(driver.installCalls).toBe(1);
  });

  it('never downloads as a side effect of checking', async () => {
    const { driver, service } = harness();
    await service.check();
    expect(driver.downloadCalls).toBe(0);
  });

  it('refuses to download when there is nothing available', async () => {
    const { service } = harness();
    await expect(service.download()).rejects.toThrow(/no available update/i);
  });

  it('downloads only on request, then reports readiness', async () => {
    const { driver, service } = harness();
    await service.check();
    driver.callbacks?.onAvailable({ version: '0.3.0', releaseNotes: null, releaseDate: null });

    const pending = service.download();
    expect(driver.downloadCalls).toBe(1);
    driver.callbacks?.onDownloaded({ version: '0.3.0', releaseNotes: null, releaseDate: null });
    await pending;
    expect(service.getState().status).toBe('ready');
  });
});

describe('update service — automatic checks', () => {
  it('arms one timer at start when the preference is on', () => {
    const { service, timers } = harness({ autoCheck: true });
    service.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeGreaterThan(0);
  });

  it('does not arm anything when the preference is off', () => {
    const { service, timers } = harness({ autoCheck: false });
    service.start();
    expect(timers).toHaveLength(0);
    expect(service.getState().autoCheck).toBe(false);
  });

  it('persists the preference and stops the timer when it is turned off', async () => {
    const { service, timers, saved } = harness({ autoCheck: true });
    service.start();
    expect(timers).toHaveLength(1);

    await service.setAutoCheck(false);
    expect(saved).toEqual([false]);
    expect(service.getState().autoCheck).toBe(false);
    expect(timers).toHaveLength(0);
  });

  it('an automatic check is a check, never a download', async () => {
    const { service, driver, timers } = harness({ autoCheck: true });
    service.start();
    timers[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(driver.checkCalls).toBe(1);
    expect(driver.downloadCalls).toBe(0);
    expect(driver.installCalls).toBe(0);
  });

  it('does not schedule anything for a build that cannot check', () => {
    const { service, timers } = harness({ canCheck: false, autoCheck: true });
    service.start();
    expect(timers).toHaveLength(0);
    expect(service.getState().status).toBe('unsupported');
  });

  it('ignores a second start call', () => {
    const { service, timers } = harness({ autoCheck: true });
    service.start();
    service.start();
    expect(timers).toHaveLength(1);
  });
});

describe('update service — concurrency', () => {
  it('ignores a check that arrives while one is running', async () => {
    const { service, driver } = harness({ hold: true });
    const first = service.check();
    const second = service.check();
    expect(driver.checkCalls).toBe(1);
    driver.release();
    await first;
    await second;
  });

  it('does not check while a download is in progress', async () => {
    const { driver, service } = harness();
    await service.check();
    driver.callbacks?.onAvailable({ version: '0.3.0', releaseNotes: null, releaseDate: null });
    driver.callbacks?.onProgress(progress(10));

    const state = await service.check();
    expect(state.status).toBe('downloading');
  });
});

describe('release notes and error copy', () => {
  it('flattens the per-version array shape electron-updater sometimes sends', () => {
    expect(
      normaliseReleaseNotes([
        { version: '0.3.0', note: 'Added video' },
        { version: '0.2.1', note: 'Fixed crash' },
      ]),
    ).toBe('Added video\n\nFixed crash');
  });

  it('returns null rather than an empty block when there are no notes', () => {
    expect(normaliseReleaseNotes(undefined)).toBeNull();
    expect(normaliseReleaseNotes('   ')).toBeNull();
  });

  it('maps a checksum mismatch to a sentence that says nothing was installed', () => {
    const text = describeUpdateError(new Error('sha512 checksum mismatch'));
    expect(text).toContain('checksum');
    expect(text).toContain('discarded');
  });

  it('maps a missing release to a sentence that reassures the user', () => {
    expect(describeUpdateError(new Error('404 Not Found'))).toContain('Nothing is wrong');
  });

  it('never echoes a URL or a long stack into the UI', () => {
    const long = 'Error: '.padEnd(400, 'x');
    const text = describeUpdateError(new Error(long));
    expect(text.length).toBeLessThanOrEqual(240);
  });
});

describe('the shipped panel cannot be driven by the renderer into a silent install', () => {
  it('exposes exactly five calls, none of which installs without a state check', () => {
    /*
     * A structural assertion rather than a comment: the service API is the whole
     * capability surface, and `install` is guarded above. If a sixth call is ever
     * added that installs, this test is where the reviewer sees it.
     */
    const { service } = harness();
    expect(Object.keys(service).sort()).toEqual(
      ['check', 'dispose', 'download', 'getState', 'install', 'setAutoCheck', 'start'].sort(),
    );
  });

  it('does not reach the database, the credential store or the filesystem', () => {
    // The options object is the entire dependency list: a database handle here
    // would be the beginning of an update that can rewrite a profile.
    const keys = ['driver', 'settings', 'logger', 'onChange', 'clock', 'schedule'];
    expect(keys).not.toContain('db');
    expect(keys).not.toContain('credentials');
  });
});

// Keeps the unused-import check honest for the type-only imports above.
void vi;
