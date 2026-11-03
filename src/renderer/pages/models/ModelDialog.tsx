/**
 * Create or edit a custom model.
 *
 * A custom model is the user's own statement about an endpoint — including the
 * capabilities it has and the parameters it honours. Nothing here guesses: a
 * capability the user does not switch on stays off, and a limit left blank stays
 * blank rather than being filled with a number the app invented.
 *
 * The capability editor covers the full vocabulary, grouped by what the model
 * does, and enforces the two dependencies that would otherwise store a
 * contradiction: an image editor needs image generation, and streaming needs
 * text generation.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { CAPABILITY_KEYS, makeCapabilities, type CapabilityKey } from '@shared/capabilities';
import { PARAM_SPECS } from '@shared/defaults';
import { DEBUG_PARAM_KEYS } from '@shared/params';
import { asAppError } from '@shared/errors';
import { validateEndpointUrl, type UrlPolicyOptions } from '@shared/url-policy';
import type {
  CustomModelInput,
  GenParamKey,
  ModelCapabilities,
  ModelDescriptor,
  ProviderConfig,
} from '@shared/types';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@renderer/components/ui';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { CAPABILITY_DESCRIPTION, CAPABILITY_LABEL } from './model-labels';
import '@renderer/pages/settings/params.css';

/** What to start a *new* custom model from: a discovered row the user wants to declare. */
export interface ModelPrefill {
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface ModelDialogProps {
  open: boolean;
  /** Null creates a model; a value edits that custom model. */
  model: ModelDescriptor | null;
  /** Seeds the create form from a discovered model. Ignored when `model` is set. */
  prefill?: ModelPrefill | null;
  providers: ProviderConfig[];
  defaultProviderId?: string;
  policy: UrlPolicyOptions;
  onClose(): void;
  onSaved(model: ModelDescriptor): void;
}

/** A new custom model is a text model until the user says otherwise. */
const EMPTY_CAPABILITIES: ModelCapabilities = makeCapabilities({
  chat: true,
  streaming: true,
});

/**
 * The groups the editor shows. Every capability appears exactly once, so a flag
 * added to the shared vocabulary cannot become unreachable in the form.
 */
const CAPABILITY_GROUPS: { title: string; keys: CapabilityKey[] }[] = [
  { title: 'Text', keys: ['chat', 'streaming', 'toolCalling'] },
  { title: 'Images', keys: ['imageInput', 'imageOutput', 'imageEditing'] },
  { title: 'Video', keys: ['videoInput', 'videoOutput'] },
  { title: 'Audio', keys: ['audioInput', 'audioOutput'] },
  { title: 'Other', keys: ['embeddings'] },
];

/**
 * A capability that cannot be on without another one. `videoOutput` is absent on
 * purpose: a video model stands on its own.
 */
const CAPABILITY_REQUIRES: Partial<Record<CapabilityKey, CapabilityKey>> = {
  streaming: 'chat',
  imageEditing: 'imageOutput',
};

/**
 * Drop any capability whose prerequisite is off. The form prevents the pair being
 * switched on, and this makes the stored value consistent even when it arrived
 * that way from an older row.
 */
function normalizeCapabilities(input: ModelCapabilities): ModelCapabilities {
  const next = makeCapabilities(input);
  for (const key of CAPABILITY_KEYS) {
    const required = CAPABILITY_REQUIRES[key];
    if (required && !next[required]) next[key] = false;
  }
  return next;
}

/** The switch hint, and whether the switch may be turned on at all. */
function capabilityHint(
  key: CapabilityKey,
  capabilities: ModelCapabilities,
): { hint: string; disabled: boolean } {
  const required = CAPABILITY_REQUIRES[key];
  if (required && !capabilities[required]) {
    return capabilities[key]
      ? {
          // A row that already claims the dependent capability must stay editable,
          // otherwise the contradiction could only be fixed by starting over.
          hint: `Needs ${CAPABILITY_LABEL[required]}. Turn that on, or turn this off.`,
          disabled: false,
        }
      : { hint: `Turn on ${CAPABILITY_LABEL[required]} first.`, disabled: true };
  }
  return { hint: CAPABILITY_DESCRIPTION[key], disabled: false };
}

function parseOptionalCount(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return 'invalid';
  return parsed;
}

export function ModelDialog({
  open,
  model,
  prefill,
  providers,
  defaultProviderId,
  policy,
  onClose,
  onSaved,
}: ModelDialogProps): ReactElement {
  const [displayName, setDisplayName] = useState('');
  const [modelId, setModelId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [baseUrlOverride, setBaseUrlOverride] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(EMPTY_CAPABILITIES);
  const [contextWindow, setContextWindow] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [supportedParams, setSupportedParams] = useState<GenParamKey[]>([]);
  const [weirdnessSupported, setWeirdnessSupported] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName(model?.displayName ?? prefill?.displayName ?? '');
    setModelId(model?.modelId ?? prefill?.modelId ?? '');
    setProviderId(
      model?.providerId ?? prefill?.providerId ?? defaultProviderId ?? providers[0]?.id ?? '',
    );
    setBaseUrlOverride(model?.baseUrlOverride ?? '');
    setDescription(model?.description ?? '');
    setCapabilities(model ? makeCapabilities(model.capabilities) : EMPTY_CAPABILITIES);
    setContextWindow(
      typeof model?.limits.contextWindow === 'number' ? String(model.limits.contextWindow) : '',
    );
    setMaxOutputTokens(
      typeof model?.limits.maxOutputTokens === 'number' ? String(model.limits.maxOutputTokens) : '',
    );
    setSupportedParams(model?.supportedParams ?? []);
    setWeirdnessSupported(model?.weirdnessSupported ?? false);
    setSubmitted(false);
    setSaving(false);
    setError(null);
  }, [open, model, prefill, defaultProviderId, providers]);

  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    description: provider.baseUrl,
  }));

  const contextCheck = parseOptionalCount(contextWindow);
  const outputCheck = parseOptionalCount(maxOutputTokens);
  const overrideCheck =
    baseUrlOverride.trim().length === 0
      ? null
      : validateEndpointUrl(baseUrlOverride, policy);

  const displayNameError =
    submitted && displayName.trim().length === 0 ? 'A display name is required.' : undefined;
  const modelIdError =
    submitted && modelId.trim().length === 0
      ? 'The exact model id is required, for example gpt-4o-mini.'
      : undefined;
  const providerError =
    submitted && providerId.length === 0 ? 'Choose the provider this model belongs to.' : undefined;
  const overrideError =
    overrideCheck && !overrideCheck.ok ? overrideCheck.reason : undefined;
  const contextError =
    contextCheck === 'invalid' ? 'The context window must be a whole number of tokens.' : undefined;
  const outputError =
    outputCheck === 'invalid' ? 'The output limit must be a whole number of tokens.' : undefined;

  /**
   * Turning a capability off also drops the ones that needed it, so the form can
   * never display a pair that the saved value does not contain.
   */
  const toggleCapability = (key: CapabilityKey): void => {
    setCapabilities((current) =>
      normalizeCapabilities({ ...current, [key]: !current[key] }),
    );
  };

  const toggleParam = (key: GenParamKey): void => {
    setSupportedParams((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  };

  const submit = async (): Promise<void> => {
    setSubmitted(true);
    setError(null);
    const endpointOk =
      baseUrlOverride.trim().length === 0 || (overrideCheck !== null && overrideCheck.ok);
    if (
      displayName.trim().length === 0 ||
      modelId.trim().length === 0 ||
      providerId.length === 0 ||
      contextCheck === 'invalid' ||
      outputCheck === 'invalid' ||
      !endpointOk
    ) {
      return;
    }

    const limits = {
      ...(typeof contextCheck === 'number' ? { contextWindow: contextCheck } : {}),
      ...(typeof outputCheck === 'number' ? { maxOutputTokens: outputCheck } : {}),
    };
    const input: CustomModelInput = {
      ...(model ? { id: model.id } : {}),
      providerId,
      displayName: displayName.trim(),
      modelId: modelId.trim(),
      baseUrlOverride:
        overrideCheck && overrideCheck.ok ? overrideCheck.url : null,
      description: description.trim(),
      capabilities: normalizeCapabilities(capabilities),
      limits,
      supportedParams,
      weirdnessSupported,
    };

    setSaving(true);
    try {
      onSaved(await getApi().models.upsert(input));
      onClose();
    } catch (thrown) {
      setError(errorSummary(asAppError(thrown)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={model ? `Edit ${model.displayName}` : 'Add a custom model'}
      description="Use this when a provider serves a model that discovery cannot see, or when you need to state exactly which parameters it honours."
      closeOnOverlayClick={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => {
              void submit();
            }}
          >
            {model ? 'Save model' : 'Add model'}
          </Button>
        </>
      }
    >
      <div className="pds-form-grid">
        <Input
          label="Display name"
          value={displayName}
          maxLength={120}
          placeholder="My fine-tuned model"
          onChange={(event) => setDisplayName(event.target.value)}
          error={displayNameError}
        />
        <Input
          label="Exact model id"
          value={modelId}
          maxLength={200}
          spellCheck={false}
          placeholder="ft:gpt-4o-mini:my-org"
          onChange={(event) => setModelId(event.target.value)}
          error={modelIdError}
          hint="Sent to the provider verbatim. It is never rewritten."
        />
      </div>

      <Select
        label="Provider"
        value={providerId}
        options={providerOptions}
        onChange={setProviderId}
        placeholder={providers.length === 0 ? 'Add a provider first' : 'Choose a provider'}
        disabled={providers.length === 0}
        error={providerError}
      />

      <Input
        label="Endpoint override"
        value={baseUrlOverride}
        placeholder="https://gateway.example.com/v1"
        spellCheck={false}
        onChange={(event) => setBaseUrlOverride(event.target.value)}
        error={overrideError}
        hint="Optional. Only set this when the model lives on a different endpoint than its provider."
      />

      <Textarea
        label="Description"
        rows={2}
        value={description}
        maxLength={2000}
        onChange={(event) => setDescription(event.target.value)}
        hint="Shown under the model name. A sentence is enough."
      />

      <fieldset className="pds-form-fieldset">
        <legend className="pds-form-legend">Capabilities</legend>
        <p className="pds-form-hint">
          What this model does. A capability left off is never assumed, and the pickers only offer
          a model for a task it declares.
        </p>
        {CAPABILITY_GROUPS.map((group) => (
          <fieldset className="pds-form-fieldset" key={group.title}>
            <legend className="pds-params__legend">{group.title}</legend>
            {group.keys.map((key) => {
              const { hint, disabled } = capabilityHint(key, capabilities);
              return (
                <Switch
                  key={key}
                  label={CAPABILITY_LABEL[key]}
                  checked={capabilities[key]}
                  disabled={disabled}
                  hint={hint}
                  onChange={() => toggleCapability(key)}
                />
              );
            })}
          </fieldset>
        ))}
      </fieldset>

      <div className="pds-form-grid">
        <Input
          label="Context window"
          type="number"
          inputMode="numeric"
          min={1}
          value={contextWindow}
          onChange={(event) => setContextWindow(event.target.value)}
          error={contextError}
          hint="Tokens. Leave blank when the provider does not document it."
        />
        <Input
          label="Max output tokens"
          type="number"
          inputMode="numeric"
          min={1}
          value={maxOutputTokens}
          onChange={(event) => setMaxOutputTokens(event.target.value)}
          error={outputError}
          hint="Tokens. Leave blank when unknown."
        />
      </div>

      <fieldset className="pds-form-fieldset">
        <legend className="pds-form-legend">Parameters this model honours</legend>
        <div className="pds-chips" role="group" aria-label="Parameters this model honours">
          {DEBUG_PARAM_KEYS.map((key) => {
            const selected = supportedParams.includes(key);
            return (
              <Button
                key={key}
                size="sm"
                variant="secondary"
                className="pds-chip"
                aria-pressed={selected}
                onClick={() => toggleParam(key)}
              >
                {PARAM_SPECS[key].label}
              </Button>
            );
          })}
        </div>
        <p className="pds-form-hint">
          A parameter that is not selected is never sent to this model, even when a conversation
          sets it.
        </p>
      </fieldset>

      <Switch
        label="Supports weirdness"
        checked={weirdnessSupported}
        onChange={setWeirdnessSupported}
        hint="Only enable this when the endpoint documents a weirdness parameter of its own. For every other model the control stays off and no value is sent."
      />

      {error ? (
        <p className="pds-form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
