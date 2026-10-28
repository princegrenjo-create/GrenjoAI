/**
 * Models & Providers.
 *
 * Two areas, in the order the owner needs them: the endpoints this app may talk
 * to (with their keys, their connection test and their discovery), then the model
 * list those endpoints actually serve, plus the models the owner declares
 * themselves.
 */
import { useCallback, useState, type ReactElement } from 'react';
import { MODEL_HINTS_AS_OF } from '@shared/defaults';
import type { UrlPolicyOptions } from '@shared/url-policy';
import type { ProviderConfig } from '@shared/types';
import { InfoIcon } from '@renderer/components/icons';
import { Button, ErrorState, Skeleton } from '@renderer/components/ui';
import { Page } from '@renderer/components/layout/Page';
import { ROUTE_META } from '@renderer/lib/router';
import { useSettingsStore } from '@renderer/lib/store';
import { toast } from '@renderer/lib/toast';
import type { DiscoveryOutcome } from './discovery';
import { runDiscovery } from './discovery';
import { ModelsSection } from './ModelsSection';
import { ProviderDialog } from './ProviderDialog';
import { ProvidersSection } from './ProvidersSection';
import { useCatalog } from './useCatalog';
import './models.css';

export function ModelsPage(): ReactElement {
  const catalog = useCatalog();
  const advanced = useSettingsStore((state) => state.settings.advanced);
  const policy: UrlPolicyOptions = {
    requireHttps: advanced.requireHttpsForCustomEndpoints,
    allowInsecureLocalhost: advanced.allowInsecureLocalhost,
  };

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);

  const refreshModels = catalog.refreshModels;

  const discover = useCallback(
    async (providerId: string): Promise<DiscoveryOutcome> => {
      const outcome = await runDiscovery(providerId);
      if (outcome.ok) {
        await refreshModels();
        toast.success(
          'Model discovery finished',
          `${outcome.count} models saved for this provider.`,
        );
      }
      return outcome;
    },
    [refreshModels],
  );

  const onSaved = (provider: ProviderConfig): void => {
    catalog.replaceProvider(provider);
    toast.success('Provider saved');
  };

  return (
    <Page
      className="pds-models"
      title={ROUTE_META.models.title}
      description={ROUTE_META.models.description}
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setAddOpen(true);
          }}
        >
          Add provider
        </Button>
      }
    >
      <div className="pds-models__banner" role="note">
        <span className="pds-models__banner-icon" aria-hidden="true">
          <InfoIcon />
        </span>
        <p className="pds-models__banner-text">
          The built-in model list is a <strong>hint list as of {MODEL_HINTS_AS_OF}</strong>, not a
          catalogue. Discovery through the provider&apos;s own API is authoritative, and a custom
          model is authoritative for you. Nothing here substitutes one model id for another.
        </p>
      </div>

      {catalog.status === 'loading' ? (
        <Skeleton lines={8} label="Loading providers and models" />
      ) : null}

      {catalog.status === 'error' ? (
        <ErrorState
          title="Providers and models could not be loaded"
          description={catalog.error?.message ?? 'The local database did not answer.'}
          /* See AgentsPage: an 'unknown' code is a lost code, not a finding. */
          detail={
            catalog.error && catalog.error.code !== 'unknown'
              ? `Error code: ${catalog.error.code}`
              : undefined
          }
          onRetry={() => {
            void catalog.reload();
          }}
        />
      ) : null}

      {catalog.status === 'ready' ? (
        <>
          <ProvidersSection
            providers={catalog.providers}
            models={catalog.models}
            onChanged={catalog.replaceProvider}
            onRemoved={catalog.removeProvider}
            onAdd={() => setAddOpen(true)}
            onEdit={(provider) => setEditing(provider)}
            onDiscover={discover}
          />
          <ModelsSection
            providers={catalog.providers}
            models={catalog.models}
            policy={policy}
            onDiscover={discover}
            onChanged={catalog.refreshModels}
          />
        </>
      ) : null}

      <ProviderDialog
        open={addOpen}
        provider={null}
        policy={policy}
        onClose={() => setAddOpen(false)}
        onSaved={onSaved}
      />
      <ProviderDialog
        open={editing !== null}
        provider={editing}
        policy={policy}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
      />
    </Page>
  );
}
