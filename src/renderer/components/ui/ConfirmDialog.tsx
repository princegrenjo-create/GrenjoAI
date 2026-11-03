import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

/**
 * The one irreversibility sentence every destructive confirmation ends with.
 * It lives here rather than at the call sites so the delete flows cannot drift
 * into four different warnings again.
 */
export const DESTRUCTIVE_WARNING = 'This cannot be undone.';

export type ConfirmTone = 'danger' | 'default';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, naming the object it happens to. */
  description?: string;
  /**
   * The irreversibility line appended after `description`. It defaults to
   * `DESTRUCTIVE_WARNING` for a `danger` confirm and to nothing for a
   * reversible one; pass `null` to suppress it explicitly.
   */
  warning?: string | null;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * `danger` (the default) styles the action as destructive and raises the
   * dialog to `alertdialog` instead of a plain `dialog`.
   */
  tone?: ConfirmTone;
  /**
   * True while the confirmed action runs: the confirm button shows its pending
   * state, Cancel is disabled, the scrim cannot dismiss, and Escape is ignored.
   */
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  /** Extra detail under the description, such as the reason the last attempt failed. */
  children?: ReactNode;
}

/**
 * The project's confirmation prompt: `Dialog` with the confirmation contract
 * baked in. Cancel is the first focused control, the scrim never dismisses,
 * Escape is ignored while the action runs, focus returns to the invoking
 * element, and a destructive confirmation is an `alertdialog`. The pending
 * state reuses `Button`'s `loading`, so the label stays in layout and the width
 * does not jump. A product surface never uses `window.confirm` instead.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  warning,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps): ReactElement {
  const resolvedWarning =
    warning === undefined ? (tone === 'danger' ? DESTRUCTIVE_WARNING : null) : warning;
  const sentences = [description, resolvedWarning].filter(
    (sentence): sentence is string => typeof sentence === 'string' && sentence.trim().length > 0,
  );

  const close = (): void => {
    if (busy) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      role={tone === 'danger' ? 'alertdialog' : 'dialog'}
      title={title}
      description={sentences.length > 0 ? sentences.join(' ') : undefined}
      size="sm"
      initialFocus="cancel"
      closeOnOverlayClick={false}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={close}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
