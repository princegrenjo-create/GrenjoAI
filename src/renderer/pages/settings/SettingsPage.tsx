/**
 * Settings.
 *
 * Every control writes through the shared settings store — one writer for the
 * settings document. Selects and switches apply immediately; numeric fields
 * commit on blur so typing a timeout does not write to the database six times.
 *
 * The export deliberately stays inside the window: this renderer has no file
 * access and no network, so "export" means "here is the document, copy it".
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { asAppError } from '@shared/errors';
import type {
  AppErrorShape,
  AppSettingsPatch,
  ConfigImportResult,
  GenerationSettings,
  ModelDescriptor,
  ThemePreference,
} from '@shared/types';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Select,
  Skeleton,
  Slider,
  Switch,
  Textarea,
} from '@renderer/components/ui';
import { Page } from '@renderer/components/layout/Page';
import { getApi } from '@renderer/lib/api';
import { copyToClipboard } from '@renderer/lib/clipboard';
import { errorSummary } from '@renderer/lib/error-copy';
import { ROUTE_META } from '@renderer/lib/router';
import { useSettingsStore } from '@renderer/lib/store';
import { toast } from '@renderer/lib/toast';
import { AdvancedTable } from './AdvancedTable';
import { GenerationParamControls, NumberField } from './ParamControls';
import { useSettingsResources } from './useSettingsResources';
import './settings.css';

function isThemePreference(value: string): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

function generationPatch<K extends keyof GenerationSettings>(
  key: K,
  value: GenerationSettings[K],
): AppSettingsPatch {
  const section: Partial<GenerationSettings> = {};
  section[key] = value;
  return { generation: section };
}

interface GenerationField {
  key: 'requestTimeoutMs' | 'maxRetries' | 'retryBackoffMs' | 'maxHistoryMessages' | 'historyTokenBudget';
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

const GENERATION_FIELDS: GenerationField[] = [  {
    key: 'requestTimeoutMs',
    label: 'Request timeout',
    min: 1000,
    max: 600000,
    step: 1000,
    hint: 'Milliseconds before a provider request is abandoned.',
  },
  {
    key: 'maxRetries',
    label: 'Max retries',
    min: 0,
    max: 5,
    step: 1,
    hint: 'Only retryable failures, and never after any text has arrived.',
  },
  {
    key: 'retryBackoffMs',
    label: 'Retry backoff',
    min: 0,
    max: 60000,
    step: 100,
    hint: 'Base delay before a retry. It doubles on each further attempt.',
  },
  {
    key: 'maxHistoryMessages',
    label: 'Max history messages',
    min: 1,
    max: 500,
    step: 1,
    hint: 'How many earlier messages may be replayed as context.',
  },
  {
    key: 'historyTokenBudget',
    label: 'History token budget',
    min: 1000,
    max: 2000000,
    step: 1000,
    hint: 'Approximate token budget used to trim that history.',
  },
];

interface SectionLoadErrorProps {
  /** What could not be loaded, phrased as the subject of the sentence. */
  what: string;
  error: AppErrorShape;
  onRetry(): void;
}

/**
 * A supporting read failed. It is deliberately a section-sized warning with its
 * own retry: the settings document is intact, so the page stays usable and only
 * the control that needed this data is replaced.
 */
function SectionLoadError({ what, error, onRetry }: SectionLoadErrorProps): ReactElement {
  const retryLabel = `Retry loading ${what.replace(/^The /, '').toLowerCase()}`;
  return (
    <ErrorState
      inline
      title={`${what} could not be loaded`}
      description={`${error.message} The rest of this page still works.`}
      onRetry={onRetry}
      retryLabel={retryLabel}
    />
  );
}

