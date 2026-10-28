import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetStores, setSendOnEnter } from './helpers/state';
import { renderConversation } from './helpers/render-chat';

beforeEach(() => {
  resetStores();
});

describe('Composer', () => {
  it('sends on Enter and inserts a newline on Shift+Enter when sendOnEnter is on', async () => {
    setSendOnEnter(true);
    const { fake, user, textarea } = await renderConversation();
    await screen.findByText('This conversation is empty');

    await user.type(textarea(), 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(textarea()).toHaveValue('line one\n');
    expect(fake.api.chat.send).not.toHaveBeenCalled();

    await user.type(textarea(), 'line two');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(fake.api.chat.send).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: 'line one\nline two',
      }),
    );
    expect(textarea()).toHaveValue('');
  });

  it('inserts a newline on Enter and sends on Ctrl+Enter when sendOnEnter is off', async () => {
    setSendOnEnter(false);
    const { fake, user, textarea } = await renderConversation();
    await screen.findByText('This conversation is empty');

    await user.type(textarea(), 'line one');
    await user.keyboard('{Enter}');

    expect(textarea()).toHaveValue('line one\n');
    expect(fake.api.chat.send).not.toHaveBeenCalled();

    await user.type(textarea(), 'line two');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() =>
      expect(fake.api.chat.send).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: 'line one\nline two',
      }),
    );
  });

  it('describes the send-on-Enter convention when sendOnEnter is on', async () => {
    setSendOnEnter(true);
    await renderConversation();
    await screen.findByText('This conversation is empty');
    expect(screen.getByText('Enter sends · Shift+Enter adds a line')).toBeInTheDocument();
  });

  it('describes the Ctrl+Enter convention when sendOnEnter is off', async () => {
    setSendOnEnter(false);
    await renderConversation();
    await screen.findByText('This conversation is empty');
    expect(screen.getByText('Enter adds a line · Ctrl+Enter sends')).toBeInTheDocument();
  });

  it('disables Send for an empty or whitespace-only message', async () => {
    const { user, textarea, sendButton } = await renderConversation();
    await screen.findByText('This conversation is empty');

    expect(sendButton()).toBeDisabled();
    await user.type(textarea(), '   ');
    expect(sendButton()).toBeDisabled();
    await user.type(textarea(), 'ready');
    expect(sendButton()).toBeEnabled();
  });
});
