import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncConflict, SyncStatus } from '@shared/types';
import { SyncPage } from '@renderer/pages/sync/SyncPage';
import { resetStores } from '../helpers/state';
import {
  bridgeError,
  installApi,
  makeConflict,
  makeSyncStatus,
  renderPage,
} from './support';

interface SyncPageOptions {
  status?: SyncStatus;
  conflicts?: SyncConflict[];
}

function openSync(options: SyncPageOptions = {}) {
  const fake = installApi();
  fake.api.sync.status = vi.fn(async () => options.status ?? makeSyncStatus());
  fake.api.sync.conflicts = vi.fn(async () => options.conflicts ?? []);
  const harness = renderPage(fake, <SyncPage />);
  return { fake, user: harness.user };
}

const DISABLED: SyncStatus = makeSyncStatus({
  enabled: false,
  signedIn: false,
  email: null,
  userId: null,
  phase: 'idle',
  pendingCount: 0,
  conflictCount: 0,
  lastSyncedAt: null,
  lastError: null,
});

beforeEach(() => {
  resetStores();
});

describe('Cloud Sync page', () => {
  it('renders a loading state while the sync status is read', async () => {
    const fake = installApi();
    fake.api.sync.status = () => new Promise<SyncStatus>(() => undefined);
    fake.api.sync.conflicts = vi.fn(async () => []);

    renderPage(fake, <SyncPage />);

    expect(await screen.findByRole('status', { name: 'Loading sync status' })).toBeInTheDocument();
  });

  it('keeps the page frame and the retry when the status read fails', async () => {
    const fake = installApi();
    let calls = 0;
    fake.api.sync.status = async () => {
      calls += 1;
      if (calls === 1) throw bridgeError('sync_config', 'The sync engine is not running.');
      return makeSyncStatus();
    };
    fake.api.sync.conflicts = vi.fn(async () => []);

    const { user } = renderPage(fake, <SyncPage />);

    /* The permanent sentence and the "this is optional" frame survive the failure. */
    expect(
      await screen.findByText(
        'API keys are never synchronized. Only conversations, agents, custom models, non-secret provider settings and preferences are uploaded.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Cloud sync is optional. The app works fully without it.')).toBeInTheDocument();
    expect(
      screen.getByText(/Conversations, agents, custom models, providers and settings are stored on this machine/),
    ).toBeInTheDocument();

    /* The error belongs to the status region, with its own retry. */
    expect(screen.getByText('The sync status could not be read')).toBeInTheDocument();
    expect(screen.getByText('The status request failed')).toBeInTheDocument();
    expect(screen.getByText('The sync engine is not running.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByLabelText('Supabase project URL')).toBeInTheDocument();
    expect(screen.queryByText('The status request failed')).toBeNull();
  });

  it('explains that sync is optional while the rest of the screen still renders', async () => {
    openSync({ status: DISABLED });

    expect(await screen.findByText('Cloud sync is off')).toBeInTheDocument();
    expect(screen.getByText('Cloud sync is optional. The app works fully without it.')).toBeInTheDocument();
    expect(screen.getByText(/No account is required to use the app./)).toBeInTheDocument();
    expect(screen.getByLabelText('Supabase project URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Publishable (anon) key')).toHaveValue('');
    expect(screen.getByRole('list', { name: 'Sync status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('always states that API keys are never synchronized', async () => {
    openSync({ status: DISABLED });

    expect(
      await screen.findByText(
        'API keys are never synchronized. Only conversations, agents, custom models, non-secret provider settings and preferences are uploaded.',
      ),
    ).toBeInTheDocument();
  });

  it('validates the project URL and stores the configuration', async () => {
    const { fake, user } = openSync({ status: DISABLED });
    fake.api.sync.configure = vi.fn(async (input) =>
      makeSyncStatus({ enabled: true, signedIn: false, lastSyncedAt: null, email: null }),
    );

    await screen.findByLabelText('Supabase project URL');

    const url = screen.getByLabelText('Supabase project URL');
    await user.clear(url);
    await user.type(url, 'not-a-url');
    expect(await screen.findByText(/That is not a valid absolute URL/)).toBeInTheDocument();

    await user.clear(url);
    await user.type(url, 'https://project.supabase.co');
    const key = screen.getByLabelText('Publishable (anon) key');
    await user.type(key, 'anon-key-value');
    await user.click(screen.getByRole('button', { name: 'Turn on cloud sync' }));

    await waitFor(() =>
      expect(fake.api.sync.configure).toHaveBeenCalledWith({
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon-key-value',
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Publishable (anon) key')).toHaveValue(''),
    );
  });

  it('renders the mapped message and no stack trace when signing in fails', async () => {
    const { fake, user } = openSync({ status: makeSyncStatus({ signedIn: false, email: null }) });
    fake.api.sync.signIn = vi.fn(async () => {
      throw bridgeError('sync_auth', 'The email or password is not correct.');
    });

    await screen.findByLabelText('Email');
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Sign-in failed')).toBeInTheDocument();
    expect(screen.getByText('The email or password is not correct.')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/at \w+ \(.*:\d+:\d+\)/);
    expect(text).not.toContain('Error: undefined');
  });

  it('shows the signed-in account and offers sign-out', async () => {
    const { fake, user } = openSync();
    fake.api.sync.signOut = vi.fn(async () =>
      makeSyncStatus({ signedIn: false, email: null, userId: null }),
    );

    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(fake.api.sync.signOut).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('disables Sync now while a sync is running', async () => {
    openSync({ status: makeSyncStatus({ phase: 'syncing', pendingCount: 4 }) });

    const button = await screen.findByRole('button', { name: 'Sync now' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    expect(screen.getByText('4 queued changes')).toBeInTheDocument();
  });

  it('renders both revisions of a conflict and keeps the local one on request', async () => {
    const conflict = makeConflict();
    const { fake, user } = openSync({
      status: makeSyncStatus({ conflictCount: 1 }),
      conflicts: [conflict],
    });
    let resolved = false;
    fake.api.sync.resolveConflict = vi.fn(async () => {
      resolved = true;
      return makeSyncStatus({ conflictCount: 0 });
    });
    fake.api.sync.conflicts = vi.fn(async () => (resolved ? [] : [conflict]));

    expect(
      await screen.findByText(/Local revision 3 · remote revision 5/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The title and the message count changed on both machines.'),
    ).toBeInTheDocument();
    expect(screen.getByText('conversation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep local' }));

    await waitFor(() =>
      expect(fake.api.sync.resolveConflict).toHaveBeenCalledWith(1, 'kept_local'),
    );
    await waitFor(() => expect(screen.queryByText(/Local revision 3/)).toBeNull());
  });

  it('resolves a conflict the other way when the remote revision is kept', async () => {
    const { fake, user } = openSync({
      status: makeSyncStatus({ conflictCount: 1 }),
      conflicts: [makeConflict({ id: 7 })],
    });
    fake.api.sync.resolveConflict = vi.fn(async () => makeSyncStatus({ conflictCount: 0 }));

    await screen.findByText(/Local revision 3/);
    await user.click(screen.getByRole('button', { name: 'Keep remote' }));

    await waitFor(() =>
      expect(fake.api.sync.resolveConflict).toHaveBeenCalledWith(7, 'kept_remote'),
    );
  });

  it('does not render a conflict card when there are no conflicts', async () => {
    openSync({ status: makeSyncStatus({ conflictCount: 0 }) });

    await screen.findByLabelText('Supabase project URL');
    expect(screen.queryByRole('heading', { name: 'Conflicts' })).toBeNull();
  });

  it('shows the last error reported by the sync engine', async () => {
    openSync({
      status: makeSyncStatus({
        phase: 'error',
        lastError: {
          code: 'rate_limited',
          message: 'The sync project asked this app to slow down.',
          retryable: true,
        },
      }),
    });

    expect(await screen.findByText('The last sync did not finish')).toBeInTheDocument();
    expect(screen.getByText('The sync project asked this app to slow down.')).toBeInTheDocument();
    expect(screen.getByText('Error code: rate_limited')).toBeInTheDocument();
  });
});
