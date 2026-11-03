/**
 * The Image Studio, asserted from the user's side.
 *
 * The behaviours that matter: only image models are offered, the controls match
 * what the selected provider documents, a generation is queued with the right
 * parameters, progress arrives without the page reloading, and nothing is deleted
 * without a confirmation that names the item.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCapabilities } from '@shared/capabilities';
import type { GenerationJob, GenerationMedia } from '@shared/media';
import type { ModelDescriptor } from '@shared/types';
import { ImagePage } from '@renderer/pages/image/ImagePage';
import { resetStores } from '../helpers/state';
import { installApi, makeProvider, renderPage } from './support';

function chatModel(providerId: string, modelId = 'chat-model'): ModelDescriptor {
  return {
    id: `m-${modelId}`,
    providerId,
    modelId,
    displayName: 'Chat model',
    source: 'custom',
    capabilities: makeCapabilities({ chat: true, streaming: true }),
    limits: {},
    description: '',
    supportedParams: ['temperature'],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
  };
}

function imageModel(providerId: string, modelId = 'gpt-image-2'): ModelDescriptor {
  return {
    ...chatModel(providerId, modelId),
    id: `m-${modelId}`,
    displayName: 'Image model',
    capabilities: makeCapabilities({ imageOutput: true, imageInput: true, imageEditing: true }),
    supportedParams: [],
  };
}

const OPENAI = makeProvider({ id: 'p-openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
const GEMINI = makeProvider({
  id: 'p-gemini',
  kind: 'gemini',
  name: 'Gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
});

function mediaRow(overrides: Partial<GenerationMedia> = {}): GenerationMedia {
  return {
    id: 'media-1',
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
    conversationId: null,
    messageId: null,
    jobId: null,
    providerJobId: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function harness(options: {
  models: ModelDescriptor[];
  providers?: ReturnType<typeof makeProvider>[];
  items?: GenerationMedia[];
  jobs?: GenerationJob[];
}) {
  const fake = installApi({
    models: options.models,
    providers: options.providers ?? [OPENAI],
    ...(options.items ? {} : {}),
  });
  fake.api.media.list = vi.fn(async () => options.items ?? []);
  fake.api.media.jobs = vi.fn(async () => options.jobs ?? []);
  const listeners: Array<(job: GenerationJob) => void> = [];
  fake.api.media.onEvent = vi.fn((listener: (job: GenerationJob) => void) => {
    listeners.push(listener);
    return () => undefined;
  });
  const rendered = renderPage(fake, <ImagePage />);
  return { ...rendered, fake, listeners };
}

beforeEach(() => {
  resetStores();
});

describe('Image Studio', () => {
  it('says so when no image model is registered, and offers no form', async () => {
    harness({ models: [chatModel('p-openai')] });
    expect(await screen.findByText(/No image model is registered/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
  });

  it('offers only models that declare image generation', async () => {
    harness({ models: [chatModel('p-openai'), imageModel('p-openai')] });
    const picker = await screen.findByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(picker).toBeEnabled());
    const rendered = harness({ models: [chatModel('p-openai'), imageModel('p-openai')] });
    void rendered;
    // The chat model must not be selectable here.
    expect(screen.queryByRole('option', { name: /Chat model/ })).toBeNull();
  });

  it('queues a generation with the parameters the provider documents', async () => {
    const { fake, user } = harness({ models: [imageModel('p-openai')] });
    const prompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.type(prompt, 'A heron at dawn');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(fake.api.media.generate).toHaveBeenCalledTimes(1));
    expect(fake.api.media.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'image',
        prompt: 'A heron at dawn',
        providerId: 'p-openai',
        modelId: 'gpt-image-2',
        // OpenAI documents a pixel size, a quality and a count — not an aspect ratio.
        params: expect.objectContaining({ size: '1024x1024', quality: 'auto', n: 1 }),
      }),
    );
  });

  it('switches to aspect ratio and resolution for Gemini', async () => {
    const { fake, user } = harness({
      providers: [GEMINI],
      models: [imageModel('p-gemini', 'gemini-nano-banana-2.1')],
    });
    await user.type(await screen.findByRole('textbox', { name: 'Prompt' }), 'A river');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(fake.api.media.generate).toHaveBeenCalled());
    expect(fake.api.media.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ aspect_ratio: '1:1', image_size: '1K' }),
      }),
    );
    // The OpenAI-only controls must not be offered for this provider.
    expect(screen.queryByRole('combobox', { name: 'Size' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Quality' })).toBeNull();
  });

  it('refuses to submit an empty prompt', async () => {
    const { fake, user } = harness({ models: [imageModel('p-openai')] });
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/A prompt is required/i)).toBeInTheDocument();
    expect(fake.api.media.generate).not.toHaveBeenCalled();
  });

  it('shows a queued job and its progress without a reload', async () => {
    const { listeners } = harness({ models: [imageModel('p-openai')] });
    await screen.findByRole('textbox', { name: 'Prompt' });

    const job: GenerationJob = {
      id: 'job-1',
      task: 'image',
      providerId: 'p-openai',
      modelId: 'gpt-image-2',
      status: 'running',
      progress: 45,
      prompt: 'A heron at dawn',
      params: {},
      remoteId: null,
      pollUrl: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      attempts: 1,
      nextPollAt: null,
      mediaId: null,
      referenceMediaIds: [],
      maskMediaId: null,
      conversationId: null,
      messageId: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
      finishedAt: null,
    };
    await waitFor(() => expect(listeners).toHaveLength(1));
    listeners[0]?.(job);

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('cancels a running job through the service', async () => {
    const job = {
      id: 'job-1',
      task: 'image' as const,
      providerId: 'p-openai',
      modelId: 'gpt-image-2',
      status: 'running' as const,
      progress: 10,
      prompt: 'slow one',
      params: {},
      remoteId: null,
      pollUrl: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      attempts: 1,
      nextPollAt: null,
      mediaId: null,
      referenceMediaIds: [],
      maskMediaId: null,
      conversationId: null,
      messageId: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
      finishedAt: null,
    };
    const { fake, user } = harness({ models: [imageModel('p-openai')], jobs: [job] });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fake.api.media.cancel).toHaveBeenCalledWith('job-1'));
  });

  it('names the item before deleting it', async () => {
    const { fake, user } = harness({
      models: [imageModel('p-openai')],
      items: [mediaRow()],
    });
    await user.click(await screen.findByRole('button', { name: /Delete image/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/A heron at dawn/)).toBeInTheDocument();
    expect(fake.api.media.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.api.media.remove).toHaveBeenCalledWith('media-1'));
  });

  it('exports a generated image through the save dialog', async () => {
    const { fake, user } = harness({
      models: [imageModel('p-openai')],
      items: [mediaRow()],
    });
    await user.click(await screen.findByRole('button', { name: 'Save a copy' }));
    await waitFor(() => expect(fake.api.media.export).toHaveBeenCalledWith('media-1'));
  });

  it('opens a preview dialog that shows the prompt', async () => {
    const { user } = harness({ models: [imageModel('p-openai')], items: [mediaRow()] });
    await user.click(await screen.findByRole('button', { name: /Open image preview/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('A heron at dawn')).toBeInTheDocument();
  });
});
