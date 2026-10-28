import type { ReactElement, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Small leading dot, for status badges where colour alone is not enough. */
  dot?: boolean;
  className?: string;
}

/** Small status label. Colour is never the only signal: the text says it too. */
export function Badge({ tone = 'neutral', children, dot = false, className }: BadgeProps): ReactElement {
  return (
    <span className={['pds-badge', `pds-badge--${tone}`, className ?? ''].filter(Boolean).join(' ')}>
      {dot ? <span className="pds-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
