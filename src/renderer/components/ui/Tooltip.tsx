import { useState, type ReactElement, type ReactNode } from 'react';

export interface TooltipProps {
  label: string;
  children: ReactNode;
  placement?: 'top' | 'bottom' | 'right';
  className?: string;
}

/**
 * Tooltip for a non-button content element. It shows on hover and when anything
 * inside the wrapper receives focus, and it is never the only place a piece of
 * information lives. Icon-only buttons use IconButton, which owns its label —
 * this component is for annotating already-labelled content.
 */
export function Tooltip({
  label,
  children,
  placement = 'top',
  className,
}: TooltipProps): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={
        className ? `pds-tip-anchor ${className}` : 'pds-tip-anchor'
      }
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span role="tooltip" className={`pds-tooltip pds-tooltip--${placement}`}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
