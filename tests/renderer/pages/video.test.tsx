/**
 * The Video Studio.
 *
 * The behaviour that differs from the Image Studio is the part worth asserting:
 * a job survives leaving the page, progress that has no number does not invent
 * one, and the player never autoplays.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCapabilities } from '@shared/capabilities';
import type { GenerationJob, GenerationMedia } from '@shared/media';
import type { ModelDescriptor } from '@shared/types';
import { VideoPage } from '@renderer/pages/video/VideoPage';
import { resetStores } from '../helpers/state';
import { installApi, makeProvider, renderPage } from './support';

function model(providerId: string, modelId: string, capabilities = makeCapabilities({ videoOutput: true, imageInput: true })): ModelDescriptor {
  return {
    id: `m-${modelId}`,
    providerId,
    modelId,
    displayName: 'Video model',
    source: 'custom',
    capabilities,
    limits: {},
    description: '',
    supportedParams: [],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
  };
}

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-v1',
    task: 'video',
    providerId: 'p-gemini',
    modelId: 'gemini-omni-1.1-flash',
    status: 'running',
    progress: null,
    prompt: 'Slow pan over a harbour',
    params: {},
    remoteId: 'op-1',
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
    ...overrides,
  };
}

function videoItem(overrides: Partial<GenerationMedia> = {}): GenerationMedia {
  return {
    id: 'media-v1',
    kind: 'video',
    providerId: 'p-gemini',
    modelId: 'gemini-omni-1.1-flash',
    prompt: 'Slow pan over a harbour',
    negativePrompt: null,
    params: {},
    width: 1280,
    height: 720,
    durationMs: 8000,
    bytes: 4096,
    sha256: 'b'.repeat(64),
    mime: 'video/mp4',
    relativePath: `${'b'.repeat(2)}/${'b'.repeat(64)}.mp4`,
    conversationId: null,
    messageId: null,
    jobId: 'job-v1',
    providerJobId: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function harness(options: {
  models?: ModelDescriptor[];
  providers?: ReturnType<typeof makeProvider>[];
  items?: GenerationMedia[];
  jobs?: GenerationJob[];
}) {
  const fake = installApi({
    models: options.models ?? [model('p-gemini', 'gemini-omni-1.1-flash')],
    providers: options.providers ?? [
      makeProvider({ id: 'p-gemini', kind: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
    ],
  });
  fake.api.media.list = vi.fn(async () => options.items ?? []);
  fake.api.media.jobs = vi.fn(async () => options.jobs ?? []);
  const listeners: Array<(job: GenerationJob) => void> = [];
  fake.api.media.onEvent = vi.fn((listener: (job: GenerationJob) => void) => {
    listeners.push(listener);
    return () => undefined;
  });
  const rendered = renderPage(fake, <VideoPage />);
  return { ...rendered, fake, listeners };
}

beforeEach(() => {
  resetStores();
});

describe('Video Studio', () => {
  it('says so when no video model is registered', async () => {
    harness({ models: [model('p-gemini', 'chatish', makeCapabilities({ chat: true }))] });
    expect(await screen.findByText(/No video model is registered/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate video' })).toBeNull();
  });

  it('sends an aspect ratio and a resolution for Gemini, and no duration', async () => {
    const { fake, user } = harness({});
    await user.type(await screen.findByRole('textbox', { name: 'Prompt' }), 'A harbour at dawn');
    await user.click(screen.getByRole('button', { name: 'Generate video' }));

    await waitFor(() => expect(fake.api.media.generate).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(fake.api.media.generate).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent).toMatchObject({ task: 'video', prompt: 'A harbour at dawn' });
    expect(sent.params).toMatchObject({ aspect_ratio: '16:9', resolution: '720p' });
    // No duration control exists because neither provider documents one.
    expect(sent.params).not.toHaveProperty('duration');
    expect(screen.queryByRole('combobox', { name: /duration/i })).toBeNull();
  });

  it('shows indeterminate progress as "Working…" rather than inventing a number', async () => {
    const { listeners } = harness({});
    await screen.findByRole('textbox', { name: 'Prompt' });
    await waitFor(() => expect(listeners).toHaveLength(1));
    listeners[0]?.(job({ progress: null }));

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    // No aria-valuenow at all: an indeterminate bar that reports a number lies.
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('keeps a running job after leaving the page and coming back', async () => {
    const { listeners } = harness({});
    await screen.findByRole('textbox', { name: 'Prompt' });
    await waitFor(() => expect(listeners).toHaveLength(1));
    listeners[0]?.(job({ prompt: 'long running video' }));
    expect(await screen.findByText('long running video')).toBeInTheDocument();

    // Navigate away: the component goes, the store stays.
    cleanup();

    harness({});
    expect(await screen.findByText('long running video')).toBeInTheDocument();
  });

  it('cancels a running video job through the service', async () => {
    const { fake, user } = harness({ jobs: [job()] });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fake.api.media.cancel).toHaveBeenCalledWith('job-v1'));
  });

  it('plays a stored video without autoplay', async () => {
    const { user } = harness({ items: [videoItem()] });
    await user.click(await screen.findByRole('button', { name: /Open video preview/i }));
    const dialog = await screen.findByRole('dialog');
    const video = dialog.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.hasAttribute('autoplay')).toBe(false);
    expect(video?.getAttribute('src')?.startsWith('media://local/')).toBe(true);
  });

  it('names a video before deleting it', async () => {
    const { fake, user } = harness({ items: [videoItem()] });
    await user.click(await screen.findByRole('button', { name: /Delete video/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/Slow pan over a harbour/)).toBeInTheDocument();
    expect(fake.api.media.remove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.api.media.remove).toHaveBeenCalledWith('media-v1'));
  });
});
