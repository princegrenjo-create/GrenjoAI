import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { appError } from '@shared/errors';
import { useChatStore } from '@renderer/lib/store';
import { resetStores } from './helpers/state';
import { makeMessage, type FakeApi } from './helpers/fake-api';
import { renderConversation, streamedAssistantText } from './helpers/render-chat';
import { stubClipboard } from './helpers/clipboard';

function emitStart(fake: FakeApi): void {
  act(() => {
    fake.emit({
      type: 'start',
      requestId: 'req-1',
      conversationId: 'c1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      providerId: 'provider-1',
      modelId: 'deepseek-chat',
    });
  });
}

function emitDelta(fake: FakeApi, text: string): void {
  act(() => {
    fake.emit({ type: 'delta', requestId: 'req-1', assistantMessageId: 'asst-1', text });
  });
}

function emitDone(fake: FakeApi, content: string, finishReason: 'stop' | 'aborted'): void {
  act(() => {
    fake.emit({
      type: 'done',
      requestId: 'req-1',
      assistantMessageId: 'asst-1',
      finishReason,
      message: makeMessage({
        id: 'asst-1',
        conversationId: 'c1',
        role: 'assistant',
        content,
        status: finishReason === 'aborted' ? 'stopped' : 'complete',
        seq: 2,
      }),
    });
  });
}

async function sendHello(harness: Awaited<ReturnType<typeof renderConversation>>): Promise<void> {
  const { user, textarea, sendButton } = harness;
  await user.type(textarea(), 'Hello');
  await user.click(sendButton());
  await waitFor(() => expect(harness.fake.api.chat.send).toHaveBeenCalled());
}

beforeEach(() => {
  resetStores();
});

describe('Chat streaming', () => {
  it('appends deltas incrementally and keeps the concatenation as the final text', async () => {
    const harness = await renderConversation();
    const { fake, user, textarea, sendButton } = harness;
    await screen.findByText('This conversation is empty');

    await user.type(textarea(), 'Summarise the plan');
    await user.click(sendButton());

    await waitFor(() =>
      expect(fake.api.chat.send).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: 'Summarise the plan',
      }),
    );
    expect(useChatStore.getState().isSending).toBe(true);
    expect(screen.getByText('Summarise the plan')).toBeInTheDocument();

    emitStart(fake);
    expect(document.querySelector('.pds-message--streaming')).not.toBeNull();

    emitDelta(fake, 'Here is ');
    // Markdown drops the trailing space when it renders, so the visible text so
    // far is "Here is"; the stored stream buffer keeps it.
    expect(streamedAssistantText()).toBe('Here is');

    emitDelta(fake, 'the plan.');
    expect(streamedAssistantText()).toBe('Here is the plan.');

    // The persisted row is deliberately empty: the rendered final text must
    // still be the concatenation of the deltas the renderer received.
    emitDone(fake, '', 'stop');

    expect(document.querySelector('.pds-message--streaming')).toBeNull();
    const assistantBody = document.querySelector('.pds-message--assistant .pds-message__body');
    expect(assistantBody?.textContent).toContain('Here is the plan.');
    expect(useChatStore.getState().isSending).toBe(false);
    expect(screen.queryByText('The assistant is responding')).not.toBeInTheDocument();
  });

  it('renders a {type:error} event as an error card, never as an assistant bubble', async () => {
    const harness = await renderConversation();
    const { fake } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);

    const error = appError('rate_limited', 'The provider asked this client to slow down.');

    act(() => {
      fake.emit({
        type: 'error',
        requestId: 'req-1',
        assistantMessageId: 'asst-1',
        error,
        message: makeMessage({
          id: 'asst-1',
          conversationId: 'c1',
          role: 'assistant',
          content: '',
          status: 'error',
          error,
          seq: 2,
        }),
      });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('The provider is rate limiting this app');
    expect(screen.getByText('Error code: rate_limited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    const assistantBody = document.querySelector('.pds-message--assistant .pds-message__body');
    expect(assistantBody?.querySelector('.pds-markdown')).toBeNull();
    expect(document.querySelector('.pds-message[data-status="error"]')).not.toBeNull();
    expect(useChatStore.getState().isSending).toBe(false);
  });

  it('retries a failed turn by sending the last user message again', async () => {
    const harness = await renderConversation();
    const { fake, user } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);

    const error = appError('provider_error', 'The upstream gateway returned 502.');
    act(() => {
      fake.emit({
        type: 'error',
        requestId: 'req-1',
        assistantMessageId: 'asst-1',
        error,
        message: makeMessage({ id: 'asst-1', conversationId: 'c1', status: 'error', error }),
      });
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(fake.api.chat.send).toHaveBeenLastCalledWith({
        conversationId: 'c1',
        content: 'Hello',
      }),
    );
    expect(fake.api.chat.send).toHaveBeenCalledTimes(2);
  });

  it('shows Stop while streaming and calls chat.stop with the request id', async () => {
    const harness = await renderConversation();
    const { fake, user } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);

    await user.click(screen.getByRole('button', { name: 'Stop generating' }));

    await waitFor(() => expect(fake.api.chat.stop).toHaveBeenCalledWith('req-1'));
  });

  it('disables Send while a request is in flight and prevents a duplicate send', async () => {
    const harness = await renderConversation();
    const { fake, user, textarea, sendButton } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);

    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();

    await user.type(textarea(), 'Second message');
    await user.keyboard('{Enter}');

    expect(fake.api.chat.send).toHaveBeenCalledTimes(1);
  });

  it('marks an aborted stream as stopped rather than complete', async () => {
    const harness = await renderConversation();
    const { fake } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);
    emitDelta(fake, 'Partial answer');
    emitDone(fake, 'Partial answer', 'aborted');

    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
  });

  it('copies the exact assistant text', async () => {
    const harness = await renderConversation();
    const { fake, user } = harness;
    await screen.findByText('This conversation is empty');
    await sendHello(harness);
    emitStart(fake);
    emitDelta(fake, 'Here is the plan.');
    emitDone(fake, 'Here is the plan.', 'stop');

    // Install the clipboard spy after userEvent.setup(), which installs its own.
    const writeText = stubClipboard();

    await user.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(writeText).toHaveBeenCalledWith('Here is the plan.');
  });

  it('surfaces a rejected send call as an error card', async () => {
    const harness = await renderConversation();
    const { fake, user, textarea, sendButton } = harness;
    await screen.findByText('This conversation is empty');

    fake.mocks.chatSend.mockRejectedValueOnce(new Error('The bridge refused the request'));

    await user.type(textarea(), 'Hello');
    await user.click(sendButton());

    await waitFor(() => expect(fake.api.chat.send).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(document.querySelector('.pds-message[data-status="error"]')).not.toBeNull();
    expect(useChatStore.getState().isSending).toBe(false);
  });
});
