import type { ReactElement } from 'react';
import { Field } from './Field';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  formatValue?(value: number): string;
}

/** Range control. The track and thumb are styled from tokens, not the platform. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  error,
  disabled = false,
  formatValue,
}: SliderProps): ReactElement {
  const display = formatValue ? formatValue(value) : String(value);
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <span className="pds-slider">
          <input
            id={control.id}
            type="range"
            className={[
              'pds-slider__input',
              control.invalid ? 'pds-slider__input--invalid' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-invalid={control.invalid || undefined}
            aria-describedby={control.describedBy}
            aria-valuetext={display}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
          />
          <output className="pds-slider__value" htmlFor={control.id}>
            {display}
          </output>
        </span>
      )}
    </Field>
  );
}
