import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError } from '@shared/errors';
import type { Conversation } from '@shared/types';
import { useConversationsStore } from '@renderer/lib/store';
import { ConversationSidebar } from '@renderer/pages/chat/ConversationSidebar';
import { __setApiForTest } from '@renderer/lib/api';
import { resetStores } from './helpers/state';
import { createFakeApi, makeConversation, type FakeApi } from './helpers/fake-api';

let fake: FakeApi;

beforeEach(() => {
  resetStores();
  fake = createFakeApi({
    conversations: [
      makeConversation({ id: 'c1', title: 'Plan the week', messageCount: 4 }),
      makeConversation({ id: 'c2', title: 'Sprint retro', messageCount: 2 }),
    ],
  });
  __setApiForTest(fake.api);
});

function renderSidebar(items: Conversation[], activeId: string | null = 'c1') {
  useConversationsStore.setState({ items, status: 'ready', search: '', error: null });
  const onSelect = vi.fn();
  const onDeleted = vi.fn();
  render(<ConversationSidebar activeId={activeId} onSelect={onSelect} onDeleted={onDeleted} />);
  return { onSelect, onDeleted };
}

function bothConversations(): Conversation[] {
  return fake.conversations.map((item) => ({ ...item }));
}

describe('Conversation sidebar', () => {
  it('lists conversations and marks the active one', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSidebar(bothConversations());

    const active = screen.getByRole('button', { name: /^Plan the week/ });
    expect(active).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Sprint retro')).toBeInTheDocument();

    await user.click(active);
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('filters through the bridge as the search changes', async () => {
    const user = userEvent.setup();
    renderSidebar(bothConversations());

    await user.type(screen.getByLabelText('Search conversations'), 'retro');

    await waitFor(() =>
      expect(fake.api.conversations.list).toHaveBeenLastCalledWith({ search: 'retro' }),
    );
    expect(await screen.findByText('Sprint retro')).toBeInTheDocument();
    expect(screen.queryByText('Plan the week')).not.toBeInTheDocument();
  });

  it('shows a no-matches state with a single clear action', async () => {
    const user = userEvent.setup();
    renderSidebar(bothConversations());

    await user.type(screen.getByLabelText('Search conversations'), 'zzz');

    expect(await screen.findByText('No matches')).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: 'Clear search' });
    await user.click(clear);

    await waitFor(() => expect(fake.api.conversations.list).toHaveBeenLastCalledWith(undefined));
    expect(await screen.findByText('Plan the week')).toBeInTheDocument();
  });

  it('renders a loading state reserved for the list', () => {
    useConversationsStore.setState({ items: [], status: 'loading', search: '', error: null });
    render(<ConversationSidebar activeId={null} onSelect={vi.fn()} onDeleted={vi.fn()} />);

    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
  });

  it('renders a load error and retries', async () => {
    const user = userEvent.setup();
    useConversationsStore.setState({
      items: [],
      status: 'error',
      search: '',
      error: appError('storage', 'The database file is locked.'),
    });
    render(<ConversationSidebar activeId={null} onSelect={vi.fn()} onDeleted={vi.fn()} />);

    expect(screen.getByText('Conversations could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(fake.api.conversations.list).toHaveBeenCalled());
  });

  it('renders an empty state and starts a new conversation', async () => {
    const user = userEvent.setup();
    useConversationsStore.setState({ items: [], status: 'ready', search: '', error: null });
    const onSelect = vi.fn();
    render(<ConversationSidebar activeId={null} onSelect={onSelect} onDeleted={vi.fn()} />);

    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New conversation' }));

    await waitFor(() => expect(fake.api.conversations.create).toHaveBeenCalled());
    const list = await screen.findByRole('list', { name: 'Conversations' });
    expect(within(list).getByRole('button', { name: /^New conversation/ })).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('conv-new-1');
  });

  it('renames through a dialog and persists the new title', async () => {
    const user = userEvent.setup();
    renderSidebar(bothConversations());

    await user.click(screen.getByRole('button', { name: 'Rename Plan the week' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename conversation' });
    const input = within(dialog).getByLabelText('Conversation title');
    expect(input).toHaveValue('Plan the week');

    await user.clear(input);
    await user.type(input, 'Weekly plan');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fake.api.conversations.update).toHaveBeenCalledWith('c1', { title: 'Weekly plan' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Weekly plan')).toBeInTheDocument();
  });

  it('asks before deleting, names the conversation, and never uses window.confirm', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onDeleted } = renderSidebar(bothConversations());

    await user.click(screen.getByRole('button', { name: 'Delete Plan the week' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete conversation?' });
    expect(dialog).toHaveAccessibleDescription(/Plan the week/);
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));

    await waitFor(() => expect(fake.api.conversations.remove).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onDeleted).toHaveBeenCalledWith('c1');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Plan the week')).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});
