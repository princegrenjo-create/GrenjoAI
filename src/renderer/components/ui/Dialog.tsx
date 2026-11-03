import {
  useEffect,
  useId,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../icons';
import { IconButton } from './IconButton';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md';
  /** Destructive dialogs can opt out of dismiss-on-scrim. */
  closeOnOverlayClick?: boolean;
  /**
   * Where focus goes when the dialog opens. `form` prefers the first form
   * field; `cancel` prefers the first footer button, so a destructive confirm
   * starts on the safe choice.
   */
  initialFocus?: 'form' | 'cancel';
  /**
   * The ARIA role. `alertdialog` is the role for a confirmation that interrupts
   * the user with a warning — a destructive action — where a plain `dialog` is
   * an ordinary task surface. `ConfirmDialog` chooses it from its tone.
   */
  role?: 'dialog' | 'alertdialog';
}

/**
 * The project's modal. It is not a `<dialog>` with browser chrome: it is a
 * portal with a focus trap, Escape to close, focus restored to the trigger, a
 * body scroll lock, and `aria-modal` + labelled/described wiring. Destructive
 * confirmation is `ConfirmDialog` on top of this component — never
 * `window.confirm`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
  initialFocus = 'form',
  role = 'dialog',
}: DialogProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.documentElement.classList.add('pds-scroll-lock');

    const node = dialogRef.current;
    const preferred = node?.querySelector<HTMLElement>('[data-autofocus="true"]');
    const formField = node?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
    const footer = node?.querySelector<HTMLElement>('.pds-dialog__footer');
    const footerFirst = footer ? getFocusable(footer)[0] : undefined;
    const firstFocusable = getFocusable(node)[0];
    const fallbackOrder =
      initialFocus === 'cancel'
        ? [preferred, footerFirst, formField, firstFocusable]
        : [preferred, formField, firstFocusable];
    const initial = fallbackOrder.find((candidate): candidate is HTMLElement => Boolean(candidate));
    (initial ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const focusable = getFocusable(node);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        node.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !node.contains(active);
      if (event.shiftKey) {
        if (active === first || outside) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || outside) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.documentElement.classList.remove('pds-scroll-lock');
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const onOverlayMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && closeOnOverlayClick) onClose();
  };

  return createPortal(
    <div className="pds-dialog-overlay" onMouseDown={onOverlayMouseDown} data-testid="dialog-overlay">
      <div
        ref={dialogRef}
        className={`pds-dialog pds-dialog--${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="pds-dialog__header">
          <h2 className="pds-dialog__title" id={titleId}>
            {title}
          </h2>
          <IconButton label="Close dialog" icon={<CloseIcon />} size="sm" onClick={onClose} />
        </header>
        {description ? (
          <p className="pds-dialog__description" id={descriptionId}>
            {description}
          </p>
        ) : null}
        {children ? <div className="pds-dialog__body">{children}</div> : null}
        {footer ? <footer className="pds-dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
