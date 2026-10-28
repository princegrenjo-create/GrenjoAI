/**
 * The provider collection. The cards own their own transient state; the records
 * live in the page, so editing a provider cannot leave a stale copy on screen.
 */
import type { ReactElement } from 'react';
import type { ModelDescriptor, ProviderConfig } from '@shared/types';
import { Button, EmptyState } from '@renderer/components/ui';
import type { DiscoveryOutcome } from './discovery';
import { ProviderCard } from './ProviderCard';
import { formatCount } from '@renderer/lib/format';

export interface ProvidersSectionProps {
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  onChanged(provider: ProviderConfig): void;
  onRemoved(id: string): void;
  onAdd(): void;
  onEdit(provider: ProviderConfig): void;
  onDiscover(providerId: string): Promise<DiscoveryOutcome>;
}

export function ProvidersSection({
  providers,
  models,
  onChanged,
  onRemoved,
  onAdd,
  onEdit,
  onDiscover,
}: ProvidersSectionProps): ReactElement {
  const modelCount = (providerId: string): number =>
    models.filter((model) => model.providerId === providerId).length;

  return (
    <section className="pds-models__section" aria-labelledby="providers-heading">
      <header className="pds-section-head">
        <div className="pds-section-head__text">
          <h2 className="pds-section-title" id="providers-heading">
            Providers
          </h2>
          <p className="pds-section-note">
            {providers.length === 0
              ? 'Bring your own key. Nothing here is shared with another app or another machine.'
              : `${formatCount(providers.length, 'endpoint')} configured. Keys live in the Windows credential store, never in the database.`}
          </p>
        </div>
      </header>

      {providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          description="Add the endpoint you hold a key for — DeepSeek, OpenAI, Gemini, Anthropic or any OpenAI-compatible gateway. You can add several accounts of the same type."
          action={
            <Button variant="secondary" onClick={onAdd}>
              Add a provider
            </Button>
          }
        />
      ) : (
        <div className="pds-provider-grid">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              modelCount={modelCount(provider.id)}
              onChanged={onChanged}
              onRemoved={onRemoved}
              onEdit={onEdit}
              onDiscover={onDiscover}
            />
          ))}
        </div>
      )}
    </section>
  );
}
