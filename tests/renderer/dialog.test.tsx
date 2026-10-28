import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, Dialog, Input } from '@renderer/components/ui';

function DialogProbe({
  initialFocus,
}: {
  initialFocus?: 'form' | 'cancel';
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rename conversation"
        description="Only shown in this app."
        initialFocus={initialFocus}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Save
            </Button>
          </>
        }
      >
        <Input
          label="Conversation title"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens as a labelled modal and focuses the first form field', async () => {
    render(<DialogProbe />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await userEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Rename conversation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Only shown in this app.');
    expect(screen.getByLabelText('Conversation title')).toHaveFocus();
    expect(document.documentElement).toHaveClass('pds-scroll-lock');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<DialogProbe />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.documentElement).not.toHaveClass('pds-scroll-lock');
  });

  it('traps Tab inside the dialog and wraps in both directions', async () => {
    render(<DialogProbe />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));

    const close = screen.getByRole('button', { name: 'Close dialog' });
    const save = screen.getByRole('button', { name: 'Save' });

    save.focus();
    await userEvent.keyboard('{Tab}');
    expect(close).toHaveFocus();

    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(save).toHaveFocus();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts on the safe action for a destructive confirmation', async () => {
    render(<DialogProbe initialFocus="cancel" />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('closes when the scrim is pressed', async () => {
    render(<DialogProbe />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    await userEvent.click(screen.getByTestId('dialog-overlay'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
