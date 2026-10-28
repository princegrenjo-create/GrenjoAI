import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  /** Exactly one action, when the state can be cleared from here. */
  action?: ReactNode;
  className?: string;
}

/**
 * The empty state says what would be here, why it is empty, and offers one
 * action that fills it. Centred text is allowed here and nowhere else.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={className ? `pds-empty ${className}` : 'pds-empty'}
      role="status"
      data-testid="empty-state"
    >
      {icon ? (
        <span className="pds-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="pds-empty__title">{title}</p>
      <p className="pds-empty__description">{description}</p>
      {action ? <div className="pds-empty__action">{action}</div> : null}
    </div>
  );
}
