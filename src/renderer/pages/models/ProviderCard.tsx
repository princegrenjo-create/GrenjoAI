/**
 * One provider: what it is, whether it is usable, and every action the screen
 * offers for it. The card owns only transient interaction state (a test result, a
 * pending key edit); the provider record itself lives in the page so an edit
 * cannot leave two copies of the same row on screen.
 */
import { useState, type ReactElement } from 'react';
import { PROVIDER_PRESETS } from '@shared/defaults';
import { asAppError } from '@shared/errors';
import type {
  AppErrorShape,
  ConnectionTestResult,
  ProviderConfig,
} from '@shared/types';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  IconButton,
  Input,
} from '@renderer/components/ui';
import { TrashIcon } from '@renderer/components/icons';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { formatCount, formatFullTimestamp } from '@renderer/lib/format';
import { toast } from '@renderer/lib/toast';
import type { DiscoveryOutcome } from './discovery';

export interface ProviderCardProps {
  provider: ProviderConfig;
  modelCount: number;
  onChanged(provider: ProviderConfig): void;
  onRemoved(id: string): void;
  onEdit(provider: ProviderConfig): void;
  onDiscover(providerId: string): Promise<DiscoveryOutcome>;
}

export function ProviderCard({
  provider,
  modelCount,
  onChanged,
  onRemoved,
  onEdit,
  onDiscover,
}: ProviderCardProps): ReactElement {
  const preset = PROVIDER_PRESETS[provider.kind];

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryOutcome | null>(null);
  const [toggling, setToggling] = useState(false);

  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  const closeKeyDialog = (): void => {
    if (keyBusy) return;
    setKeyDraft('');
    setKeyError(null);
    setKeyOpen(false);
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await getApi().providers.test(provider.id));
    } catch (thrown) {
      const shaped = asAppError(thrown);
      setTestResult({
        ok: false,
        latencyMs: null,
        message: shaped.message,
        modelsFound: null,
        error: shaped,
      });
    } finally {
      setTesting(false);
    }
  };

  const runDiscovery = async (): Promise<void> => {
    setDiscovering(true);
    setDiscovery(null);
    try {
      setDiscovery(await onDiscover(provider.id));
    } finally {
      setDiscovering(false);
    }
  };

  const toggleEnabled = async (): Promise<void> => {
    setToggling(true);
    try {
      const updated = await getApi().providers.upsert({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: !provider.enabled,
      });
      onChanged(updated);
      toast.success(updated.enabled ? 'Provider enabled' : 'Provider disabled');
    } catch (thrown) {
      toast.danger('The provider was not updated', errorSummary(asAppError(thrown)));
    } finally {
      setToggling(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    const trimmed = keyDraft.trim();
    if (trimmed.length === 0) {
      setKeyError('Enter the key before saving.');
      return;
    }
    setKeyBusy(true);
    setKeyError(null);
    try {
      const updated = await getApi().providers.setKey(provider.id, trimmed);
      onChanged(updated);
      setKeyDraft('');
      setKeyOpen(false);
      toast.success('API key stored', 'It lives in the Windows credential store, not in the database.');
    } catch (thrown) {
      const shaped = asAppError(thrown);
      setKeyError(errorSummary(shaped));
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const updated = await getApi().providers.clearKey(provider.id);
      onChanged(updated);
      setKeyOpen(false);
      toast.success('Stored API key removed');
    } catch (thrown) {
      setKeyError(errorSummary(asAppError(thrown)));
    } finally {
      setKeyBusy(false);
    }
  };

  const removeProvider = async (): Promise<void> => {
    setRemoveBusy(true);
    try {
      await getApi().providers.remove(provider.id);
      setRemoveOpen(false);
      onRemoved(provider.id);
      toast.success('Provider removed');
    } catch (thrown) {
      toast.danger('The provider was not removed', errorSummary(asAppError(thrown)));
    } finally {
      setRemoveBusy(false);
    }
  };

  const keyState = provider.hasKey
    ? `A key is stored (fingerprint ${provider.keyFingerprint ?? 'unknown'})`
    : 'No key stored';

  const discoveryError: AppErrorShape | null =
    discovery && !discovery.ok ? discovery.error : null;

  return (
    <Card as="article" className="pds-provider">
      <header className="pds-provider__head">
        <div className="pds-provider__title-block">
          <h3 className="pds-provider__title">{provider.name}</h3>
          {/* The type is only worth a line when it differs from the name the user
              chose; the endpoint is already a fact row below. */}
          {preset.label.toLowerCase() === provider.name.trim().toLowerCase() ? null : (
            <p className="pds-provider__meta">{preset.label}</p>
          )}
        </div>
        <div className="pds-provider__badges">
          <Badge tone={provider.enabled ? 'success' : 'neutral'} dot>
            {provider.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <Badge tone={provider.hasKey ? 'info' : 'warning'} dot>
            {provider.hasKey ? 'Key stored' : 'No key'}
          </Badge>
          {/* The destructive action sits in the header rather than in the action
              row: in a wrapping row the icon was the one item dropped to a second
              line, and it should never neighbour the button the user reaches for. */}
          <IconButton
            label={`Remove ${provider.name}`}
            icon={<TrashIcon />}
            size="sm"
            tone="danger"
            onClick={() => setRemoveOpen(true)}
          />
        </div>
      </header>

      <dl className="pds-provider__facts">
        <div className="pds-provider__fact">
          <dt>Endpoint</dt>
          <dd className="pds-provider__url">{provider.baseUrl}</dd>
        </div>
        <div className="pds-provider__fact">
          <dt>API key</dt>
          <dd>{keyState}</dd>
        </div>
        <div className="pds-provider__fact">
          <dt>Models</dt>
          <dd>{formatCount(modelCount, 'model')} available</dd>
        </div>
        <div className="pds-provider__fact">
          <dt>Updated</dt>
          <dd>{formatFullTimestamp(provider.updatedAt) || 'Unknown'}</dd>
        </div>
      </dl>

      {testResult ? (
        <div className="pds-provider__status">
          {testResult.ok ? (
            <div className="pds-provider__result" role="status">
              <p className="pds-provider__result-title">The connection test succeeded</p>
              <p className="pds-provider__result-meta">
                {testResult.message || 'The provider answered.'}
                {testResult.latencyMs !== null ? ` · ${testResult.latencyMs} ms` : ''}
                {testResult.modelsFound !== null
                  ? ` · ${formatCount(testResult.modelsFound, 'model')} found`
                  : ''}
              </p>
            </div>
          ) : (
            <ErrorState
              inline
              title="The connection test failed"
              description={
                testResult.error ? errorSummary(testResult.error) : testResult.message
              }
              detail={testResult.error ? `Error code: ${testResult.error.code}` : undefined}
              onRetry={() => {
                void runTest();
              }}
            />
          )}
        </div>
      ) : null}

      {discovery ? (
        <div className="pds-provider__status">
          {discovery.ok ? (
            <p className="pds-provider__result" role="status">
              Discovered {formatCount(discovery.count, 'model')} and saved them for this provider.
            </p>
          ) : (
            <ErrorState
              inline
              title="Model discovery failed"
              description={discoveryError ? errorSummary(discoveryError) : 'Discovery did not finish.'}
              onRetry={() => {
                void runDiscovery();
              }}
            />
          )}
        </div>
      ) : null}

      <div className="pds-provider__actions">
        <Button
          size="sm"
          variant="secondary"
          loading={testing}
          onClick={() => {
            void runTest();
          }}
        >
          Test connection
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={discovering}
          disabled={!provider.supportsModelDiscovery}
          onClick={() => {
            void runDiscovery();
          }}
        >
          Discover models
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onEdit(provider)}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setKeyOpen(true);
          }}
        >
          {provider.hasKey ? 'Replace key' : 'Set key'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={toggling}
          onClick={() => {
            void toggleEnabled();
          }}
        >
          {provider.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
      {provider.supportsModelDiscovery ? null : (
        <p className="pds-provider__hint">
          This endpoint does not expose a model-listing API. Add its models by hand under
          Others / Custom Models.
        </p>
      )}

      <Dialog
        open={keyOpen}
        onClose={closeKeyDialog}
        title={`${provider.hasKey ? 'Replace' : 'Set'} the API key for ${provider.name}`}
        description="The key goes straight to the Windows credential store. It is never written to the database, never returned to this window, and never shown again."
        size="sm"
        closeOnOverlayClick={!keyBusy}
        footer={
          <>
            <Button variant="secondary" onClick={closeKeyDialog} disabled={keyBusy}>
              Cancel
            </Button>
            {provider.hasKey ? (
              <Button
                variant="danger"
                disabled={keyBusy}
                onClick={() => {
                  void clearKey();
                }}
              >
                Remove stored key
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={keyBusy}
              onClick={() => {
                void saveKey();
              }}
            >
              Save key
            </Button>
          </>
        }
      >
        <Input
          label={`API key for ${provider.name}`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={keyDraft}
          placeholder={preset.keyPlaceholder}
          onChange={(event) => {
            setKeyDraft(event.target.value);
            setKeyError(null);
          }}
          error={keyError ?? undefined}
          hint={
            provider.hasKey
              ? 'A key is stored. The field is deliberately empty: paste the replacement, or leave it.'
              : 'Paste the key exactly as the provider issued it. Nothing is pre-filled.'
          }
        />
      </Dialog>

      <Dialog
        open={removeOpen}
        onClose={() => {
          if (!removeBusy) setRemoveOpen(false);
        }}
        title="Remove this provider?"
        description={`“${provider.name}” and its discovered models will be removed from this device, and its API key will be deleted from the Windows credential store. Conversations that used it keep their history. This cannot be undone.`}
        size="sm"
        initialFocus="cancel"
        closeOnOverlayClick={false}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={removeBusy}
              onClick={() => setRemoveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeBusy}
              onClick={() => {
                void removeProvider();
              }}
            >
              Remove provider
            </Button>
          </>
        }
      />
    </Card>
  );
}
