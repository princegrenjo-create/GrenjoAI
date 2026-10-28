import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from './helpers/state';
import { installMediaMocks, stubObjectUrls, type MediaHarness } from './helpers/media';
import { renderConversation, type ChatHarness } from './helpers/render-chat';

let media: MediaHarness;
let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  resetStores();
  media = installMediaMocks();
  urls = stubObjectUrls();
});

afterEach(() => {
  vi.useRealTimers();
  media.restore();
});

/** Let the getUserMedia -> MediaRecorder -> setState chain settle. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
  });
}

async function startRecording(harness: ChatHarness): Promise<void> {
  await screen.findByText('This conversation is empty');
  await harness.user.click(harness.recordButton());
  await screen.findByTestId('recording-timer');
}

async function stopIntoReview(harness: ChatHarness): Promise<HTMLElement> {
  await startRecording(harness);
  await harness.user.click(screen.getByRole('button', { name: 'Stop recording' }));
  return screen.findByLabelText('Recording preview');
}

describe('Voice recorder', () => {
  it('requests the microphone, prefers Opus/WebM, and advances the timer', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    // Fake only the clock and the interval: the timer derives its value from
    // Date.now() minus the moment recording started.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    await harness.user.click(harness.recordButton());
    await flushMicrotasks();

    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(media.recorder().mimeType).toBe('audio/webm;codecs=opus');
    expect(screen.getByTestId('recording-timer')).toHaveTextContent('00:00');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByTestId('recording-timer')).toHaveTextContent('00:02');
  });

  it('falls back to the next supported recording type', async () => {
    media = installMediaMocks({ supported: ['audio/webm'] });
    const harness = await renderConversation();
    await startRecording(harness);

    expect(media.recorder().mimeType).toBe('audio/webm');
  });

  it('says so when no recording type is supported instead of recording silently', async () => {
    media = installMediaMocks({ supported: [] });
    const harness = await renderConversation();

    await screen.findByText('This conversation is empty');
    await harness.user.click(harness.recordButton());

    expect(await screen.findByText('No supported recording format')).toBeInTheDocument();
    expect(media.track().stop).toHaveBeenCalled();
  });

  it('maps a denied microphone to a permission state, not a crash', async () => {
    media = installMediaMocks({
      micError: new DOMException('Permission denied', 'NotAllowedError'),
    });
    const harness = await renderConversation();

    await screen.findByText('This conversation is empty');
    await harness.user.click(harness.recordButton());

    expect(await screen.findByText('Microphone access is blocked')).toBeInTheDocument();
    expect(
      screen.getByText(/Allow it in Windows Settings → Privacy → Microphone/),
    ).toBeInTheDocument();
    expect(media.recorders()).toHaveLength(0);
  });

  it('reports a missing microphone as a device problem', async () => {
    media = installMediaMocks({
      micError: new DOMException('No device', 'NotFoundError'),
    });
    const harness = await renderConversation();

    await screen.findByText('This conversation is empty');
    await harness.user.click(harness.recordButton());

    expect(await screen.findByText('No microphone was found')).toBeInTheDocument();
  });

  it('stops the microphone and shows a review state with an audio preview', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');
    await harness.user.click(harness.recordButton());
    await screen.findByTestId('recording-timer');

    await harness.user.click(screen.getByRole('button', { name: 'Stop recording' }));

    const preview = await screen.findByLabelText('Recording preview');
    expect(preview.tagName).toBe('AUDIO');
    expect(media.track().stop).toHaveBeenCalledTimes(1);
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(urls.create).toHaveReturnedWith('blob:mock-recording');
  });

  it('discards without producing an attachment and revokes the preview URL', async () => {
    const harness = await renderConversation();
    await stopIntoReview(harness);

    await harness.user.click(screen.getByRole('button', { name: 'Discard recording' }));

    await waitFor(() =>
      expect(urls.revoke).toHaveBeenCalledWith('blob:mock-recording'),
    );
    expect(screen.queryByLabelText('Recording preview')).toBeNull();
    expect(harness.fake.api.attachments.ingestBytes).not.toHaveBeenCalled();
  });

  it('attaches the recording itself as an audio attachment', async () => {
    const harness = await renderConversation();
    await stopIntoReview(harness);

    await harness.user.click(screen.getByRole('button', { name: 'Use recording' }));

    await waitFor(() =>
      expect(harness.fake.api.attachments.ingestBytes).toHaveBeenCalledWith(
        expect.objectContaining({ kindHint: 'file', mimeType: 'audio/webm;codecs=opus' }),
      ),
    );
    expect(await screen.findByText(/^recording-.*\.webm$/)).toBeInTheDocument();
    expect(screen.getByText(/^Recording · /)).toBeInTheDocument();
    expect(urls.revoke).toHaveBeenCalledWith('blob:mock-recording');
  });

  it('puts a successful transcript in the composer and releases the recording', async () => {
    const harness = await renderConversation();
    await stopIntoReview(harness);

    await harness.user.click(
      await screen.findByRole('button', { name: 'Transcribe recording' }),
    );

    await waitFor(() =>
      expect(harness.textarea()).toHaveValue('A short spoken note.'),
    );
    expect(harness.fake.api.chat.send).not.toHaveBeenCalled();
    expect(urls.revoke).toHaveBeenCalledWith('blob:mock-recording');
    expect(screen.queryByLabelText('Recording preview')).toBeNull();
  });

  it('shows a failed transcription and keeps the recording for a retry', async () => {
    const harness = await renderConversation();
    await stopIntoReview(harness);
    harness.fake.mocks.attachmentsTranscribe.mockRejectedValueOnce(
      new Error('The transcription provider returned 503.'),
    );

    await harness.user.click(
      await screen.findByRole('button', { name: 'Transcribe recording' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The transcription provider returned 503.');
    expect(screen.getByLabelText('Recording preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transcribe recording' })).toBeEnabled();
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(harness.textarea()).toHaveValue('');
  });

  it('shows the reason verbatim when no transcription provider is configured', async () => {
    const harness = await renderConversation();
    harness.fake.mocks.attachmentsTranscriptionStatus.mockResolvedValueOnce({
      available: false,
      providerName: null,
      reason: 'Add an OpenAI API key in Models & Providers to transcribe recordings.',
    });

    await stopIntoReview(harness);

    expect(
      await screen.findByText('Add an OpenAI API key in Models & Providers to transcribe recordings.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transcribe recording' })).toBeNull();
  });

  it('releases the microphone when the panel unmounts mid-recording', async () => {
    const harness = await renderConversation();
    await startRecording(harness);
    expect(media.track().stop).not.toHaveBeenCalled();

    cleanup();

    expect(media.track().stop).toHaveBeenCalledTimes(1);
  });

  it('revokes the preview URL when the panel unmounts after a recording', async () => {
    const harness = await renderConversation();
    await stopIntoReview(harness);
    expect(urls.revoke).not.toHaveBeenCalled();

    cleanup();

    expect(urls.revoke).toHaveBeenCalledWith('blob:mock-recording');
  });
});
