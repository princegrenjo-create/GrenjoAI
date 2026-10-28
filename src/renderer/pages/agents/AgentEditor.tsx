/**
 * The agent editor.
 *
 * An agent is a name, a system prompt, a model and the parameters that model
 * actually honours. The parameter panel is driven by the selected model, so a
 * control the model cannot carry is disabled with its reason rather than being
 * offered and then quietly dropped.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { MAX_SYSTEM_PROMPT_CHARS } from '@shared/defaults';
import { resolveGenerationParams } from '@shared/params';
import type {
  GenerationParams,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';
import { Button, Input, Select, Textarea } from '@renderer/components/ui';
import { useSettingsStore } from '@renderer/lib/store';
import { formatFullTimestamp } from '@renderer/lib/format';
import { GenerationParamControls } from '@renderer/pages/settings/ParamControls';

export interface AgentDraft {
  id: string | null;
  name: string;
  description: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  params: GenerationParams;
  updatedAt: string | null;
}

export interface AgentEditorProps {
  draft: AgentDraft;
  providers: ProviderConfig[];
  models: ModelDescriptor[];
  saving: boolean;
  error: string | null;
  onChange(patch: Partial<AgentDraft>): void;
  onSave(): void;
  onDuplicate(): void;
  onDelete(): void;
  onNewChat(): void;
}

export function AgentEditor({
  draft,
  providers,
  models,
  saving,
  error,
  onChange,
  onSave,
  onDuplicate,
  onDelete,
  onNewChat,
}: AgentEditorProps): ReactElement {
  const [attempted, setAttempted] = useState(false);
  const weirdness = useSettingsStore((state) => state.settings.weirdness);
  const creating = draft.id === null;

  const providerModelOptions = models
    .filter((model) => model.providerId === draft.providerId)
    .map((model) => ({
      value: model.modelId,
      label: model.displayName,
      description: model.modelId,
    }));

  const selectedModel =
    models.find(
      (model) => model.providerId === draft.providerId && model.modelId === draft.modelId,
    ) ?? null;

  const resolved = useMemo(
    () =>
      resolveGenerationParams({
        model: selectedModel,
        layers: [{ source: 'agent', params: draft.params }],
        weirdness,
      }),
    [draft.params, selectedModel, weirdness],
  );

  const suppressed = Object.entries(resolved.suppressed).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  const nameError = attempted && draft.name.trim().length === 0 ? 'An agent needs a name.' : undefined;
  const promptError =
    draft.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
      ? `The system prompt is limited to ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters.`
      : undefined;

  const submit = (): void => {
    setAttempted(true);
    if (draft.name.trim().length === 0 || promptError) return;
    onSave();
  };

  const providerOptions = [
    { value: '', label: 'No provider' },
    ...providers.map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: provider.baseUrl,
    })),
  ];

  const modelHint =
    draft.providerId.length === 0
      ? 'Choose a provider first, or leave both empty to use the app default at chat time.'
      : providerModelOptions.length === 0
        ? 'This provider has no models yet. Add or discover them under Models & Providers.'
        : undefined;

  return (
    <form
      className="pds-agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="pds-agent-editor__head">
        <div className="pds-agent-editor__title-block">
          <h2 className="pds-agent-editor__title">{creating ? 'New agent' : draft.name || 'Agent'}</h2>
          <p className="pds-agent-editor__meta">
            {creating
              ? 'Not saved yet. Give it a name and a system prompt, then save.'
              : `Updated ${formatFullTimestamp(draft.updatedAt) || 'unknown'}`}
          </p>
        </div>
        <div className="pds-agent-editor__actions">
          <Button
            variant="secondary"
            disabled={creating || saving}
            onClick={onNewChat}
          >
            New chat with this agent
          </Button>
          <Button variant="ghost" disabled={creating || saving} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button variant="primary" type="submit" loading={saving}>
            Save agent
          </Button>
        </div>
      </header>

      <div className="pds-agent-editor__grid">
        <Input
          label="Name"
          value={draft.name}
          maxLength={80}
          placeholder="Writing partner"
          error={nameError}
          onChange={(event) => onChange({ name: event.target.value })}
          hint="Shown in the agent picker and in the chat header."
        />
        {/* A sentence-long description is clipped in a single-line input at every
            width, so it gets two rows instead. */}
        <Textarea
          label="Description"
          rows={2}
          value={draft.description}
          maxLength={2000}
          placeholder="A terse editor who cuts every second sentence."
          onChange={(event) => onChange({ description: event.target.value })}
          hint="A sentence for the list. It is not sent to the provider."
        />
      </div>

      <div className="pds-agent-editor__grid">
        <Select
          label="Provider"
          value={draft.providerId}
          options={providerOptions}
          onChange={(value) => onChange({ providerId: value, modelId: '' })}
        />
        <Select
          label="Model"
          value={draft.modelId}
          options={providerModelOptions}
          placeholder={providerModelOptions.length === 0 ? 'No models available' : 'Choose a model'}
          onChange={(value) => onChange({ modelId: value })}
          disabled={draft.providerId.length === 0 || providerModelOptions.length === 0}
          hint={modelHint}
        />
      </div>

      <Textarea
        label="System prompt"
        rows={8}
        value={draft.systemPrompt}
        maxLength={MAX_SYSTEM_PROMPT_CHARS}
        placeholder="You are a terse editor. Cut every sentence that does not earn its place."
        error={promptError}
        onChange={(event) => onChange({ systemPrompt: event.target.value })}
        hint="Sent as the system instruction. Required by some providers, optional for the rest."
      />

      <GenerationParamControls
        legend="Parameter overrides"
        values={draft.params}
        supported={selectedModel ? selectedModel.supportedParams : null}
        weirdnessSupported={selectedModel?.weirdnessSupported ?? false}
        onChange={(params) => onChange({ params })}
        onClear={(key) => {
          const next: GenerationParams = { ...draft.params };
          delete next[key];
          onChange({ params: next });
        }}
      />

      {selectedModel && suppressed.length > 0 ? (
        <div className="pds-agent-editor__suppressed" role="note">
          <p className="pds-agent-editor__suppressed-title">
            Stored, but not sent to {selectedModel.displayName}:
          </p>
          <ul className="pds-agent-editor__suppressed-list">
            {suppressed.map(([key, reason]) => (
              <li key={key}>
                <span className="pds-agent-editor__suppressed-key">{key}</span> — {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p className="pds-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="pds-agent-editor__danger">
        <p className="pds-agent-editor__danger-text">
          Deleting an agent removes the persona only. Conversations it was used in keep their
          history and their messages.
        </p>
        <Button variant="danger" size="sm" disabled={creating || saving} onClick={onDelete}>
          Delete agent
        </Button>
      </div>
    </form>
  );
}
