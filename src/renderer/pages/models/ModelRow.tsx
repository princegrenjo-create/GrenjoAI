/**
 * One model row. The row states what the model is declared to do — source,
 * capabilities, limits, parameters — and offers the actions that are actually
 * possible for that source: a custom model can be edited and deleted, a
 * discovered one is refreshed by discovery, and a built-in hint is read-only.
 */
import { useState, type ReactElement } from 'react';
import { asAppError } from '@shared/errors';
import type { ModelDescriptor, ModelTestResult } from '@shared/types';
import { Badge, Button, ErrorState, IconButton } from '@renderer/components/ui';
import { TrashIcon } from '@renderer/components/icons';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import {
  CAPABILITIES,
  SOURCE_LABEL,
  SOURCE_TONE,
  limitSummary,
  paramSummary,
} from './model-labels';
import type { DiscoveryOutcome } from './discovery';

export interface ModelRowProps {
  model: ModelDescriptor;
  providerName: string;
  onEdit?(model: ModelDescriptor): void;
  onDelete?(model: ModelDescriptor): void;
  onRefreshDiscovery?(providerId: string): Promise<DiscoveryOutcome>;
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: ModelTestResult };

export function ModelRow({
  model,
  providerName,
  onEdit,
  onDelete,
  onRefreshDiscovery,
}: ModelRowProps): ReactElement {
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryOutcome | null>(null);

  const declared = CAPABILITIES.filter((entry) => model.capabilities[entry.key]);
  const absent = CAPABILITIES.filter((entry) => !model.capabilities[entry.key]);

  const runTest = async (): Promise<void> => {
    setTest({ phase: 'running' });
    try {
      const result = await getApi().models.test({
        providerId: model.providerId,
        modelId: model.modelId,
      });
      setTest({ phase: 'done', result });
    } catch (thrown) {
      setTest({
        phase: 'done',
        result: { ok: false, latencyMs: null, sample: null, error: asAppError(thrown) },
      });
    }
  };

  const refresh = async (): Promise<void> => {
    if (!onRefreshDiscovery) return;
    setDiscovering(true);
    setDiscovery(null);
    try {
      setDiscovery(await onRefreshDiscovery(model.providerId));
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <li className="pds-model">
      <div className="pds-model__main">
        <div className="pds-model__heading">
          <span className="pds-model__name">{model.displayName}</span>
          <span className="pds-model__id">{model.modelId}</span>
          <span className="pds-model__provider">{providerName}</span>
        </div>

        <div className="pds-model__badges">
          <Badge tone={SOURCE_TONE[model.source]}>{SOURCE_LABEL[model.source]}</Badge>
          {declared.map((entry) => (
            <Badge key={entry.key} tone="success">
              {entry.label}
            </Badge>
          ))}
          {model.weirdnessSupported ? <Badge tone="accent">Weirdness</Badge> : null}
        </div>

        {model.description ? <p className="pds-model__description">{model.description}</p> : null}

        <dl className="pds-model__facts">
          <div className="pds-model__fact">
            <dt>Limits</dt>
            <dd>{limitSummary(model.limits)}</dd>
          </div>
          <div className="pds-model__fact">
            <dt>Parameters</dt>
            <dd>{paramSummary(model.supportedParams)}</dd>
          </div>
          {absent.length > 0 ? (
            <div className="pds-model__fact">
              <dt>Not declared</dt>
              <dd>{absent.map((entry) => entry.label.toLowerCase()).join(', ')}</dd>
            </div>
          ) : null}
        </dl>

        {test.phase === 'done' ? (
          test.result.ok ? (
            <div className="pds-model__result" role="status">
              <p className="pds-model__result-title">
                Replied{test.result.latencyMs !== null ? ` in ${test.result.latencyMs} ms` : ''}
              </p>
              <p className="pds-model__result-sample">
                {test.result.sample ? `“${test.result.sample}”` : 'The provider returned an empty reply.'}
              </p>
            </div>
          ) : (
            <ErrorState
              inline
              title="The model test failed"
              description={
                test.result.error
                  ? errorSummary(test.result.error)
                  : 'The provider did not answer the test request.'
              }
              detail={
                test.result.error ? `Error code: ${test.result.error.code}` : undefined
              }
              onRetry={() => {
                void runTest();
              }}
            />
          )
        ) : null}

        {discovery ? (
          discovery.ok ? (
            <p className="pds-model__result" role="status">
              Discovery refreshed this list ({discovery.count} models).
            </p>
          ) : (
            <ErrorState
              inline
              title="Discovery could not refresh this list"
              description={errorSummary(discovery.error)}
              onRetry={() => {
                void refresh();
              }}
            />
          )
        ) : null}
      </div>

      <div className="pds-model__actions">
        <Button
          size="sm"
          variant="secondary"
          loading={test.phase === 'running'}
          onClick={() => {
            void runTest();
          }}
        >
          Test
        </Button>
        {model.source === 'custom' && onEdit ? (
          <Button size="sm" variant="ghost" onClick={() => onEdit(model)}>
            Edit
          </Button>
        ) : null}
        {model.source === 'custom' && onDelete ? (
          <IconButton
            label={`Delete ${model.displayName}`}
            icon={<TrashIcon />}
            size="sm"
            tone="danger"
            onClick={() => onDelete(model)}
          />
        ) : null}
        {model.source === 'discovered' && onRefreshDiscovery ? (
          <Button
            size="sm"
            variant="ghost"
            loading={discovering}
            onClick={() => {
              void refresh();
            }}
          >
            Refresh via discovery
          </Button>
        ) : null}
        {model.source === 'catalog' ? (
          <span className="pds-model__hint">
            Add it as a custom model to change these values.
          </span>
        ) : null}
      </div>
    </li>
  );
}
