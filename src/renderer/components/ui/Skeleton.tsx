import type { ReactElement } from 'react';

export interface SkeletonProps {
  /** Number of lines to reserve; keeps the layout from jumping on load. */
  lines?: number;
  /** Announced to assistive tech while content is pending. */
  label?: string;
  className?: string;
}

/**
 * Loading placeholder. It reserves the space the real content will take, is
 * `aria-hidden` per block, and exposes one polite status label instead of a pile
 * of empty boxes to a screen reader.
 */
export function Skeleton({ lines = 3, label = 'Loading', className }: SkeletonProps): ReactElement {
  return (
    <div
      className={className ? `pds-skeleton-group ${className}` : 'pds-skeleton-group'}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="pds-skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}
