import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  List,
  ListItem,
  Select,
  Skeleton,
  Slider,
  Switch,
  Tabs,
  Textarea,
  Toast,
  Tooltip,
  tabPanelId,
} from '@renderer/components/ui';
import { CheckIcon, SettingsIcon } from '@renderer/components/icons';

const OPTIONS = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta', description: 'The second one' },
];

describe('Button', () => {
  it('renders its label and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled and non-interactive when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its accessible name and reports busy while loading', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('exposes the danger variant as a normal button with a visible label', () => {
    render(<Button variant="danger">Delete conversation</Button>);
    expect(screen.getByRole('button', { name: 'Delete conversation' })).toHaveClass(
      'pds-btn--danger',
    );
  });
});

describe('IconButton', () => {
  it('takes its accessible name from the required label', () => {
    render(<IconButton label="Delete conversation" icon={<SettingsIcon />} />);
    expect(screen.getByRole('button', { name: 'Delete conversation' })).toHaveAccessibleName(
      'Delete conversation',
    );
  });

  it('shows a tooltip on focus and links it with aria-describedby', async () => {
    render(<IconButton label="Delete conversation" icon={<SettingsIcon />} />);
    const button = screen.getByRole('button', { name: 'Delete conversation' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await userEvent.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Delete conversation');
    expect(button).toHaveAttribute('aria-describedby', tooltip.id);

    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows a tooltip on hover', async () => {
    render(<IconButton label="Rename conversation" icon={<SettingsIcon />} />);
    await userEvent.hover(screen.getByRole('button', { name: 'Rename conversation' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Rename conversation');
  });

  it('is disabled and marked busy while loading', () => {
    render(<IconButton label="Saving" icon={<SettingsIcon />} loading />);
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Field and text controls', () => {
  it('labels the input with a real label element and links the hint', () => {
    render(<Input label="Conversation title" hint="Up to 200 characters." value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText('Conversation title');
    const hint = screen.getByText('Up to 200 characters.');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('aria-describedby', hint.id);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('replaces the hint with the error and marks the control invalid', () => {
    render(
      <Input
        label="API key"
        hint="Never shown again."
        error="A key is required."
        value=""
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('API key');
    const error = screen.getByRole('alert');
    expect(screen.queryByText('Never shown again.')).not.toBeInTheDocument();
    expect(error).toHaveTextContent('A key is required.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', error.id);
  });

  it('marks required in the label text rather than with an asterisk alone', () => {
    render(
      <Field label="Model id" required>
        {({ id }) => <input id={id} />}
      </Field>,
    );
    expect(screen.getByLabelText(/Model id \(required\)/)).toBeInTheDocument();
  });

  it('renders a disabled textarea with its label intact', () => {
    render(<Textarea label="System prompt" value="" onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('System prompt')).toBeDisabled();
  });
});

describe('Select (custom listbox)', () => {
  it('opens a listbox, selects an option and closes', async () => {
    const onChange = vi.fn();
    render(<Select label="Model" value="alpha" options={OPTIONS} onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(2);

    await userEvent.click(within(listbox).getByRole('option', { name: /Beta/ }));
    expect(onChange).toHaveBeenCalledWith('beta');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('is operable from the keyboard', async () => {
    const onChange = vi.fn();
    render(
      <Select label="Model" value="" options={OPTIONS} onChange={onChange} placeholder="Pick one" />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('beta');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape and on Tab', async () => {
    render(<Select label="Model" value="alpha" options={OPTIONS} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    await userEvent.keyboard('{Tab}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders disabled and error states with the right aria attributes', () => {
    const { rerender } = render(
      <Select label="Model" value="" options={OPTIONS} onChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();

    rerender(
      <Select label="Model" value="" options={OPTIONS} onChange={vi.fn()} error="Pick a model." />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    const error = screen.getByRole('alert');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', error.id);
  });
});

describe('Slider and Switch', () => {
  it('labels the slider and exposes the formatted value', () => {
    render(
      <Slider
        label="Temperature"
        value={0.7}
        min={0}
        max={2}
        step={0.05}
        onChange={vi.fn()}
        formatValue={(value) => value.toFixed(2)}
      />,
    );
    const slider = screen.getByLabelText('Temperature');
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('aria-valuetext', '0.70');
    expect(screen.getByText('0.70')).toBeInTheDocument();
  });

  it('reports the new value on change and can be disabled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Slider label="Temperature" value={0.7} min={0} max={2} step={0.1} onChange={onChange} />,
    );
    const slider = screen.getByLabelText('Temperature');
    fireEvent.change(slider, { target: { value: '0.8' } });
    expect(onChange).toHaveBeenCalledWith(0.8);

    rerender(
      <Slider label="Temperature" value={0.7} min={0} max={2} step={0.1} onChange={onChange} disabled />,
    );
    expect(screen.getByLabelText('Temperature')).toBeDisabled();
  });

  it('exposes the switch role, its name and its checked state', async () => {
    const onChange = vi.fn();
    render(
      <Switch label="Send on Enter" checked={false} onChange={onChange} hint="Enter sends." />,
    );
    const control = screen.getByRole('switch', { name: 'Send on Enter' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    const hint = screen.getByText('Enter sends.');
    expect(control).toHaveAttribute('aria-describedby', hint.id);

    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('marks a disabled switch disabled', () => {
    render(<Switch label="Send on Enter" checked onChange={vi.fn()} disabled />);
    expect(screen.getByRole('switch', { name: 'Send on Enter' })).toBeDisabled();
  });
});

describe('feedback primitives', () => {
  it('renders a badge with its text, not colour alone', () => {
    render(<Badge tone="warning">Not built yet</Badge>);
    expect(screen.getByText('Not built yet')).toBeInTheDocument();
  });

  it('announces a skeleton load and reserves the requested lines', () => {
    render(<Skeleton lines={4} label="Loading conversations" />);
    const status = screen.getByRole('status', { name: 'Loading conversations' });
    expect(status.querySelectorAll('.pds-skeleton')).toHaveLength(4);
  });

  it('renders an empty state with exactly one action', async () => {
    const onAction = vi.fn();
    render(
      <EmptyState
        title="No conversations yet"
        description="Start one and it stays on this device."
        action={<Button onClick={onAction}>New conversation</Button>}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No conversations yet');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(onAction).toHaveBeenCalled();
  });

  it('renders an error state and retries', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Load failed" description="The database is locked." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Load failed');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a toast with its message and dismisses it', async () => {
    const onDismiss = vi.fn();
    render(
      <Toast
        item={{ id: 'toast-1', title: 'Copied to the clipboard', variant: 'success' }}
        onDismiss={onDismiss}
        durationMs={100000}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Copied to the clipboard');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledWith('toast-1');
  });

  it('auto-dismisses a toast after its timeout', async () => {
    const onDismiss = vi.fn();
    render(
      <Toast item={{ id: 'toast-2', title: 'Saved', variant: 'info' }} onDismiss={onDismiss} durationMs={20} />,
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('toast-2'));
  });
});

describe('Tabs, Card and List', () => {
  function TabsProbe(): ReactElement {
    const [value, setValue] = useState('one');
    return (
      <>
        <Tabs
          label="Sections"
          items={[
            { id: 'one', label: 'One' },
            { id: 'two', label: 'Two' },
          ]}
          value={value}
          onChange={setValue}
        />
        <div role="tabpanel" id={tabPanelId(value)} aria-labelledby={`pds-tab-${value}`}>
          Panel {value}
        </div>
      </>
    );
  }

  it('moves the selection with the arrow keys and a roving tabindex', async () => {
    render(<TabsProbe />);
    const one = screen.getByRole('tab', { name: 'One' });
    expect(one).toHaveAttribute('aria-selected', 'true');
    expect(one).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('tabindex', '-1');

    one.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two');
  });

  it('renders a card and a labelled list', () => {
    render(
      <Card>
        <CardHeader title="Planned for this screen" />
        <CardBody>
          <List label="Planned">
            <ListItem icon={<CheckIcon />}>Create an agent</ListItem>
          </List>
        </CardBody>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Planned for this screen' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Planned' })).toHaveTextContent('Create an agent');
  });
});

describe('Tooltip', () => {
  it('appears on hover and names the annotated content', async () => {
    render(
      <Tooltip label="Keys stay local">
        <span>Storage</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await userEvent.hover(screen.getByText('Storage'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Keys stay local');
  });
});
