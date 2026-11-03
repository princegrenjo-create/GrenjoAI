/**
 * Settings -> About -> Updates.
 *
 * The panel exists to answer five questions in this order, and nothing else:
 * what am I running, is there something newer, what does the newer version say,
 * how far along is it, and what happens if I press this button.
 *
 * Two deliberate choices:
 *
 *  - **Nothing installs itself.** `Restart and install` is a separate, confirmed
 *    action that only exists once a download has finished. Closing the app never
 *    applies an update.
 *  - **Release notes are text.** They come from a release feed, so they are
 *    rendered as pre-wrapped text, never as HTML or Markdown. A release note is
 *    not a trusted document.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { UpdateState } from '@shared/updates';
import { UPDATE_STATUS_LABEL } from '@shared/updates';
import { Badge, Button, ConfirmDialog, Progress, Switch } from '@renderer/components/ui';
import { useUpdatesStore } from '@renderer/lib/update-store';
import { formatBytes } from '@shared/attachments';

function formatRate(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null;
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/** The line under the version, and the tone of the badge beside it. */
function statusLine(state: UpdateState | null): { text: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } {
  if (!state) return { text: 'Reading update status…', tone: 'neutral' };
  switch (state.status) {
    case 'checking':
      return { text: UPDATE_STATUS_LABEL.checking, tone: 'info' };
    case 'not-available':
      return { text: UPDATE_STATUS_LABEL['not-available'], tone: 'success' };
    case 'available':
      return {
        text: state.latestVersion
          ? `Version ${state.latestVersion} is available.`
          : UPDATE_STATUS_LABEL.available,
        tone: 'info',
      };
    case 'downloading':
      return { text: UPDATE_STATUS_LABEL.downloading, tone: 'info' };
    case 'ready':
      return {
        text: state.latestVersion
          ? `Version ${state.latestVersion} is downloaded and ready.`
          : UPDATE_STATUS_LABEL.ready,
        tone: 'success',
      };
    case 'error':
      return { text: state.error ?? UPDATE_STATUS_LABEL.error, tone: 'danger' };
    case 'unsupported':
      return { text: state.unsupportedReason ?? UPDATE_STATUS_LABEL.unsupported, tone: 'warning' };
    default:
      return { text: UPDATE_STATUS_LABEL.idle, tone: 'neutral' };
  }
}

export function UpdatePanel(): ReactElement {
  const state = useUpdatesStore((store) => store.state);
  const status = useUpdatesStore((store) => store.status);
  const loadError = useUpdatesStore((store) => store.error);
  const busy = useUpdatesStore((store) => store.busy);
  const load = useUpdatesStore((store) => store.load);
  const check = useUpdatesStore((store) => store.check);
  const download = useUpdatesStore((store) => store.download);
  const install = useUpdatesStore((store) => store.install);
  const setAutoCheck = useUpdatesStore((store) => store.setAutoCheck);

  const [confirmInstall, setConfirmInstall] = useState(false);

  useEffect(() => {
    void load();
    return useUpdatesStore.getState().attach();
  }, [load]);

  const line = useMemo(() => statusLine(state), [state]);

  const canCheck = state?.canCheck === true;
  const checking = state?.status === 'checking' || busy === 'check';
  const downloading = state?.status === 'downloading' || busy === 'download';
  const ready = state?.status === 'ready';
  const available = state?.status === 'available';
  const progressPercent = state?.progress ? Math.round(state.progress.percent) : null;
  const rate = state?.progress ? formatRate(state.progress.bytesPerSecond) : null;

  return (
    <section aria-label="Application updates" className="pds-settings__updates">
      <div className="pds-settings__update-head">
        <div>
          <h3 className="pds-settings__update-title">Updates</h3>
          <p className="pds-settings__note">
            Updates are checked against this project&rsquo;s GitHub releases. Nothing is downloaded
            or installed unless you ask for it.
          </p>
        </div>
        {/*
          Announced, not just drawn: the status is the one line a screen-reader
          user needs after pressing the button. A failure is assertive, everything
          else is polite.
        */}
        <div
          role={state?.status === 'error' ? 'alert' : 'status'}
          aria-live={state?.status === 'error' ? 'assertive' : 'polite'}
        >
          <Badge tone={line.tone} dot={state?.status === 'checking'}>
            {line.text}
          </Badge>
        </div>
      </div>

      <dl className="pds-settings__facts">
        <div className="pds-settings__fact">
          <dt>Installed version</dt>
          <dd>{state?.currentVersion ?? 'Reading…'}</dd>
        </div>
        <div className="pds-settings__fact">
          <dt>Latest version</dt>
          <dd>{state?.latestVersion ?? '—'}</dd>
        </div>
        <div className="pds-settings__fact">
          <dt>Last checked</dt>
          <dd>{state?.checkedAt ? new Date(state.checkedAt).toLocaleString() : 'Not yet'}</dd>
        </div>
      </dl>

      {state?.releaseNotes ? (
        <div className="pds-settings__release-notes">
          <h4 className="pds-settings__update-title">What changed</h4>
          {/* Plain text on purpose: a release note is data, not a document. */}
          <pre className="pds-settings__release-body" aria-label="Release notes">
            {state.releaseNotes}
          </pre>
        </div>
      ) : null}

      {state?.status === 'downloading' ? (
        <Progress
          label="Downloading the update"
          value={progressPercent}
          valueText={
            progressPercent === null
              ? 'Starting…'
              : `${progressPercent}%${rate ? ` · ${rate}` : ''}`
          }
        />
      ) : null}

      {loadError ? (
        <p className="pds-settings__error" role="alert">
          {loadError}
        </p>
      ) : null}

      <div className="pds-settings__update-actions">
        <Button
          variant="secondary"
          onClick={() => void check()}
          disabled={!canCheck || checking || downloading}
          loading={checking}
        >
          Check for updates
        </Button>

        {available ? (
          <Button variant="primary" onClick={() => void download()} loading={downloading}>
            Download update
          </Button>
        ) : null}

        {ready ? (
          <Button variant="primary" onClick={() => setConfirmInstall(true)} loading={busy === 'install'}>
            Restart and install
          </Button>
        ) : null}

        {state?.status === 'error' ? (
          <Button variant="secondary" onClick={() => void check()} disabled={!canCheck}>
            Try again
          </Button>
        ) : null}
      </div>

      <Switch
        label="Check for updates automatically"
        checked={state?.autoCheck ?? false}
        onChange={(enabled) => void setAutoCheck(enabled)}
        disabled={status !== 'ready' || !canCheck}
        hint="Checks once a few seconds after launch and every six hours. It only asks the release feed — it never downloads or installs anything."
      />

      <ConfirmDialog
        open={confirmInstall}
        title="Restart and install the update?"
        description={
          state?.latestVersion
            ? `Grenjo AI Tool will close and reopen as version ${state.latestVersion}. Your conversations, settings, keys and generated media stay where they are — an update replaces the application, not your data.`
            : 'Grenjo AI Tool will close and reopen with the downloaded version. Your data stays where it is.'
        }
        confirmLabel="Restart and install"
        busy={busy === 'install'}
        onConfirm={() => {
          setConfirmInstall(false);
          void install();
        }}
        onClose={() => setConfirmInstall(false)}
      />
    </section>
  );
}
