/**
 * Capabilities on the Models & Providers screen: an undeclared model says so and
 * offers the fix, and the capability editor enforces the two dependencies that
 * would otherwise store a contradiction.
 *
 * These assert from the user's side — what is on screen, what a disabled control
 * says, and what the save actually carries — not from the component's internals.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCapabilities, CAPABILITY_KEYS } from '@shared/capabilities';
import type { ModelCapabilities } from '@shared/types';
import { ModelsPage } from '@renderer/pages/models/ModelsPage';
import { CAPABILITY_LABEL } from '@renderer/pages/models/model-labels';
import { makeModel } from '../helpers/fake-api';
import { resetStores } from '../helpers/state';
import { installApi, makeProvider, renderPage, withinDialog } from './support';

beforeEach(() => {
  resetStores();
});

const UNCLASSIFIED = makeModel({
  id: 'disc:mystery',
  providerId: 'provider-1',
  modelId: 'mystery-1',
  displayName: 'Mystery model',
  source: 'discovered',
  capabilities: makeCapabilities(),
});

describe('a model whose capabilities are unknown', () => {
  it('says they are not declared instead of showing an empty badge row', async () => {
    const fake = installApi({ providers: [makeProvider()], models: [UNCLASSIFIED] });

    renderPage(fake, <ModelsPage />);

    expect(await screen.findByText('Capabilities not declared')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Declare capabilities' })).toBeInTheDocument();
  });

  it('opens the capability editor prefilled with the discovered model', async () => {
    const fake = installApi({ providers: [makeProvider()], models: [UNCLASSIFIED] });
    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('Capabilities not declared');

    await user.click(screen.getByRole('button', { name: 'Declare capabilities' }));

    const form = withinDialog('Add a custom model');
    expect(form.getByLabelText('Exact model id')).toHaveValue('mystery-1');
    expect(form.getByLabelText('Display name')).toHaveValue('Mystery model');
    // The provider comes across too, so the declaration lands on the same endpoint.
    expect(form.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('DeepSeek');
  });
});

describe('the capability editor', () => {
  it('offers every declared capability exactly once', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No models yet');
    await user.click(screen.getByRole('button', { name: 'Add custom model' }));

    const form = withinDialog('Add a custom model');
    for (const key of CAPABILITY_KEYS) {
      expect(form.getByRole('switch', { name: CAPABILITY_LABEL[key] })).toBeInTheDocument();
    }
    // Every capability plus the unrelated weirdness switch: none is unreachable.
    expect(form.getAllByRole('switch')).toHaveLength(CAPABILITY_KEYS.length + 1);
  });

  it('requires image generation before image editing, and drops the edit when output goes off', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    let saved: ModelCapabilities | null = null;
    fake.api.models.upsert = vi.fn(async (input) => {
      saved = input.capabilities;
      return makeModel({
        id: 'custom:1',
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        source: 'custom',
        capabilities: input.capabilities,
      });
    });

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No models yet');
    await user.click(screen.getByRole('button', { name: 'Add custom model' }));

    const form = withinDialog('Add a custom model');
    const editing = (): HTMLElement => form.getByRole('switch', { name: 'Image editing' });

    // A dependent switch is disabled while its prerequisite is off, and says why.
    expect(editing()).toBeDisabled();
    expect(form.getByText('Turn on Image generation first.')).toBeInTheDocument();

    await user.click(form.getByRole('switch', { name: 'Image generation' }));
    expect(editing()).toBeEnabled();

    await user.click(editing());
    expect(editing()).toHaveAttribute('aria-checked', 'true');

    // Turning the prerequisite off clears the dependent capability in the form.
    await user.click(form.getByRole('switch', { name: 'Image generation' }));
    expect(editing()).toHaveAttribute('aria-checked', 'false');
    expect(editing()).toBeDisabled();

    await user.type(form.getByLabelText('Display name'), 'My image gateway');
    await user.type(form.getByLabelText('Exact model id'), 'gw-image-1');
    await user.click(form.getByRole('button', { name: 'Add model' }));

    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({
      chat: true,
      streaming: true,
      imageOutput: false,
      imageEditing: false,
    });
  });

  it('requires text generation before streaming, and clears streaming when text generation goes off', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No models yet');
    await user.click(screen.getByRole('button', { name: 'Add custom model' }));

    const form = withinDialog('Add a custom model');
    const streaming = (): HTMLElement => form.getByRole('switch', { name: 'Streaming' });
    const text = (): HTMLElement => form.getByRole('switch', { name: 'Text generation' });

    // A new custom model is a text model, so both start on.
    expect(text()).toHaveAttribute('aria-checked', 'true');
    expect(streaming()).toHaveAttribute('aria-checked', 'true');

    await user.click(text());
    expect(streaming()).toHaveAttribute('aria-checked', 'false');
    expect(streaming()).toBeDisabled();
    expect(form.getByText('Turn on Text generation first.')).toBeInTheDocument();
  });

  it('lets a video model stand alone without text generation', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No models yet');
    await user.click(screen.getByRole('button', { name: 'Add custom model' }));

    const form = withinDialog('Add a custom model');
    await user.click(form.getByRole('switch', { name: 'Text generation' }));

    const video = form.getByRole('switch', { name: 'Video generation' });
    expect(video).toBeEnabled();
    await user.click(video);
    expect(video).toHaveAttribute('aria-checked', 'true');
  });
});
