import { useEffect, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, CloseIcon, InfoIcon } from '../icons';
import { TOAST_DURATION_MS, useToastStore, type ToastItem } from '@renderer/lib/toast';
import { IconButton } from './IconButton';

export interface ToastProps {
  item: ToastItem;
  onDismiss(id: string): void;
  /** Auto-dismiss delay; tests can pass a large value to control timing. */
  durationMs?: number;
}

const VARIANT_ICON = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: AlertTriangleIcon,
  danger: AlertCircleIcon,
} as const;

/**
 * One notification. The variant is carried by an icon, a border and the text —
 * never by colour alone. Dismiss is a real button so the toast is reachable from
 * the keyboard, and the timer pauses nothing it cannot resume: a fresh toast is
 * a new element with its own timer.
 */
export function Toast({ item, onDismiss, durationMs = TOAST_DURATION_MS }: ToastProps): ReactElement {
  const VariantIcon = VARIANT_ICON[item.variant];

  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), durationMs);
    return () => window.clearTimeout(timer);
  }, [item.id, onDismiss, durationMs]);

  return (
    <div
      className={`pds-toast pds-toast--${item.variant}`}
      role={item.variant === 'danger' || item.variant === 'warning' ? 'alert' : 'status'}
      data-testid="toast"
    >
      <span className="pds-toast__icon" aria-hidden="true">
        <VariantIcon />
      </span>
      <div className="pds-toast__text">
        <p className="pds-toast__title">{item.title}</p>
        {item.description ? <p className="pds-toast__description">{item.description}</p> : null}
      </div>
      <IconButton
        label="Dismiss notification"
        icon={<CloseIcon />}
        size="sm"
        tone="ghost"
        onClick={() => onDismiss(item.id)}
      />
    </div>
  );
}

/** Store-connected host. Mounted once by the app shell. */
export function ToastHost(): ReactElement | null {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);

  if (items.length === 0) return null;

  return createPortal(
    <div className="pds-toast-host" aria-live="polite" aria-label="Notifications">
      {items.map((item) => (
        <Toast key={item.id} item={item} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
