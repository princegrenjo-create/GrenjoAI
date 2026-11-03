/**
 * The chat composer's model picker.
 *
 * The defect this fixes: the picker listed every model, so an image model could
 * be selected for a conversation and the request then failed at the provider.
 * The picker now offers only models declared for text generation, and tells the
 * user why the list is short instead of looking empty for no reason.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeCapabilities, supportsTask } from '@shared/capabilities';
import { makeModel } from './helpers/fake-api';
import { renderConversation } from './helpers/render-chat';
import { resetStores } from './helpers/state';

beforeEach(() => {
  resetStores();
});

const textModel = makeModel({ displayName: 'Desk Chat' });

const visionModel = makeModel({
  id: 'catalog:deepseek-vision',
  modelId: 'deepseek-vision',
  displayName: 'Desk Vision',
  capabilities: makeCapabilities({ chat: true, streaming: true, imageInput: true }),
});

const imageModel = makeModel({
  id: 'disc:studio-image',
  modelId: 'studio-image-1',
  displayName: 'Studio Image',
  source: 'discovered',
  capabilities: makeCapabilities({ imageOutput: true }),
});

const unclassifiedModel = makeModel({
  id: 'disc:mystery',
  modelId: 'mystery-1',
  displayName: 'Mystery model',
  source: 'discovered',
  capabilities: makeCapabilities(),
});

describe('chat model picker', () => {
  it('offers a text model and keeps an image-only model out of the list', async () => {
    // The image model is still a valid choice for its own task; it is only the
    // chat picker that must not offer it.
    expect(supportsTask(imageModel.capabilities, 'image')).toBe(true);

    const { user } = await renderConversation({ models: [textModel, imageModel] });
    await screen.findByText('This conversation is empty');
    await screen.findByText('Desk Chat');

    await user.click(screen.getByRole('combobox', { name: 'Model' }));

    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(within(listbox).getByRole('option', { name: 'Desk Chat' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /Studio Image/ })).toBeNull();
  });

  it('keeps an unclassified model out of the list', async () => {
    const { user } = await renderConversation({
      models: [textModel, unclassifiedModel],
    });
    await screen.findByText('This conversation is empty');
    await screen.findByText('Desk Chat');

    await user.click(screen.getByRole('combobox', { name: 'Model' }));

    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(within(listbox).queryByRole('option', { name: /Mystery model/ })).toBeNull();
  });

  it('disables the picker and says why when nothing generates text', async () => {
    await renderConversation({ models: [imageModel] });
    await screen.findByText('This conversation is empty');

    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(
      screen.getByText(
        'No model is declared for text generation. Declare one in Models & Providers.',
      ),
    ).toBeInTheDocument();
  });

  it('still persists the chosen model', async () => {
    const { fake, user } = await renderConversation({
      models: [textModel, visionModel],
    });
    await screen.findByText('This conversation is empty');
    await screen.findByText('Desk Chat');

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: 'Desk Vision' }));

    await waitFor(() =>
      expect(fake.api.conversations.update).toHaveBeenCalledWith('c1', {
        providerId: 'provider-1',
        modelId: 'deepseek-vision',
      }),
    );
  });
});
