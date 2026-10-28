import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage, Conversation, ModelDescriptor } from '@shared/types';
import { __setApiForTest } from '@renderer/lib/api';
import { useChatStore, useShellStore } from '@renderer/lib/store';
import { ChatPage } from '@renderer/pages/chat/ChatPage';
import {
  createFakeApi,
  makeConversation,
  makeModel,
  type FakeApi,
} from './fake-api';

export interface ChatHarness {
  fake: FakeApi;
  user: ReturnType<typeof userEvent.setup>;
  conversation: Conversation;
  sendButton(): HTMLElement;
  textarea(): HTMLElement;
  attachFileButton(): HTMLElement;
  attachImageButton(): HTMLElement;
  recordButton(): HTMLElement;
}

export interface RenderConversationOptions {
  messages?: ChatMessage[];
  models?: ModelDescriptor[];
  conversation?: Partial<Conversation>;
}

/** Render the chat page against a fake bridge with one conversation open. */
export async function renderConversation(
  options: RenderConversationOptions = {},
): Promise<ChatHarness> {
  const conversation = makeConversation({ id: 'c1', messageCount: 0, ...options.conversation });
  const fake = createFakeApi({
    conversations: [conversation],
    messages: { [conversation.id]: options.messages ?? [] },
    models: options.models ?? [makeModel()],
  });
  __setApiForTest(fake.api);
  useShellStore.setState({ route: { name: 'chat', conversationId: conversation.id } });
  // The App shell owns the single `chat.onEvent` subscription in production;
  // the harness renders the page alone, so it mirrors that one subscription.
  fake.api.chat.onEvent((event) => useChatStore.getState().applyEvent(event));
  render(<ChatPage />);
  return {
    fake,
    user: userEvent.setup(),
    conversation,
    sendButton: () => screen.getByRole('button', { name: 'Send message' }),
    textarea: () => screen.getByLabelText('Message'),
    attachFileButton: () => screen.getByRole('button', { name: 'Attach file' }),
    attachImageButton: () => screen.getByRole('button', { name: 'Attach image' }),
    recordButton: () => screen.getByRole('button', { name: 'Record voice' }),
  };
}

/** Text currently rendered for the streaming assistant turn. */
export function streamedAssistantText(): string {
  const node = document.querySelector('.pds-message--streaming .pds-message__body');
  return node?.textContent ?? '';
}
