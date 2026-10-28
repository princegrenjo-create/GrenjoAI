/**
 * Generation-parameter controls.
 *
 * There is exactly one implementation of the `PARAM_SPECS` -> control mapping,
 * used by Settings (application defaults) and by the Agents editor (per-agent
 * overrides). A second copy would be the way the two screens drift apart.
 *
 * Two behaviours are deliberate:
 *  - a parameter the selected model cannot carry is rendered *disabled with the
 *    reason*, never hidden and never silently sent;
 *  - a value outside the documented range is refused with a sentence quoting the
 *    range, so an impossible value never reaches the provider.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { PARAM_SPECS, type ParamControl, type ParamSpec } from '@shared/defaults';
import { DEBUG_PARAM_KEYS } from '@shared/params';
import type { GenParamKey, GenerationParams, ReasoningEffort } from '@shared/types';
import { Button, Input, Select, Slider, Textarea } from '@renderer/components/ui';
import './params.css';

type NumberParamKey = Exclude<GenParamKey, 'stop' | 'reasoningEffort'>;

function isNumberParam(key: GenParamKey): key is NumberParamKey {
  return key !== 'stop' && key !== 'reasoningEffort';
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

function rangeProblem(
  label: string,
  min: number | undefined,
  max: number | undefined,
  value: number,
): string | null {
  if (min !== undefined && value < min) return `${label} must be at least ${min}`;
  if (max !== undefined && value > max) return `${label} must be at most ${max}`;
  return null;
}

function assignNumber(
  values: GenerationParams,
  key: NumberParamKey,
  value: number,
): GenerationParams {
  const next: GenerationParams = { ...values };
  next[key] = value;
  return next;
}

function assignList(values: GenerationParams, stop: string[]): GenerationParams {
  const next: GenerationParams = { ...values };
  if (stop.length === 0) delete next.stop;
  else next.stop = stop;
  return next;
}

function assignReasoning(
  values: GenerationParams,
  effort: ReasoningEffort,
): GenerationParams {
  const next: GenerationParams = { ...values };
  next.reasoningEffort = effort;
  return next;
}

function numericValue(values: GenerationParams, key: GenParamKey, spec: ParamSpec): number {
  const raw = values[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof spec.defaultValue === 'number') return spec.defaultValue;
  return spec.min ?? 0;
}

function stopList(values: GenerationParams): string[] {
  return Array.isArray(values.stop) ? values.stop : [];
}

function isSupported(
  key: GenParamKey,
  spec: ParamSpec,
  supported: GenParamKey[] | null,
  weirdnessSupported: boolean,
): boolean {
  if (key === 'weirdness') {
    return Boolean(supported && weirdnessSupported && supported.includes('weirdness'));
  }
  if (supported === null) return !spec.providerSpecific;
  return supported.includes(key);
}

function disabledReason(
  key: GenParamKey,
  supported: GenParamKey[] | null,
): string {
  if (key === 'weirdness') {
    return 'The selected model has no weirdness parameter. The value is never mapped onto another sampling control.';
  }
  if (supported === null) {
    return 'Select a model first: this parameter is only forwarded to models that document it.';
  }
  return 'The selected model does not document this parameter, so it is not sent.';
}

export interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  hint?: string;
  disabled?: boolean;
  labelHidden?: boolean;
  /**
   * `change` commits every valid keystroke (a parameter that must feel live);
   * `blur` commits once editing ends, so a settings form does not write to the
   * database six times while a timeout is being typed.
   */
  commitOn?: 'change' | 'blur';
  onChange(value: number): void;
}

type ParseOutcome = { ok: true; value: number } | { ok: false; error: string };

/**
 * Numeric control that keeps the raw text the user typed. An out-of-range or
 * unparsable value is shown as a field error and is *not* committed, so the
 * parent never holds an impossible value.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  integer = false,
  hint,
  disabled = false,
  labelHidden = false,
  commitOn = 'change',
  onChange,
}: NumberFieldProps): ReactElement {
  const [text, setText] = useState<string>(String(value));
  const [error, setError] = useState<string | undefined>(undefined);

  // Re-sync from the committed value, but never while the text already expresses
  // it: overwriting on every keystroke would delete a trailing decimal point.
  useEffect(() => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed !== value) setText(String(value));
  }, [value]);

  const parse = (raw: string): ParseOutcome => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, error: `${label} is required.` };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { ok: false, error: `${label} must be a number` };
    const problem = rangeProblem(label, min, max, parsed);
    if (problem !== null) return { ok: false, error: problem };
    return { ok: true, value: integer ? Math.round(parsed) : parsed };
  };

  const commit = (): void => {
    const outcome = parse(text);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setError(undefined);
    if (outcome.value !== value) onChange(outcome.value);
  };

  const onTextChange = (raw: string): void => {
    setText(raw);
    const outcome = parse(raw);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setError(undefined);
    if (commitOn === 'change' && outcome.value !== value) onChange(outcome.value);
  };

  return (
    <Input
      label={label}
      labelHidden={labelHidden}
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(step !== undefined ? { step } : {})}
      value={text}
      disabled={disabled}
      hint={hint}
      error={error}
      onChange={(event) => onTextChange(event.target.value)}
      onBlur={commitOn === 'blur' ? commit : undefined}
      onKeyDown={
        commitOn === 'blur'
          ? (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }
          : undefined
      }
    />
  );
}

export interface GenerationParamControlsProps {
  values: GenerationParams;
  onChange(next: GenerationParams): void;
  /** Parameter keys the selected model accepts; null while no model is chosen. */
  supported: GenParamKey[] | null;
  /** Whether the selected model declares a native weirdness parameter. */
  weirdnessSupported: boolean;
  legend?: string;
  /** Show the documented description under each control. */
  showDescriptions?: boolean;
  /** Offer "Use default" for a parameter that currently carries a value. */
  onClear?(key: GenParamKey): void;
}

