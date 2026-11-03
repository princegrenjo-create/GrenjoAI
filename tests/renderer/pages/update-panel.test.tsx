/**
 * Settings -> About -> Updates, from the user's side.
 *
 * Every state the panel can be in is rendered here, because a state nobody has
 * seen is a state that renders wrong the day it matters. The install path is
 * asserted to be *two* steps — a button, then a confirmation — so no future
 * refactor can quietly turn it into one.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@shared/updates';
import { UpdatePanel } from '@renderer/pages/settings/UpdatePanel';
import { resetStores } from '../helpers/state';
import { installApi, renderPage, setUpdateState } from './support';

function baseState(overrides: Partial<UpdateState> = {}): Partial<UpdateState> {
  return {
    status: 'idle',
    currentVersion: '0.2.0',
    latestVersion: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    error: null,
    unsupportedReason: null,
    checkedAt: null,
    autoCheck: true,
    canCheck: true,
    ...overrides,
  };
}

function harness(state: Partial<UpdateState> = {}) {
  const fake = installApi();
  setUpdateState(baseState(state));
  return { ...renderPage(fake, <UpdatePanel />), fake };
}

beforeEach(() => {
  resetStores();
});

describe('the update panel — what it shows', () => {
  it('shows the installed version and that nothing has been checked yet', async () => {
    harness();
    expect(await screen.findByText('0.2.0')).toBeInTheDocument();
    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  });

  it('renders "checking" while the check is in flight', async () => {
    harness({ status: 'checking' });
    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument();
  });

  it('renders "already up to date"', async () => {
    harness({ status: 'not-available', checkedAt: '2026-11-04T00:00:00.000Z' });
    expect(await screen.findByText('You have the latest version')).toBeInTheDocument();
    // Nothing to download or install.
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart and install' })).toBeNull();
  });

  it('shows the new version, its notes, and offers the download', async () => {
    harness({
      status: 'available',
      latestVersion: '0.3.0',
      releaseNotes: 'Faster image jobs\nSturdier video polling',
    });

    expect(await screen.findByText(/Version 0.3.0 is available/)).toBeInTheDocument();
    expect(screen.getByLabelText('Release notes')).toHaveTextContent('Faster image jobs');
    expect(screen.getByRole('button', { name: 'Download update' })).toBeEnabled();
    // Available is not ready: installing must not be offered yet.
    expect(screen.queryByRole('button', { name: 'Restart and install' })).toBeNull();
  });

  it('shows download progress with a real percentage', async () => {
    harness({
      status: 'downloading',
      latestVersion: '0.3.0',
      progress: { percent: 63.2, transferred: 632, total: 1000, bytesPerSecond: 2048 },
    });

    expect(await screen.findByText(/Downloading…/)).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '63');
    expect(screen.getByText(/63%/)).toBeInTheDocument();
  });

  it('reports a failed check as a sentence, with a retry', async () => {
    harness({
      status: 'error',
      error: 'Could not reach the update server. Check your connection and try again.',
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the update server');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('says a development build cannot check, and does not offer a pointless retry', async () => {
    harness({
      status: 'unsupported',
      canCheck: false,
      unsupportedReason: 'This is a development build, so there is no update feed to check.',
    });

    expect(
      await screen.findByText(/This is a development build, so there is no update feed/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows "ready to install" with the restart action', async () => {
    harness({ status: 'ready', latestVersion: '0.3.0' });
    expect(await screen.findByText(/Version 0.3.0 is downloaded and ready/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart and install' })).toBeEnabled();
  });
});

describe('the update panel — what it does', () => {
  it('checks when the button is pressed', async () => {
    const { fake, user } = harness();
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(fake.api.updates.check).toHaveBeenCalledTimes(1));
  });

  it('downloads only when asked', async () => {
    const { fake, user } = harness({ status: 'available', latestVersion: '0.3.0' });
    await user.click(await screen.findByRole('button', { name: 'Download update' }));
    await waitFor(() => expect(fake.api.updates.download).toHaveBeenCalledTimes(1));
    expect(fake.api.updates.install).not.toHaveBeenCalled();
  });

  it('asks before restarting, and installs only after the confirmation', async () => {
    const { fake, user } = harness({ status: 'ready', latestVersion: '0.3.0' });
    await user.click(await screen.findByRole('button', { name: 'Restart and install' }));

    const dialog = await screen.findByRole('alertdialog');
    // The confirmation names the version and promises the data is untouched.
    expect(within(dialog).getByText(/version 0.3.0/)).toBeInTheDocument();
    expect(within(dialog).getByText(/conversations, settings, keys and generated media/i)).toBeInTheDocument();
    expect(fake.api.updates.install).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Restart and install' }));
    await waitFor(() => expect(fake.api.updates.install).toHaveBeenCalledTimes(1));
  });

  it('cancelling the confirmation installs nothing', async () => {
    const { fake, user } = harness({ status: 'ready', latestVersion: '0.3.0' });
    await user.click(await screen.findByRole('button', { name: 'Restart and install' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.api.updates.install).not.toHaveBeenCalled();
  });

  it('toggles automatic checking through the bridge', async () => {
    const { fake, user } = harness({ autoCheck: false });
    const toggle = await screen.findByRole('switch', { name: /Check for updates automatically/i });
    await user.click(toggle);
    await waitFor(() => expect(fake.api.updates.setAutoCheck).toHaveBeenCalledWith(true));
  });

  it('follows a state pushed from the main process while it is open', async () => {
    harness({ status: 'available', latestVersion: '0.3.0' });
    expect(await screen.findByText(/Version 0.3.0 is available/)).toBeInTheDocument();

    // The main process reports the download starting.
    setUpdateState({
      status: 'downloading',
      progress: { percent: 10, transferred: 100, total: 1000, bytesPerSecond: null },
    });

    expect(await screen.findByText(/Downloading…/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
  });
});

void vi;
