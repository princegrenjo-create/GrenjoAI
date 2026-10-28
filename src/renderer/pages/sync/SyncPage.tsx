/**
 * Cloud sync: optional, and honest about it.
 *
 * The screen leads with the fact that the app works completely without sync, then
 * offers the configuration, the account, the state of the queue and the conflicts
 * that need a decision. API keys are never part of any of it.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { asAppError } from '@shared/errors';
import { validateEndpointUrl } from '@shared/url-policy';
import type { SyncConflict, SyncStatus } from '@shared/types';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Input,
  Skeleton,
  Switch,
} from '@renderer/components/ui';
import { Page } from '@renderer/components/layout/Page';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { formatCount, formatFullTimestamp } from '@renderer/lib/format';
import { ROUTE_META } from '@renderer/lib/router';
import { useSettingsStore } from '@renderer/lib/store';
import { toast } from '@renderer/lib/toast';
import { NumberField } from '@renderer/pages/settings/ParamControls';
import { useSyncState } from './useSyncState';
import './sync.css';

const PHASE_LABEL: Record<SyncStatus['phase'], string> = {
  idle: 'Idle',
  syncing: 'Syncing…',
  error: 'Error',
  offline: 'Offline',
  needs_config: 'Needs configuration',
};

export function SyncPage(): ReactElement {
  const resource = useSyncState();
  const sync = resource.sync;

  const settings = useSettingsStore((state) => state.settings);
  const settingsStatus = useSettingsStore((state) => state.status);
  const loadSettings = useSettingsStore((state) => state.load);
  const patchSettings = useSettingsStore((state) => state.patch);

  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [configureError, setConfigureError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authenticating, setAuthenticating] = useState<'in' | 'up' | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsStatus === 'idle') void loadSettings();
  }, [settingsStatus, loadSettings]);

  /* The stored URL is the starting point; the key field stays empty by design. */
  useEffect(() => {
    setUrl(settings.sync.supabaseUrl);
  }, [settings.sync.supabaseUrl]);

  const urlCheck = validateEndpointUrl(url, {
    requireHttps: true,
    allowInsecureLocalhost: settings.advanced.allowInsecureLocalhost,
  });
  const urlError = url.trim().length > 0 && !urlCheck.ok ? urlCheck.reason : undefined;

  const applyStatus = (next: SyncStatus): void => {
    resource.applyStatus(next);
  };

  const configure = async (): Promise<void> => {
    if (!urlCheck.ok) {
      setConfigureError(urlCheck.reason);
      return;
    }
    if (anonKey.trim().length === 0) {
      setConfigureError('Paste the publishable (anon) key for your Supabase project.');
      return;
    }
    setConfiguring(true);
    setConfigureError(null);
    try {
      const next = await getApi().sync.configure({
        supabaseUrl: urlCheck.url,
        anonKey: anonKey.trim(),
      });
      applyStatus(next);
      setAnonKey('');
      await loadSettings();
      toast.success('Cloud sync is configured', 'The key is stored in the Windows credential store.');
    } catch (thrown) {
      setConfigureError(errorSummary(asAppError(thrown)));
    } finally {
      setConfiguring(false);
    }
  };

  const authenticate = async (mode: 'in' | 'up'): Promise<void> => {
    setAuthenticating(mode);
    setAuthError(null);
    try {
      const credentials = { email: email.trim(), password };
      if (mode === 'in') {
        applyStatus(await getApi().sync.signIn(credentials));
        toast.success('Signed in');
      } else {
        const outcome = await getApi().sync.signUp(credentials);
        applyStatus(outcome.status);
        toast.success(
          'Account created',
          outcome.needsConfirmation
            ? 'Check your email to confirm the account before signing in.'
            : undefined,
        );
      }
      setPassword('');
    } catch (thrown) {
      setAuthError(errorSummary(asAppError(thrown)));
    } finally {
      setAuthenticating(null);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusyAction('signOut');
    setActionError(null);
    try {
      applyStatus(await getApi().sync.signOut());
      toast.success('Signed out', 'Local data stays on this device.');
    } catch (thrown) {
      setActionError(errorSummary(asAppError(thrown)));
    } finally {
      setBusyAction(null);
    }
  };

  const syncNow = async (): Promise<void> => {
    setBusyAction('syncNow');
    setActionError(null);
    try {
      applyStatus(await getApi().sync.syncNow());
      await resource.reloadConflicts();
    } catch (thrown) {
      setActionError(errorSummary(asAppError(thrown)));
    } finally {
      setBusyAction(null);
    }
  };

  const resolve = async (
    conflict: SyncConflict,
    resolution: 'kept_local' | 'kept_remote',
  ): Promise<void> => {
    setBusyAction(`conflict-${conflict.id}`);
    setActionError(null);
    try {
      applyStatus(await getApi().sync.resolveConflict(conflict.id, resolution));
      await resource.reloadConflicts();
      toast.success(
        resolution === 'kept_local' ? 'The local revision was kept' : 'The remote revision was kept',
      );
    } catch (thrown) {
      setActionError(errorSummary(asAppError(thrown)));
    } finally {
      setBusyAction(null);
    }
  };

  const turnOff = async (): Promise<void> => {
    setBusyAction('turnOff');
    setActionError(null);
    try {
      await patchSettings({ sync: { enabled: false } });
      await resource.reload();
      toast.success('Cloud sync is off', 'Nothing leaves this device.');
    } catch (thrown) {
      setActionError(errorSummary(asAppError(thrown)));
    } finally {
      setBusyAction(null);
    }
  };

  const enabled = sync?.enabled ?? false;
  const signedIn = sync?.signedIn ?? false;
  const syncing = sync?.phase === 'syncing';
  const primaryAction: 'configure' | 'signIn' | 'syncNow' = !enabled
    ? 'configure'
    : !signedIn
      ? 'signIn'
      : 'syncNow';

  return (
    <Page
      className="pds-sync"
      title={ROUTE_META.sync.title}
      description={ROUTE_META.sync.description}
    >
      <p className="pds-sync__policy" role="note">
        API keys are never synchronized. Only conversations, agents, custom models, non-secret
        provider settings and preferences are uploaded.
      </p>

      {resource.status === 'loading' ? <Skeleton lines={8} label="Loading sync status" /> : null}

      {/* The error belongs to the status region, not to the page: a first-time
          reader still needs to know what this screen is for and that it is
          optional, even while the status request is failing. */}
      {resource.status === 'error' ? (
        <Card>
          <CardHeader
            title="The sync status could not be read"
            description="Cloud sync is optional. The app works fully without it."
          />
          <CardBody>
            <p className="pds-sync__text">
              Conversations, agents, custom models, providers and settings are stored on this
              machine and stay usable whether or not cloud sync is on. This screen cannot say
              whether it is currently enabled, because the status request failed.
            </p>
            <ErrorState
              inline
              title="The status request failed"
              description={resource.error?.message ?? 'The sync engine did not answer.'}
              detail={
                resource.error && resource.error.code !== 'unknown'
                  ? `Error code: ${resource.error.code}`
                  : undefined
              }
              onRetry={() => {
                void resource.reload();
              }}
            />
            <p className="pds-sync__text">
              Retrying only re-reads the status. Nothing is uploaded and no local data changes.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {resource.status === 'ready' && sync ? (
        <>
          {!enabled ? (
            <Card>
              <CardHeader
                title="Cloud sync is off"
                description="Cloud sync is optional. The app works fully without it."
              />
              <CardBody>
                <p className="pds-sync__text">
                  Everything — conversations, agents, custom models, providers and settings — is
                  stored on this machine and stays usable with sync switched off. Turn it on only
                  if you want the same data on another computer, and only through a Supabase project
                  you control. Nothing is uploaded until you configure it and sign in.
                </p>
                <ul className="pds-sync__list">
                  <li>No account is required to use the app.</li>
                  <li>No API key is ever uploaded, with or without sync.</li>
                  <li>You can turn sync off again at any time; local data is untouched.</li>
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Configuration"
              description="The endpoint and the publishable key of your own Supabase project."
            />
            <CardBody>
              <div className="pds-sync__grid">
                <Input
                  label="Supabase project URL"
                  value={url}
                  spellCheck={false}
                  placeholder="https://your-project.supabase.co"
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setConfigureError(null);
                  }}
                  error={urlError}
                  hint="HTTPS only. This is your project URL, not a function URL."
                />
                <Input
                  label="Publishable (anon) key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={anonKey}
                  placeholder="Paste the anon key"
                  onChange={(event) => {
                    setAnonKey(event.target.value);
                    setConfigureError(null);
                  }}
                  error={configureError ?? undefined}
                  hint="Write-only: it goes to the Windows credential store. It is never pre-filled, never stored in the database and never uploaded."
                />
              </div>
              <div className="pds-sync__actions">
                <Button
                  variant={primaryAction === 'configure' ? 'primary' : 'secondary'}
                  loading={configuring}
                  onClick={() => {
                    void configure();
                  }}
                >
                  {enabled ? 'Update configuration' : 'Turn on cloud sync'}
                </Button>
                {configureError && url.trim().length === 0 ? (
                  <span className="pds-sync__actions-note">{configureError}</span>
                ) : null}
              </div>

              {enabled ? (
                <div className="pds-sync__advanced">
                  <Switch
                    label="Sync automatically"
                    checked={settings.sync.autoSync}
                    onChange={(checked) => {
                      void patchSettings({ sync: { autoSync: checked } });
                    }}
                    hint="Runs a sync on its own schedule instead of only when you press Sync now."
                  />
                  {/* Stored in milliseconds, shown in seconds: "300000" is not a
                      number anyone reads as five minutes. */}
                  <NumberField
                    label="Automatic sync interval (seconds)"
                    value={Math.round(settings.sync.syncIntervalMs / 1000)}
                    min={15}
                    max={3600}
                    step={15}
                    integer
                    commitOn="blur"
                    onChange={(value) => {
                      void patchSettings({ sync: { syncIntervalMs: value * 1000 } });
                    }}
                    hint="Between 15 seconds and one hour. Changes apply to the next run."
                  />
                </div>
              ) : null}
            </CardBody>
          </Card>

          {enabled ? (
            <Card>
              <CardHeader
                title="Account"
                description="Sign in to the project above. The session is kept by the operating system, not by this window."
              />
              <CardBody>
                {signedIn ? (
                  <div className="pds-sync__account">
                    <p className="pds-sync__text">
                      Signed in as <strong>{sync.email ?? 'an account'}</strong>.
                    </p>
                    <Button
                      variant="secondary"
                      loading={busyAction === 'signOut'}
                      onClick={() => {
                        void signOut();
                      }}
                    >
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="pds-sync__grid">
                      <Input
                        label="Email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          setAuthError(null);
                        }}
                      />
                      <Input
                        label="Password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setAuthError(null);
                        }}
                        hint="At least 8 characters. Create the account in Supabase if you have not yet."
                      />
                    </div>
                    {authError ? (
                      <ErrorState inline title="Sign-in failed" description={authError} />
                    ) : null}
                    <div className="pds-sync__actions">
                      <Button
                        variant={primaryAction === 'signIn' ? 'primary' : 'secondary'}
                        loading={authenticating === 'in'}
                        disabled={authenticating !== null}
                        onClick={() => {
                          void authenticate('in');
                        }}
                      >
                        Sign in
                      </Button>
                      <Button
                        variant="secondary"
                        loading={authenticating === 'up'}
                        disabled={authenticating !== null}
                        onClick={() => {
                          void authenticate('up');
                        }}
                      >
                        Create account
                      </Button>
                    </div>
                  </>
                )}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Status"
              description="What the sync queue is doing right now."
            />
            <CardBody>
              <ul className="pds-sync__status" aria-label="Sync status">
                <li className="pds-sync__status-item">
                  <span className="pds-sync__status-label">Phase</span>
                  <span className="pds-sync__status-value">{PHASE_LABEL[sync.phase]}</span>
                </li>
                <li className="pds-sync__status-item">
                  <span className="pds-sync__status-label">Connection</span>
                  <span className="pds-sync__status-value">
                    <Badge tone={sync.online ? 'success' : 'warning'} dot>
                      {sync.online ? 'Online' : 'Offline'}
                    </Badge>
                  </span>
                </li>
                <li className="pds-sync__status-item">
                  <span className="pds-sync__status-label">Pending</span>
                  <span className="pds-sync__status-value">
                    {formatCount(sync.pendingCount, 'queued change')}
                  </span>
                </li>
                <li className="pds-sync__status-item">
                  <span className="pds-sync__status-label">Conflicts</span>
                  <span className="pds-sync__status-value">
                    {formatCount(sync.conflictCount, 'conflict')}
                  </span>
                </li>
                <li className="pds-sync__status-item">
                  <span className="pds-sync__status-label">Last synced</span>
                  <span className="pds-sync__status-value">
                    {sync.lastSyncedAt ? formatFullTimestamp(sync.lastSyncedAt) : 'Never'}
                  </span>
                </li>
              </ul>

              {sync.lastError ? (
                <ErrorState
                  inline
                  title="The last sync did not finish"
                  description={sync.lastError.message}
                  detail={
                    sync.lastError.code === 'unknown'
                      ? undefined
                      : `Error code: ${sync.lastError.code}`
                  }
                />
              ) : null}

              {actionError ? (
                <ErrorState inline title="That action did not finish" description={actionError} />
              ) : null}

              <div className="pds-sync__actions">
                <Button
                  variant={primaryAction === 'syncNow' ? 'primary' : 'secondary'}
                  loading={busyAction === 'syncNow' || syncing}
                  disabled={!enabled || syncing}
                  onClick={() => {
                    void syncNow();
                  }}
                >
                  Sync now
                </Button>
                {enabled ? (
                  <Button
                    variant="ghost"
                    loading={busyAction === 'turnOff'}
                    onClick={() => {
                      void turnOff();
                    }}
                  >
                    Turn cloud sync off
                  </Button>
                ) : null}
              </div>
            </CardBody>
          </Card>

          {resource.conflicts.length > 0 ? (
            <Card>
              <CardHeader
                title="Conflicts"
                description="The same record changed on two machines. Choose the revision to keep; the other is discarded on the next sync."
              />
              <CardBody>
                <ul className="pds-sync__conflicts" aria-label="Sync conflicts">
                  {resource.conflicts.map((conflict) => (
                    <li className="pds-sync__conflict" key={conflict.id}>
                      <div className="pds-sync__conflict-head">
                        <span className="pds-sync__conflict-entity">{conflict.entity}</span>
                        <code className="pds-sync__conflict-id">{conflict.entityId}</code>
                      </div>
                      <p className="pds-sync__conflict-summary">{conflict.summary}</p>
                      <p className="pds-sync__conflict-meta">
                        {`Local revision ${conflict.localRevision} · remote revision ${conflict.remoteRevision} · detected ${formatFullTimestamp(conflict.detectedAt) || 'unknown'}`}
                      </p>
                      <div className="pds-sync__actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyAction === `conflict-${conflict.id}`}
                          onClick={() => {
                            void resolve(conflict, 'kept_local');
                          }}
                        >
                          Keep local
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyAction === `conflict-${conflict.id}`}
                          onClick={() => {
                            void resolve(conflict, 'kept_remote');
                          }}
                        >
                          Keep remote
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