export function GenerationParamControls({
  values,
  onChange,
  supported,
  weirdnessSupported,
  legend = 'Generation parameters',
  showDescriptions = false,
  onClear,
}: GenerationParamControlsProps): ReactElement {
  const carriesValue = (key: GenParamKey): boolean => values[key] !== undefined;

  /**
   * Hint text. With descriptions on (Settings) it explains the parameter; in the
   * override editor it says whether the control is showing a stored override or
   * the application default, so a displayed value is never mistaken for one.
   */
  const hintFor = (key: GenParamKey, spec: ParamSpec, enabled: boolean): string | undefined => {
    if (showDescriptions) return spec.description;
    if (!enabled) return undefined;
    return carriesValue(key) ? undefined : 'Using the app default';
  };

  const renderControl = (key: GenParamKey, spec: ParamSpec, enabled: boolean): ReactElement => {
    const hint = hintFor(key, spec, enabled);
    const control: ParamControl = spec.control;
    switch (control) {
      case 'slider':
        return (
          <Slider
            label={spec.label}
            value={numericValue(values, key, spec)}
            min={spec.min ?? 0}
            max={spec.max ?? 1}
            step={spec.step ?? 0.01}
            disabled={!enabled}
            hint={hint}
            formatValue={(value) => String(value)}
            onChange={(value) => {
              if (!enabled || !isNumberParam(key)) return;
              onChange(assignNumber(values, key, value));
            }}
          />
        );
      case 'tokens':
      case 'number':
        return (
          <NumberField
            label={spec.label}
            value={numericValue(values, key, spec)}
            {...(spec.min !== undefined ? { min: spec.min } : {})}
            {...(spec.max !== undefined ? { max: spec.max } : {})}
            {...(spec.step !== undefined ? { step: spec.step } : {})}
            {...(spec.integer === true ? { integer: true } : {})}
            hint={hint}
            disabled={!enabled}
            onChange={(value) => {
              if (!enabled || !isNumberParam(key)) return;
              onChange(assignNumber(values, key, value));
            }}
          />
        );
      case 'list':
        return (
          <StopListControl
            value={stopList(values)}
            disabled={!enabled}
            hint={showDescriptions ? spec.description : 'One sequence per line, up to four.'}
            onChange={(stop) => {
              if (!enabled) return;
              onChange(assignList(values, stop));
            }}
          />
        );
      case 'select':
        return (
          <Select
            label={spec.label}
            value={
              isReasoningEffort(String(values.reasoningEffort ?? ''))
                ? (values.reasoningEffort as ReasoningEffort)
                : 'medium'
            }
            options={spec.options ?? []}
            disabled={!enabled}
            hint={hint}
            onChange={(value) => {
              if (!enabled || !isReasoningEffort(value)) return;
              onChange(assignReasoning(values, value));
            }}
          />
        );
      default:
        return <span className="pds-params__reason">{spec.label}</span>;
    }
  };

  return (
    <fieldset className="pds-params">
      <legend className="pds-params__legend">{legend}</legend>
      <div className="pds-params__grid">
        {DEBUG_PARAM_KEYS.map((key) => {
          const spec = PARAM_SPECS[key];
          const enabled = isSupported(key, spec, supported, weirdnessSupported);
          const carries = carriesValue(key);
          return (
            <div className="pds-params__item" key={key}>
              {renderControl(key, spec, enabled)}
              {enabled ? null : (
                <p className="pds-params__reason">{disabledReason(key, supported)}</p>
              )}
              {enabled && onClear && carries ? (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Use default ${spec.label}`}
                    onClick={() => onClear(key)}
                  >
                    Use default
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

interface StopListControlProps {
  value: string[];
  disabled: boolean;
  hint?: string;
  onChange(stop: string[]): void;
}

/** One stop sequence per line; the provider accepts at most four. */
function StopListControl({ value, disabled, hint, onChange }: StopListControlProps): ReactElement {
  const [text, setText] = useState<string>(value.join('\n'));
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const parsed = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (parsed.join('\n') !== value.join('\n')) setText(value.join('\n'));
  }, [value]);

  const onChangeText = (raw: string): void => {
    setText(raw);
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 4) {
      setError('At most 4 stop sequences are allowed');
      return;
    }
    setError(undefined);
    onChange(lines);
  };

  return (
    <Textarea
      label={PARAM_SPECS.stop.label}
      rows={2}
      value={text}
      disabled={disabled}
      hint={hint ?? 'One sequence per line, up to four.'}
      error={error}
      onChange={(event) => onChangeText(event.target.value)}
    />
  );
}
