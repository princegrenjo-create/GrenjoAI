/**
 * The model list: filterable, grouped by provider, plus the dedicated
 * "Others / Custom Models" area where a user's own models live.
 *
 * The collection is a plain `<ul>`/`<li>` on purpose. The shared `List` primitive
 * renders a text bullet — one icon plus one inline span — and a model row carries
 * a heading, badges, a definition list and its own action cluster, which cannot
 * legally nest inside that span.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { asAppError } from '@shared/errors';
import type { UrlPolicyOptions } from '@shared/url-policy';
import type { ModelDescriptor, ProviderConfig } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Select,
} from '@renderer/components/ui';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { formatCount } from '@renderer/lib/format';
import { toast } from '@renderer/lib/toast';
import type { DiscoveryOutcome } from './discovery';
import { ModelDialog, type ModelPrefill } from './ModelDialog';
import { ModelRow } from './ModelRow';

export interface ModelsSectionProps {
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  policy: UrlPolicyOptions;
  onDiscover(providerId: string): Promise<DiscoveryOutcome>;
  /** Re-reads the model list after a write. */
  onChanged(): Promise<void>;
}

interface ModelGroup {
  providerId: string;
  providerName: string;
  items: ModelDescriptor[];
}

export function ModelsSection({
  providers,
  models,
  policy,
  onDiscover,
  onChanged,
}: ModelsSectionProps): ReactElement {
  const [filter, setFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelDescriptor | null>(null);
  const [prefill, setPrefill] = useState<ModelPrefill | null>(null);
  const [deleting, setDeleting] = useState<ModelDescriptor | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const providerName = (id: string): string =>
    providers.find((provider) => provider.id === id)?.name ?? 'Unknown provider';

  const scoped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return models.filter((model) => {
      if (providerFilter.length > 0 && model.providerId !== providerFilter) return false;
      if (needle.length === 0) return true;
      return (
        model.displayName.toLowerCase().includes(needle) ||
        model.modelId.toLowerCase().includes(needle) ||
        model.description.toLowerCase().includes(needle)
      );
    });
  }, [filter, models, providerFilter]);

  const customModels = scoped.filter((model) => model.source === 'custom');
  const otherModels = scoped.filter((model) => model.source !== 'custom');

  const groups = useMemo<ModelGroup[]>(() => {
    const known = new Set(providers.map((provider) => provider.id));
    const byProvider: ModelGroup[] = providers.map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      items: otherModels.filter((model) => model.providerId === provider.id),
    }));
    const orphans = otherModels.filter((model) => !known.has(model.providerId));
    if (orphans.length > 0) {
      byProvider.push({
        providerId: 'unknown',
        providerName: 'Unknown provider',
        items: orphans,
      });
    }
    return byProvider.filter((group) => group.items.length > 0);
  }, [otherModels, providers]);

  const providerOptions = [
    { value: '', label: 'All providers' },
    ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
  ];

  const openCreate = (): void => {
    setEditing(null);
    setPrefill(null);
    setDialogOpen(true);
  };

  const openEdit = (model: ModelDescriptor): void => {
    setEditing(model);
    setPrefill(null);
    setDialogOpen(true);
  };

  /**
   * A discovered model nothing knows about is declared by adding a custom model
   * for the same endpoint and id. A custom model that declares nothing is edited
   * in place instead, because its row already exists.
   */
  const openDeclare = (model: ModelDescriptor): void => {
    if (model.source === 'custom') {
      openEdit(model);
      return;
    }
    setEditing(null);
    setPrefill({
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
    });
    setDialogOpen(true);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await getApi().models.remove(deleting.id);
      setDeleting(null);
      await onChanged();
      toast.success('Custom model deleted');
    } catch (thrown) {
      setDeleteError(errorSummary(asAppError(thrown)));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <section className="pds-models__section" aria-labelledby="models-heading">
        <header className="pds-section-head">
          <div className="pds-section-head__text">
            <h2 className="pds-section-title" id="models-heading">
              Models
            </h2>
            <p className="pds-section-note">
              {formatCount(models.length, 'model')} across {formatCount(providers.length, 'provider')}.
              Every row states what the model is declared to do; the provider is the authority.
            </p>
          </div>
          <div className="pds-section-head__actions">
            <Input
              label="Filter models"
              labelHidden
              placeholder="Filter by name or id"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <Select
              label="Provider filter"
              labelHidden
              value={providerFilter}
              options={providerOptions}
              onChange={setProviderFilter}
              disabled={providers.length === 0}
            />
          </div>
        </header>

        {models.length === 0 ? (
          <EmptyState
            title="No models yet"
            description="A provider's own discovery is authoritative. Run it from the provider card above, or add a model by hand when discovery cannot see it."
            action={
              <Button variant="secondary" onClick={openCreate}>
                Add a custom model
              </Button>
            }
          />
        ) : scoped.length === 0 ? (
          <EmptyState
            title="No models match"
            description={`Nothing matches “${filter.trim() || providerName(providerFilter)}”. Clear the filter to see every model again.`}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter('');
                  setProviderFilter('');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="pds-models__groups">
            {groups.map((group) => (
              <div className="pds-model-group" key={group.providerId}>
                <div className="pds-model-group__head">
                  <h3 className="pds-model-group__title">{group.providerName}</h3>
                  <Badge tone="neutral">{formatCount(group.items.length, 'model')}</Badge>
                </div>
                <ul className="pds-model-list" aria-label={`Models for ${group.providerName}`}>
                  {group.items.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      providerName={group.providerName}
                      onDeclare={openDeclare}
                      onRefreshDiscovery={onDiscover}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="pds-models__section" aria-labelledby="custom-models-heading">
        <header className="pds-section-head">
          <div className="pds-section-head__text">
            <h2 className="pds-section-title" id="custom-models-heading">
              Others / Custom Models
            </h2>
            <p className="pds-section-note">
              Models you added yourself. A custom model wins over a discovered row and over a
              built-in hint for the same provider and model id, because it is the only one of the
              three that states what you know about that endpoint.
            </p>
          </div>
          <div className="pds-section-head__actions">
            <Button variant="secondary" onClick={openCreate}>
              Add custom model
            </Button>
          </div>
        </header>

        {customModels.length === 0 ? (
          <p className="pds-models__none">
            No custom models yet. Add one when a provider serves a model that discovery cannot see,
            or when you need to pin down the endpoint and the parameters it honours.
          </p>
        ) : (
          <ul className="pds-model-list" aria-label="Custom models">
            {customModels.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                providerName={providerName(model.providerId)}
                onEdit={openEdit}
                onDeclare={openDeclare}
                onDelete={(target) => {
                  setDeleteError(null);
                  setDeleting(target);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <ModelDialog
        open={dialogOpen}
        model={editing}
        prefill={prefill}
        providers={providers}
        defaultProviderId={providerFilter || undefined}
        policy={policy}
        onClose={() => {
          setDialogOpen(false);
          setPrefill(null);
        }}
        onSaved={() => {
          void onChanged();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this custom model?"
        description={
          deleting
            ? `“${deleting.displayName}” (${deleting.modelId}) will be removed from this device. Conversations that used it keep their history, but the model will no longer be selectable.`
            : undefined
        }
        confirmLabel="Delete model"
        busy={deleteBusy}
        onConfirm={() => {
          void confirmDelete();
        }}
      >
        {deleteError ? (
          <ErrorState
            inline
            title="The model was not deleted"
            description={deleteError}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}
