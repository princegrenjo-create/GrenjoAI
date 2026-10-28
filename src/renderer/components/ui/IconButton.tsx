import { useId, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Spinner } from './Spinner';

export type IconButtonTone = 'ghost' | 'secondary' | 'primary' | 'danger';
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  /** Required: the accessible name of the control. Also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  tone?: IconButtonTone;
  size?: IconButtonSize;
  loading?: boolean;
  tooltipPlacement?: 'top' | 'bottom' | 'right';
}

/**
 * Icon-only control. It cannot exist without a `label`: the label is the
 * accessible name (`aria-label`), the tooltip content, and the description
 * referenced while the tooltip is visible.
 */
export function IconButton({
  label,
  icon,
  tone = 'ghost',
  size = 'md',
  loading = false,
  tooltipPlacement = 'top',
  className,
  disabled,
  type = 'button',
  onClick,
  ...rest
}: IconButtonProps): ReactElement {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipId = useId();
  const classes = [
    'pds-icon-btn',
    `pds-icon-btn--${tone}`,
    size === 'sm' ? 'pds-icon-btn--sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className="pds-tip-anchor"
      onMouseEnter={() => setTooltipOpen(true)}
      onMouseLeave={() => setTooltipOpen(false)}
    >
      <button
        {...rest}
        type={type}
        className={classes}
        aria-label={label}
        aria-describedby={tooltipOpen ? tooltipId : undefined}
        aria-busy={loading || undefined}
        disabled={disabled === true || loading}
        onFocus={(event) => {
          setTooltipOpen(true);
          rest.onFocus?.(event);
        }}
        onBlur={(event) => {
          setTooltipOpen(false);
          rest.onBlur?.(event);
        }}
        onClick={onClick}
      >
        {loading ? <Spinner className="pds-spinner--current" /> : icon}
      </button>
      {tooltipOpen ? (
        <span
          role="tooltip"
          id={tooltipId}
          className={`pds-tooltip pds-tooltip--${tooltipPlacement}`}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
