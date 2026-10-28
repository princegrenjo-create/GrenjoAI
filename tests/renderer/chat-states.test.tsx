import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { appError } from '@shared/errors';
import type { ChatMessage, Conversation, ErrorCode } from '@shared/types';
import { __setApiForTest } from '@renderer/lib/api';
import { useShellStore } from '@renderer/lib/store';
import { ChatPage } from '@renderer/pages/chat/ChatPage';
import { resetStores } from './helpers/state';
import {
  createFakeApi,
  makeConversation,
  makeMessage,
  makeModel,
  type FakeApi,
} from './helpers/fake-api';

function openChat(options: { messages?: ChatMessage[]; conversation?: Partial<Conversation> } = {}): FakeApi {
  const conversation = makeConversation({ id: 'c1', messageCount: 0, ...options.conversation });
  const fake = createFakeApi({
    conversations: [conversation],
    messages: { c1: options.messages ?? [] },
    models: [makeModel()],
  });
  __setApiForTest(fake.api);
  useShellStore.setState({ route: { name: 'chat', conversationId: 'c1' } });
  render(<ChatPage />);
  return fake;
}

const ERROR_CASES: Array<[ErrorCode, string]> = [
  ['missing_key', 'No API key saved'],
  ['invalid_key', 'The provider rejected the key'],
  ['rate_limited', 'The provider is rate limiting this app'],
  ['timeout', 'The request timed out'],
  ['offline', 'You are offline'],
  ['provider_error', 'The provider failed to answer'],
  ['context_length', 'The conversation is longer than the model allows'],
  ['model_not_found', 'That model is not available'],
];

beforeEach(() => {
  resetStores();
});

describe('Chat page states', () => {
  it('renders the empty conversation state with the composer available', async () => {
    openChat();
    expect(await screen.findByText('This conversation is empty')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeEnabled();
  });

  it('renders a message skeleton while the conversation is fetched', async () => {
    const conversation = makeConversation({ id: 'c1' });
    const fake = createFakeApi({
      conversations: [conversation],
      messages: { c1: [] },
      models: [makeModel()],
    });
    fake.mocks.getConversation.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    __setApiForTest(fake.api);
    useShellStore.setState({ route: { name: 'chat', conversationId: 'c1' } });

    render(<ChatPage />);

    expect(await screen.findByRole('status', { name: 'Loading messages' })).toBeInTheDocument();
  });

  it('renders a load error and retries the request', async () => {
    const user = userEvent.setup();
    const conversation = makeConversation({ id: 'c1' });
    const fake = createFakeApi({
      conversations: [conversation],
      messages: { c1: [] },
      models: [makeModel()],
    });
    fake.mocks.getConversation.mockRejectedValueOnce(new Error('The database file is locked.'));
    __setApiForTest(fake.api);
    useShellStore.setState({ route: { name: 'chat', conversationId: 'c1' } });

    render(<ChatPage />);

    expect(await screen.findByText('This conversation could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/database file is locked/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fake.api.conversations.get).toHaveBeenCalledTimes(2));
  });

  for (const [code, title] of ERROR_CASES) {
    it(`renders the ${code} error as a card, not a bubble`, async () => {
      const error = appError(code, 'The provider said no.');
      const message = makeMessage({
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        content: '',
        status: 'error',
        error,
      });

      openChat({ messages: [message] });

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByText(`Error code: ${code}`)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(document.querySelector('.pds-message--assistant .pds-markdown')).toBeNull();
    });
  }

  it('sends the user to Models & Providers to fix a rejected key', async () => {
    const user = userEvent.setup();
    const error = appError('invalid_key', 'The provider rejected the API key.');
    openChat({
      messages: [
        makeMessage({
          id: 'm1',
          conversationId: 'c1',
          status: 'error',
          error,
        }),
      ],
    });

    await screen.findByText('The provider rejected the key');
    await user.click(screen.getByRole('button', { name: 'Open Models & Providers' }));

    expect(useShellStore.getState().route.name).toBe('models');
  });

  it('renders a model catalogue error with a retry', async () => {
    const user = userEvent.setup();
    const conversation = makeConversation({ id: 'c1' });
    const fake = createFakeApi({
      conversations: [conversation],
      messages: { c1: [] },
      models: [makeModel()],
    });
    fake.mocks.listModels.mockRejectedValueOnce(new Error('The model catalogue is unavailable.'));
    __setApiForTest(fake.api);
    useShellStore.setState({ route: { name: 'chat', conversationId: 'c1' } });

    render(<ChatPage />);

    expect(await screen.findByText('Models could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(fake.api.models.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Models could not be loaded')).toBeNull());
  });

  it('starts a conversation from the empty chat', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ conversations: [], models: [makeModel()] });
    __setApiForTest(fake.api);

    render(<ChatPage />);

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start a conversation' }));

    await waitFor(() => expect(fake.api.conversations.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(useShellStore.getState().route.conversationId).toBe('conv-new-1'),
    );
    expect(await screen.findByText('This conversation is empty')).toBeInTheDocument();
  });
});
