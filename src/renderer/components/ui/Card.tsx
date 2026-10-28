import type { ReactElement, ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Bordered surfaces get no shadow: elevation is reserved for overlays. */
  as?: 'div' | 'section' | 'article';
}

export function Card({ children, className, as = 'div' }: CardProps): ReactElement {
  const Tag = as;
  return (
    <Tag className={className ? `pds-card ${className}` : 'pds-card'}>{children}</Tag>
  );
}

export interface CardHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps): ReactElement {
  return (
    <header className="pds-card__header">
      <div className="pds-card__heading">
        <h3 className="pds-card__title">{title}</h3>
        {description ? <p className="pds-card__description">{description}</p> : null}
      </div>
      {actions ? <div className="pds-card__actions">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children }: { children: ReactNode }): ReactElement {
  return <div className="pds-card__body">{children}</div>;
}

export interface ListProps {
  children: ReactNode;
  /** Accessible name for the list. */
  label?: string;
  className?: string;
  ordered?: boolean;
}

export function List({ children, label, className, ordered = false }: ListProps): ReactElement {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={['pds-list', ordered ? 'pds-list--ordered' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
    >
      {children}
    </Tag>
  );
}

export interface ListItemProps {
  children: ReactNode;
  /** Leading glyph; decorative, the text carries the meaning. */
  icon?: ReactNode;
  className?: string;
}

export function ListItem({ children, icon, className }: ListItemProps): ReactElement {
  return (
    <li className={className ? `pds-list__item ${className}` : 'pds-list__item'}>
      {icon ? (
        <span className="pds-list__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="pds-list__text">{children}</span>
    </li>
  );
}
