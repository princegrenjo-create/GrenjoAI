import type { ReactElement } from 'react';

export interface ProgressProps {
  /** 0–100 when the provider reports it; omit for an indeterminate bar. */
  value?: number | null;
  /** What is progressing, announced to assistive tech. */
  label: string;
  /** Shown next to the bar; omit when the label already says enough. */
  valueText?: string;
  className?: string;
}

/**
 * A determinate or indeterminate progress bar.
 *
 * `role="progressbar"` with `aria-valuenow` when the value is known, and no
 * `aria-valuenow` at all when it is not — an indeterminate bar that still reports
 * a number is a lie the screen reader repeats. The visible text carries the state
 * too, so colour is never the only signal.
 */
export function Progress({ value, label, valueText, className }: ProgressProps): ReactElement {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const clamped = determinate ? Math.min(100, Math.max(0, Math.round(value))) : undefined;

  return (
    <div className={className ? `pds-progress ${className}` : 'pds-progress'}>
      <div
        className="pds-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(clamped === undefined ? {} : { 'aria-valuenow': clamped })}
      >
        <div
          className={
            clamped === undefined
              ? 'pds-progress__fill pds-progress__fill--indeterminate'
              : 'pds-progress__fill'
          }
          style={clamped === undefined ? undefined : { width: `${clamped}%` }}
        />
      </div>
      <span className="pds-progress__value">
        {valueText ?? (clamped === undefined ? 'Working…' : `${clamped}%`)}
      </span>
    </div>
  );
}
