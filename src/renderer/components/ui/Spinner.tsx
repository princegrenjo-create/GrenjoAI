import type { ReactElement } from 'react';

export interface SpinnerProps {
  /** Screen-reader text; omitted when the surrounding control already announces. */
  label?: string;
  className?: string;
}

/**
 * Indeterminate progress. Used inside buttons (which carry `aria-busy`) and in
 * short-lived inline loads; content areas use Skeleton instead.
 */
export function Spinner({ label, className }: SpinnerProps): ReactElement {
  return (
    <span
      className={className ? `pds-spinner ${className}` : 'pds-spinner'}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
