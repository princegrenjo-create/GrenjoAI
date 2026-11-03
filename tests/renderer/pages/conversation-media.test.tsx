/**
 * Media inside a conversation.
 *
 * Three behaviours the owner asked for, and one that is easy to get wrong:
 *  - a generation made from a chat belongs to that chat and is reachable from it;
 *  - the chat hands a message to the Image Studio instead of growing a generation
 *    form of its own;
 *  - a file that has been deleted reads as removed rather than as a broken image;
 *  - and the composer still has exactly the controls it had before.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationMedia } from '@shared/media';
import { useShellStore } from '@renderer/lib/store';
import { ChatPage } from '@renderer/pages/chat/ChatPage';
import { MediaCard } from '@renderer/components/media/MediaCard';
import { resetStores } from '../helpers/state';
import { makeConversation, makeMessage } from '../helpers/fake-api';
import { installApi, renderPage } from './support';
import { render } from '@testing-library/react';

function media(overrides: Partial<GenerationMedia> = {}): GenerationMedia {
  return {
    id: 'media-c1',
    kind: 'image',
    providerId: 'p-openai',
    modelId: 'gpt-image-2',
    prompt: 'A heron at dawn',
    negativePrompt: null,
    params: {},
    width: 1024,
    height: 1024,
    durationMs: null,
    bytes: 2048,
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    relativePath: `${'a'.repeat(2)}/${'a'.repeat(64)}.png`,
    conversationId: 'c-1',
    messageId: null,
    jobId: null,
    providerJobId: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function openChat(items: GenerationMedia[]) {
  const fake = installApi({
    conversations: [makeConversation({ id: 'c-1', title: 'Harbour notes' })],
    messages: {
      'c-1': [
        makeMessage({
          id: 'm-1',
          conversationId: 'c-1',
          role: 'assistant',
          content: 'A heron standing in shallow water at dawn.',
          seq: 1,
        }),
      ],
    },
  });
  fake.api.media.list = vi.fn(async () => items);
  fake.api.media.onEvent = vi.fn(() => () => undefined);
  useShellStore.setState({ route: { name: 'chat', conversationId: 'c-1' } });
  return { ...renderPage(fake, <ChatPage />), fake };
}

beforeEach(() => {
  resetStores();
});

describe('media in a conversation', () => {
  it('lists the media generated in the open conversation, and only that', async () => {
    openChat([media(), media({ id: 'other', conversationId: 'c-2', prompt: 'elsewhere' })]);

    const strip = await screen.findByRole('region', {
      name: 'Media generated in this conversation',
    });
    expect(within(strip).getByText(/Generated in this conversation \(1\)/)).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: /Image generated here/ })).toBeInTheDocument();
    expect(within(strip).queryByText(/elsewhere/)).toBeNull();
  });

  it('shows nothing when the conversation has no media', async () => {
    openChat([]);
    // The title appears in the sidebar and in the transcript header; either is fine
    // here, we only need the conversation to have rendered.
    await screen.findAllByText('Harbour notes');
    expect(
      screen.queryByRole('region', { name: 'Media generated in this conversation' }),
    ).toBeNull();
  });

  it('hands a message to the Image Studio instead of generating in the chat', async () => {
    const { user } = openChat([]);
    const action = await screen.findByRole('button', {
      name: 'Generate an image from this message',
    });
    await user.click(action);

    await waitFor(() => expect(useShellStore.getState().route.name).toBe('image'));
    // The prompt travels with it, so the studio opens ready to edit rather than empty.
    const { useMediaStore } = await import('@renderer/lib/media-store');
    expect(useMediaStore.getState().draftPrompt).toContain('A heron standing');
  });

  it('leaves the composer with exactly the controls it had', async () => {
    openChat([media()]);
    await screen.findByRole('region', { name: 'Media generated in this conversation' });

    const composer = document.querySelector('.pds-composer');
    expect(composer).not.toBeNull();
    // The media strip is above the composer and adds nothing inside it: two attach
    // buttons, a voice recorder and send — the same set as before this feature.
    const controls = composer?.querySelectorAll('button');
    expect(controls?.length).toBe(4);
    expect(within(composer as HTMLElement).queryByText(/generate/i)).toBeNull();
  });

  it('reads a deleted file as removed, not as a broken image', async () => {
    const item = media();
    render(
      <MediaCard
        item={item}
        onOpen={() => undefined}
        onExport={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const image = document.querySelector('.pds-media-card__image');
    expect(image).not.toBeNull();
    // The store cannot serve a file that is gone; the card says so in words.
    fireEvent.error(image as Element);
    expect(await screen.findByText(/File removed from disk/)).toBeInTheDocument();
  });
});