export function SettingsPage(): ReactElement {
  const settings = useSettingsStore((state) => state.settings);
  const settingsStatus = useSettingsStore((state) => state.status);
  const settingsError = useSettingsStore((state) => state.error);
  const loadSettings = useSettingsStore((state) => state.load);
  const patchSettings = useSettingsStore((state) => state.patch);
  const resources = useSettingsResources();

  const [exportJson, setExportJson] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ConfigImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsStatus === 'idle') void loadSettings();
  }, [settingsStatus, loadSettings]);

  const patch = (next: AppSettingsPatch): void => {
    void patchSettings(next);
  };

  const defaultProviderId = settings.defaults.providerId ?? '';
  const selectedDefaultModel: ModelDescriptor | null =
    resources.models.find(
      (model) =>
        model.providerId === settings.defaults.providerId &&
        model.modelId === settings.defaults.modelId,
    ) ?? null;

  const defaultModelOptions = useMemo(
    () =>
      resources.models
        .filter(
          (model) => defaultProviderId.length === 0 || model.providerId === defaultProviderId,
        )
        .map((model) => ({
          value: model.modelId,
          label: model.displayName,
          description: model.modelId,
        })),
    [defaultProviderId, resources.models],
  );

  const agentOptions = [
    { value: '', label: 'No default agent' },
    ...resources.agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const providerOptions = [
    { value: '', label: 'No default provider' },
    ...resources.providers.map((provider) => ({ value: provider.id, label: provider.name })),
  ];

  const doExport = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const document = await getApi().settings.exportConfig();
      setExportJson(JSON.stringify(document, null, 2));
    } catch (thrown) {
      setExportError(errorSummary(asAppError(thrown)));
    } finally {
      setExporting(false);
    }
  };

  const doCopy = async (): Promise<void> => {
    if (!exportJson) return;
    const copied = await copyToClipboard(exportJson);
    if (copied) toast.success('The configuration export was copied');
    else toast.danger('Nothing was copied', 'This window cannot reach the clipboard.');
  };

  const doImport = async (): Promise<void> => {
    if (importJson.trim().length === 0) {
      setImportError('Paste a configuration export before importing.');
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await getApi().settings.importConfig(importJson);
      setImportResult(result);
      await loadSettings();
      toast.success('Configuration imported');
    } catch (thrown) {
      setImportError(errorSummary(asAppError(thrown)));
    } finally {
      setImporting(false);
    }
  };

  /* The settings document is the only essential read on this page. Every other
     read is supporting data: if one fails, the section that needed it says so and
     offers its own retry, and the rest of the page keeps working. */
  const settingsLoading = settingsStatus !== 'ready';
  const settingsFailed = settingsStatus === 'error';
  const modelDataError = resources.errors.providers ?? resources.errors.models ?? null;

  return (
    <Page
      className="pds-settings"
      title={ROUTE_META.settings.title}
      description={ROUTE_META.settings.description}
    >
      {settingsLoading && !settingsFailed ? (
        <Skeleton lines={10} label="Loading settings" />
      ) : null}

      {settingsStatus === 'error' ? (
        <ErrorState
          title="Settings could not be loaded"
          description={settingsError?.message ?? 'The local database did not answer.'}
          onRetry={() => {
            void loadSettings();
          }}
        />
      ) : null}

      {settingsStatus === 'ready' ? (
        <>
          <Card>
            <CardHeader
              title="General"
              description="How the window behaves on this machine."
            />
            <CardBody>
              <div className="pds-settings__grid">
                <Select
                  label="Theme"
                  value={settings.general.theme}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'Follow Windows' },
                  ]}
                  onChange={(value) => {
                    if (isThemePreference(value)) patch({ general: { theme: value } });
                  }}
                  hint="Dark and light are re-derived palettes, not one inverted into the other."
                />
              </div>
              <Switch
                label="Send on Enter"
                checked={settings.general.sendOnEnter}
                onChange={(checked) => patch({ general: { sendOnEnter: checked } })}
                hint="Off: Enter adds a line and Ctrl+Enter sends."
              />
              <Switch
                label="Reduce motion"
                checked={settings.general.reduceMotion}
                onChange={(checked) => patch({ general: { reduceMotion: checked } })}
                hint="Stops transitions and the streaming caret animation."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Chat" description="Defaults for a new conversation." />
            <CardBody>
              <Switch
                label="Stream replies"
                checked={settings.chat.streaming}
                onChange={(checked) => patch({ chat: { streaming: checked } })}
                hint="Off: the whole answer appears at once, after it is complete."
              />
              <Switch
                label="Show token usage"
                checked={settings.chat.showTokenUsage}
                onChange={(checked) => patch({ chat: { showTokenUsage: checked } })}
                hint="Shows the prompt and completion counts when the provider reports them."
              />
              <Switch
                label="Title a chat from its first message"
                checked={settings.chat.autoTitleFromFirstMessage}
                onChange={(checked) => patch({ chat: { autoTitleFromFirstMessage: checked } })}
                hint="Off: a new conversation keeps its default title until you rename it."
              />
              {resources.errors.agents ? (
                <SectionLoadError
                  what="The agent list"
                  error={resources.errors.agents}
                  onRetry={() => {
                    void resources.retry('agents');
                  }}
                />
              ) : (
                <div className="pds-settings__grid">
                  <Select
                    label="Default agent"
                    value={settings.chat.defaultAgentId ?? ''}
                    options={agentOptions}
                    onChange={(value) =>
                      patch({ chat: { defaultAgentId: value.length > 0 ? value : null } })
                    }
                    disabled={resources.loading}
                    hint={
                      resources.loading
                        ? 'Loading agents…'
                        : resources.agents.length === 0
                          ? 'No agents yet. Create one on the Agents screen.'
                          : 'The agent a new conversation starts with.'
                    }
                  />
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Default model and parameters"
              description="What a new conversation starts with when neither the conversation nor an agent chooses a model."
            />
            <CardBody>
              {modelDataError ? (
                <>
                  <SectionLoadError
                    what="The provider and model list"
                    error={modelDataError}
                    onRetry={() => {
                      void resources.retry('providers');
                      void resources.retry('models');
                    }}
                  />
                  <p className="pds-settings__note">
                    Until that list loads, this page cannot show which parameters a model accepts.
                    The saved defaults below are untouched and still apply at chat time.
                  </p>
                </>
              ) : (
                <>
                  <div className="pds-settings__grid">
                    <Select
                      label="Default provider"
                      value={defaultProviderId}
                      options={providerOptions}
                      onChange={(value) =>
                        patch({
                          defaults: {
                            providerId: value.length > 0 ? value : null,
                            modelId: null,
                          },
                        })
                      }
                      hint={
                        resources.providers.length === 0
                          ? 'No providers yet. Add one under Models & Providers.'
                          : undefined
                      }
                    />
                    <Select
                      label="Default model"
                      value={settings.defaults.modelId ?? ''}
                      options={defaultModelOptions}
                      placeholder={
                        defaultModelOptions.length === 0 ? 'No models available' : 'Choose a model'
                      }
                      disabled={defaultModelOptions.length === 0}
                      onChange={(value) =>
                        patch({ defaults: { modelId: value.length > 0 ? value : null } })
                      }
                      hint="The exact model id is stored, never rewritten."
                    />
                  </div>
                  <GenerationParamControls
                    legend="Default generation parameters"
                    values={settings.defaults.params}
                    supported={selectedDefaultModel ? selectedDefaultModel.supportedParams : null}
                    weirdnessSupported={selectedDefaultModel?.weirdnessSupported ?? false}
                    showDescriptions
                    onChange={(params) => patch({ defaults: { params } })}
                  />
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Generation"
              description="Request behaviour that applies to every provider."
            />
            <CardBody>
              <div className="pds-settings__grid">
                {GENERATION_FIELDS.map((field) => (
                  <NumberField
                    key={field.key}
                    label={field.label}
                    value={settings.generation[field.key]}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    integer
                    commitOn="blur"
                    hint={field.hint}
                    onChange={(value) => patch(generationPatch(field.key, value))}
                  />
                ))}
              </div>
              <Switch
                label="Include reasoning"
                checked={settings.generation.includeReasoning}
                onChange={(checked) => patch({ generation: { includeReasoning: checked } })}
                hint="Show a reasoning trace when the provider emits one. It is never treated as the answer."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Weirdness policy"
              description="What happens when a conversation asks for weirdness on a model that has no such parameter."
            />
            <CardBody>
              <div className="pds-settings__grid">
                <Select
                  label="Policy"
                  value={settings.weirdness.mode}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'creativityBias', label: 'Creativity bias' },
                  ]}
                  onChange={(value) => {
                    if (value === 'off' || value === 'creativityBias') {
                      patch({ weirdness: { mode: value } });
                    }
                  }}
                  hint="Off keeps the control disabled wherever the model has no native weirdness parameter."
                />
                <Slider
                  label="Bias strength"
                  value={settings.weirdness.bias}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={settings.weirdness.mode === 'off'}
                  onChange={(value) => patch({ weirdness: { bias: value } })}
                  hint={
                    settings.weirdness.mode === 'off'
                      ? 'Switch the policy on to set a strength.'
                      : 'How far temperature and top-p shift at full weirdness.'
                  }
                />
              </div>
              <p className="pds-settings__note">
                Creativity bias is an <strong>application-level bias</strong> applied locally to
                temperature and top-p. It is <strong>not a model parameter</strong>: no weirdness
                value is ever sent to a provider that does not document one.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Advanced configuration"
              description="Every declared key, with its type, range, documented default and a per-row reset."
            />
            <CardBody>
              <AdvancedTable
                settings={settings}
                onPatch={(next) => patch(next)}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Data"
              description="Where this app keeps its files, and how configuration moves between machines."
            />
            <CardBody>
              {resources.errors.paths ? (
                <SectionLoadError
                  what="The data locations"
                  error={resources.errors.paths}
                  onRetry={() => {
                    void resources.retry('paths');
                  }}
                />
              ) : (
                <dl className="pds-settings__facts">
                  <div className="pds-settings__fact">
                    <dt>Data folder</dt>
                    <dd className="pds-settings__path">
                      {resources.paths?.userData ?? 'Reading…'}
                    </dd>
                  </div>
                  <div className="pds-settings__fact">
                    <dt>Database</dt>
                    <dd className="pds-settings__path">
                      {resources.paths?.database ?? 'Reading…'}
                    </dd>
                  </div>
                  <div className="pds-settings__fact">
                    <dt>Logs</dt>
                    <dd className="pds-settings__path">{resources.paths?.logs ?? 'Reading…'}</dd>
                  </div>
                  <div className="pds-settings__fact">
                    <dt>Credentials</dt>
                    <dd className="pds-settings__path">
                      {resources.paths?.credentials ?? 'Reading…'}
                    </dd>
                  </div>
                </dl>
              )}

              <div className="pds-settings__actions">
                <Button
                  variant="secondary"
                  loading={exporting}
                  onClick={() => {
                    void doExport();
                  }}
                >
                  Export configuration
                </Button>
              </div>
              {/* The note sits under the button rather than beside it: as a flex
                  sibling it wrapped to two lines and skewed the row. */}
              <p className="pds-settings__note">
                Provider definitions and custom models are included. Credentials are never
                included.
              </p>

              {exportError ? (
                <ErrorState
                  inline
                  title="The configuration could not be exported"
                  description={exportError}
                  onRetry={() => {
                    void doExport();
                  }}
                />
              ) : null}

              {exportJson ? (
                <div className="pds-settings__export">
                  <Textarea
                    label="Configuration export (JSON)"
                    className="pds-settings__json"
                    rows={12}
                    readOnly
                    value={exportJson}
                    hint="Nothing was written to disk: this window has no file access. Copy the document and keep it yourself."
                  />
                  <div className="pds-settings__actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void doCopy();
                      }}
                    >
                      Copy JSON
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* A rule separates the two directions: export and import are
                  different operations that happen to share a card. */}
              <div className="pds-settings__import">
                <Textarea
                  label="Import a configuration"
                  className="pds-settings__json"
                  rows={6}
                  value={importJson}
                  placeholder='Paste a document that starts with {"app": "grenjo-ai-tool"…}'
                  onChange={(event) => {
                    setImportJson(event.target.value);
                    setImportError(null);
                  }}
                  hint="Paste the JSON export you kept. Credentials are never imported: a key-looking value is refused."
                />
                <div className="pds-settings__actions">
                  <Button
                    variant="secondary"
                    loading={importing}
                    onClick={() => {
                      void doImport();
                    }}
                  >
                    Import configuration
                  </Button>
                </div>

                {importError ? (
                  <ErrorState inline title="Nothing was imported" description={importError} />
                ) : null}

                {importResult ? (
                  <div className="pds-settings__import-result" role="status">
                    <p className="pds-settings__import-title">Import finished</p>
                    {importResult.applied.length > 0 ? (
                      <p className="pds-settings__import-line">
                        <span className="pds-settings__import-tag">Applied</span>{' '}
                        {importResult.applied.join(', ')}
                      </p>
                    ) : null}
                    {importResult.skipped.length > 0 ? (
                      <p className="pds-settings__import-line">
                        <span className="pds-settings__import-tag">Skipped</span>{' '}
                        {importResult.skipped.join(', ')}
                      </p>
                    ) : null}
                    {importResult.warnings.length > 0 ? (
                      <ul className="pds-settings__warnings" aria-label="Import warnings">
                        {importResult.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="About" description="What is running, and where it keeps its data." />
            <CardBody>
              {resources.errors.info ? (
                <SectionLoadError
                  what="The build information"
                  error={resources.errors.info}
                  onRetry={() => {
                    void resources.retry('info');
                  }}
                />
              ) : (
                <>
                  <div className="pds-settings__badges">
                    <Badge tone={resources.info?.packaged ? 'success' : 'warning'} dot>
                      {resources.info?.packaged ? 'Packaged build' : 'Development build'}
                    </Badge>
                    <Badge
                      tone={resources.info?.secureStorageAvailable ? 'success' : 'danger'}
                      dot
                    >
                      {resources.info?.secureStorageAvailable
                        ? 'Windows credential store available'
                        : 'Credential store unavailable'}
                    </Badge>
                  </div>
                  <dl className="pds-settings__facts">
                    <div className="pds-settings__fact">
                      <dt>Version</dt>
                      <dd>{resources.info?.version ?? 'Reading…'}</dd>
                    </div>
                    <div className="pds-settings__fact">
                      <dt>Electron</dt>
                      <dd>{resources.info?.electronVersion ?? 'Reading…'}</dd>
                    </div>
                    <div className="pds-settings__fact">
                      <dt>Chromium</dt>
                      <dd>{resources.info?.chromeVersion ?? 'Reading…'}</dd>
                    </div>
                    <div className="pds-settings__fact">
                      <dt>Node</dt>
                      <dd>{resources.info?.nodeVersion ?? 'Reading…'}</dd>
                    </div>
                    <div className="pds-settings__fact">
                      <dt>Platform</dt>
                      <dd>{resources.info?.platform ?? 'Reading…'}</dd>
                    </div>
                    <div className="pds-settings__fact">
                      <dt>Log file</dt>
                      <dd className="pds-settings__path">
                        {resources.info?.logPath ?? 'Reading…'}
                      </dd>
                    </div>
                  </dl>
                  {resources.info ? (
                    <p className="pds-settings__note">
                      {resources.info.secureStorageAvailable
                        ? 'API keys are held by the operating system. They are never written to the database or shipped in an export.'
                        : 'The operating system reported that encrypted storage is unavailable. Keys cannot be stored safely on this machine.'}
                    </p>
                  ) : null}
                </>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
