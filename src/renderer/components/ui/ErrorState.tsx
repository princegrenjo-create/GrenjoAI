import type { ReactElement, ReactNode } from 'react';
import { AlertCircleIcon } from '../icons';
import { Button } from './Button';

export interface ErrorStateProps {
  title: string;
  description: string;
  /** Extra, secondary detail (for example an error code), never a stack trace. */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Additional clearing action, e.g. "Open Settings". */
  children?: ReactNode;
  className?: string;
  /** Compact banner form used above a list instead of replacing the page. */
  inline?: boolean;
}

/**
 * The error state: a human sentence, the one action that clears it, and a
 * retry that only appears when retrying is honest. It is a landmark-free
 * region so it can be dropped into a page or a message list.
 */
export function ErrorState({
  title,
  description,
  detail,
  onRetry,
  retryLabel = 'Try again',
  children,
  className,
  inline = false,
}: ErrorStateProps): ReactElement {
  return (
    <div
      className={[
        inline ? 'pds-error pds-error--inline' : 'pds-error',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="alert"
      data-testid="error-state"
    >
      <span className="pds-error__icon" aria-hidden="true">
        <AlertCircleIcon />
      </span>
      <div className="pds-error__text">
        <p className="pds-error__title">{title}</p>
        <p className="pds-error__description">{description}</p>
        {detail ? <p className="pds-error__detail">{detail}</p> : null}
        {onRetry || children ? (
          <div className="pds-error__actions">
            {onRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : null}
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
