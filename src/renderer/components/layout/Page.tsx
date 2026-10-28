import type { ReactElement, ReactNode } from 'react';
import { useHeadingFocus } from '@renderer/lib/hooks';

export interface PageProps {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Standard page frame: one h1 that receives focus when the page mounts, a
 * description, and an optional action cluster. Route changes move focus here,
 * which is what a keyboard or screen-reader user needs after navigation.
 */
export function Page({ title, description, actions, children, className }: PageProps): ReactElement {
  const headingRef = useHeadingFocus<HTMLHeadingElement>();

  return (
    <div className={className ? `pds-page ${className}` : 'pds-page'}>
      <header className="pds-page__header">
        <div className="pds-page__heading">
          <h1 ref={headingRef} tabIndex={-1} className="pds-page__title">
            {title}
          </h1>
          <p className="pds-page__description">{description}</p>
        </div>
        {actions ? <div className="pds-page__actions">{actions}</div> : null}
      </header>
      <div className="pds-page__body">{children}</div>
    </div>
  );
}
