/**
 * Add or edit a provider.
 *
 * The form validates the endpoint with the same shared URL policy the main
 * process uses, so an address the dialog accepts is an address the IPC layer
 * accepts. On failure the dialog stays open with every typed value intact —
 * retyping a base URL because a save failed is not a design.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { PROVIDER_PRESETS, PROVIDER_ORDER } from '@shared/defaults';
import { asAppError } from '@shared/errors';
import { validateEndpointUrl, type UrlPolicyOptions } from '@shared/url-policy';
import type { AppErrorShape, ProviderConfig, ProviderKind } from '@shared/types';
import { Button, Dialog, Input, Select } from '@renderer/components/ui';
import { errorSummary } from '@renderer/lib/error-copy';
import { openExternalLink } from '@renderer/lib/external';
import { getApi } from '@renderer/lib/api';

export interface ProviderDialogProps {
  open: boolean;
  /** Null creates a provider; a value edits that provider in place. */
  provider: ProviderConfig | null;
  policy: UrlPolicyOptions;
  onClose(): void;
  onSaved(provider: ProviderConfig): void;
}

const KIND_OPTIONS = PROVIDER_ORDER.map((kind) => ({
  value: kind,
  label: PROVIDER_PRESETS[kind].label,
  description: PROVIDER_PRESETS[kind].notes,
}));

export function ProviderDialog({
  open,
  provider,
  policy,
  onClose,
  onSaved,
}: ProviderDialogProps): ReactElement {
  const editing = provider !== null;
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'deepseek');
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppErrorShape | null>(null);

  /* Re-seed the draft whenever the dialog opens for a different target. A new
     provider starts from its preset, so the common case is one name and a key. */
  useEffect(() => {
    if (!open) return;
    const initialKind = provider?.kind ?? 'deepseek';
    const initialPreset = PROVIDER_PRESETS[initialKind];
    setKind(initialKind);
    setName(provider?.name ?? initialPreset.defaultName);
    setBaseUrl(
      provider?.baseUrl ??
        (initialPreset.defaultBaseUrl === 'https://' ? '' : initialPreset.defaultBaseUrl),
    );
    setSubmitted(false);
    setSaving(false);
    setError(null);
  }, [open, provider]);

  const preset = PROVIDER_PRESETS[kind];
  const urlCheck = useMemo(() => validateEndpointUrl(baseUrl, policy), [baseUrl, policy]);
  const nameError =
    submitted && name.trim().length === 0 ? 'A provider name is required.' : undefined;
  // Inline as soon as the field carries something: a plain-HTTP endpoint is
  // rejected while it is being typed, not after a failed save.
  const urlError =
    (submitted || baseUrl.trim().length > 0) && !urlCheck.ok ? urlCheck.reason : undefined;

  const onKindChange = (value: string): void => {
    const next = PROVIDER_ORDER.find((entry) => entry === value);
    if (!next) return;
    setKind(next);
    const nextPreset = PROVIDER_PRESETS[next];
    setName(nextPreset.defaultName);
    setBaseUrl(nextPreset.defaultBaseUrl === 'https://' ? '' : nextPreset.defaultBaseUrl);
    setSubmitted(false);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    setSubmitted(true);
    setError(null);
    if (name.trim().length === 0) return;
    const check = validateEndpointUrl(baseUrl, policy);
    if (!check.ok) return;
    setSaving(true);
    try {
      const saved = await getApi().providers.upsert({
        ...(editing && provider ? { id: provider.id } : {}),
        kind,
        name: name.trim(),
        baseUrl: check.url,
        enabled: provider?.enabled ?? true,
      });
      onSaved(saved);
      onClose();
    } catch (thrown) {
      // Values are deliberately left in place: the user fixes one field, not all.
      setError(asAppError(thrown));
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
      title={editing ? `Edit ${provider?.name ?? 'provider'}` : 'Add a provider'}
      description={
        editing
          ? 'The provider type cannot be changed here. Remove the provider and add it again if the type itself is wrong.'
          : 'A provider is one endpoint you hold a key for. You can add several accounts of the same type.'
      }
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
            {editing ? 'Save provider' : 'Add provider'}
          </Button>
        </>
      }
    >
      <Select
        label="Provider type"
        value={kind}
        options={KIND_OPTIONS}
        onChange={onKindChange}
        disabled={editing}
        hint={editing ? 'Create a new provider to change the type.' : preset.notes}
      />
      <Input
        label="Name"
        value={name}
        maxLength={80}
        placeholder={preset.defaultName}
        onChange={(event) => setName(event.target.value)}
        error={nameError}
        hint="Shown in the chat header and in the model list."
      />
      <Input
        label="Base URL"
        value={baseUrl}
        placeholder="https://api.example.com/v1"
        spellCheck={false}
        onChange={(event) => setBaseUrl(event.target.value)}
        error={urlError}
        hint="HTTPS only. Plain HTTP is accepted for a loopback address (localhost / 127.0.0.1) so a local gateway can be used."
      />
      {preset.consoleUrl ? (
        <p className="pds-provider__console">
          Keys for {preset.label} are created in the provider console.{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void openExternalLink(preset.consoleUrl);
            }}
          >
            Open provider console
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="pds-form-error" role="alert">
          {errorSummary(error)}
        </p>
      ) : null}
    </Dialog>
  );
}
