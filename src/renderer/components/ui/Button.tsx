import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders the pending state: spinner overlay, aria-busy, width preserved. */
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

/**
 * The one button primitive. Variants: primary (one per view), secondary
 * (outline), ghost (quiet), danger (destructive). All eight states are styled in
 * controls.css; `loading` keeps the label in layout so width never jumps.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  const classes = [
    'pds-btn',
    `pds-btn--${variant}`,
    size === 'sm' ? 'pds-btn--sm' : '',
    block ? 'pds-btn--block' : '',
    loading ? 'pds-btn--loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      <span className="pds-btn__label">
        {icon ? <span className="pds-btn__icon">{icon}</span> : null}
        {children}
      </span>
      {loading ? (
        <span className="pds-btn__spinner">
          <Spinner className="pds-spinner--current" />
        </span>
      ) : null}
    </button>
  );
}
