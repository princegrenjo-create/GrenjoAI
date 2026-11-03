import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button,
  ConfirmDialog,
  DESTRUCTIVE_WARNING,
  type ConfirmTone,
} from '@renderer/components/ui';

interface HarnessProps {
  tone?: ConfirmTone;
  busy?: boolean;
  startOpen?: boolean;
  onConfirm?(): void;
  onClose?(): void;
}

const DESCRIPTION = '“Writing partner” will be removed from this device.';

/**
 * The page-sized usage: the page owns `open`, `busy` and the handler, exactly as
 * the chat, models and agents screens do.
 */
function Harness({
  tone,
  busy = false,
  startOpen = false,
  onConfirm = () => undefined,
  onClose = () => undefined,
}: HarnessProps): ReactElement {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open confirm
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Delete this agent?"
        description={DESCRIPTION}
        confirmLabel="Delete agent"
        busy={busy}
        onConfirm={onConfirm}
        {...(tone ? { tone } : {})}
      />
    </>
  );
}

/** A confirm whose owner flips `busy` on the first activate, as every page does. */
function AsyncHarness({ onConfirm }: { onConfirm(): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open confirm
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Delete this agent?"
        description={DESCRIPTION}
        confirmLabel="Delete agent"
        busy={busy}
        onConfirm={() => {
          onConfirm();
          setBusy(true);
        }}
      />
    </>
  );
}

function openConfirm(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: 'Open confirm' }));
}

describe('ConfirmDialog', () => {
  it('renders a destructive confirmation as an alertdialog with the one shared warning', async () => {
    render(<Harness />);
    await openConfirm();

    const dialog = screen.getByRole('alertdialog', { name: 'Delete this agent?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(`${DESCRIPTION} ${DESTRUCTIVE_WARNING}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts focus on Cancel and never on the confirm button', async () => {
    render(<Harness />);
    await openConfirm();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete agent' })).not.toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await openConfirm();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Open confirm' })).toHaveFocus();
  });

  it('ignores Escape while the action is running', async () => {
    const onClose = vi.fn();
    render(<Harness startOpen busy onClose={onClose} />);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a disabled, aria-busy confirm button and disables Cancel while busy', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Harness startOpen busy onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Delete agent' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm once, even when the confirm button is double-clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<AsyncHarness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Open confirm' }));

    await user.dblClick(screen.getByRole('button', { name: 'Delete agent' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps a reversible confirmation a plain dialog with no irreversibility warning', async () => {
    render(<Harness tone="default" />);
    await openConfirm();

    const dialog = screen.getByRole('dialog', { name: 'Delete this agent?' });
    expect(dialog).toHaveAccessibleDescription(DESCRIPTION);
    expect(dialog).not.toHaveAccessibleDescription(DESTRUCTIVE_WARNING);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete agent' })).toHaveClass('pds-btn--primary');
  });

  it('does not dismiss from the scrim, so a mis-click cannot cancel the prompt', async () => {
    const onClose = vi.fn();
    render(<Harness startOpen onClose={onClose} />);

    await userEvent.click(screen.getByTestId('dialog-overlay'));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('closes from Cancel without confirming', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<Harness startOpen onConfirm={onConfirm} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
