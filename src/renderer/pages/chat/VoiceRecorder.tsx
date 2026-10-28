/**
 * Voice recording for the composer.
 *
 * The panel is mounted only while the user is recording, so an unmount is
 * always a real teardown: microphone tracks are stopped, the MediaRecorder is
 * detached from its handlers, and the preview blob URL is revoked. Every exit
 * path — Stop then Discard, Cancel mid-recording, a successful transcription,
 * leaving the chat — goes through `releaseAll`, which is what the test asserts.
 *
 * A denied microphone is a first-class state here, not a crash: the app denies
 * every permission except this one, so a denial is expected and is explained
 * with the exact place to change it.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { ATTACHMENT_LIMITS, type AttachmentMeta } from '@shared/attachments';
import { toAppError } from '@shared/errors';
import { AlertCircleIcon } from '@renderer/components/icons';
import { Button, Spinner } from '@renderer/components/ui';
import { getApi } from '@renderer/lib/api';
import { errorSummary } from '@renderer/lib/error-copy';
import { extensionForMimeType, toBase64 } from './attachments';

/** Preferred container/codec, in the order the task defines. */
const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
] as const;

/** How often the elapsed timer is refreshed; the display has second resolution. */
const TIMER_TICK_MS = 250;

type Phase = 'requesting' | 'recording' | 'reviewing' | 'error';

interface RecorderError {
  title: string;
  message: string;
}

interface Recording {
  dataBase64: string;
  mimeType: string;
  durationMs: number;
  /** Blob URL for the `<audio>` preview; revoked by `releaseAll`. */
  url: string;
}

type TranscriptionState =
  | { status: 'checking' }
  | { status: 'ready'; providerName: string | null }
  | { status: 'unavailable'; reason: string };

export interface VoiceRecorderProps {
  /** Inserts the transcript into the composer; it never sends on its own. */
  onTranscript(text: string): void;
  /** Attaches the recording itself as an audio attachment. */
  onAttach(attachment: AttachmentMeta): void;
  /** Closes the panel and unmounts it, which releases everything. */
  onClose(): void;
}

/** `00:42` — elapsed time, so a long recording stays readable. */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function pickRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return RECORDING_MIME_TYPES[0] ?? null;
  for (const candidate of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/**
 * The `name`/`message` of anything thrown by the platform, read structurally.
 *
 * `instanceof` is deliberately not used: a `DOMException` raised by one realm
 * (the media stack) is not an instance of another realm's `Error`, and the name
 * is the only thing the mapping needs.
 */
function nameOf(caught: unknown): string {
  if (caught && typeof caught === 'object' && 'name' in caught) {
    const name = (caught as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

function messageOf(caught: unknown): string | null {
  if (caught && typeof caught === 'object' && 'message' in caught) {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

/** Turn a getUserMedia / MediaRecorder failure into the sentence the user needs. */
function describeMicrophoneError(caught: unknown): RecorderError {
  const name = nameOf(caught);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      title: 'Microphone access is blocked',
      message:
        'Grenjo AI Tool is not allowed to use the microphone. Allow it in Windows Settings → Privacy → Microphone, then try again.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No microphone was found',
      message: 'Connect a microphone or headset, then try again.',
    };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      title: 'The microphone is in use',
      message: 'Another app is holding the microphone. Close it, then try again.',
    };
  }
  return {
    title: 'The microphone could not start',
    message: messageOf(caught) ?? 'Recording could not start. Try again.',
  };
}

export function VoiceRecorder({
  onTranscript,
  onAttach,
  onClose,
}: VoiceRecorderProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('requesting');
  const [error, setError] = useState<RecorderError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [busy, setBusy] = useState<'transcribing' | 'attaching' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionState>({ status: 'checking' });

  const mountedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const discardRef = useRef(false);
  /*
   * `onClose` is a prop the composer recreates on every render. The teardown
   * path runs from an event handler or from the recorder's `onstop`, long after
   * that render, so it reads the latest callback through a ref instead of
   * capturing a stale one — and, more importantly, so the mount effect below
   * does not depend on a prop that changes on every keystroke.
   */
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }, []);

  const detachRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    // Detach the handlers before dropping the reference: a late event must not
    // reach a component that is being torn down.
    recorder.ondataavailable = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Teardown only: the tracks are stopped next either way, so a recorder
        // that refuses to stop has nothing left to release.
      }
    }
  }, []);

  const revokePreview = useCallback(() => {
    const url = previewUrlRef.current;
    previewUrlRef.current = null;
    if (url) URL.revokeObjectURL(url);
  }, []);

  const releaseAll = useCallback(() => {
    stopTracks();
    detachRecorder();
    revokePreview();
    chunksRef.current = [];
  }, [detachRecorder, revokePreview, stopTracks]);

  /** Runs when the recorder stops: builds the review state from its chunks. */
  const finalize = useCallback(() => {
    const recorder = recorderRef.current;
    const mimeType =
      recorder && recorder.mimeType.length > 0 ? recorder.mimeType : 'audio/webm';
    const chunks = chunksRef.current;
    const durationMs = Math.max(0, elapsedRef.current);
    detachRecorder();
    stopTracks();
    chunksRef.current = [];

    if (discardRef.current) {
      discardRef.current = false;
      revokePreview();
      onCloseRef.current();
      return;
    }

    if (chunks.length === 0) {
      setError({
        title: 'Nothing was recorded',
        message: 'The microphone produced no audio. Check the input device, then try again.',
      });
      setPhase('error');
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    setPhase('reviewing');
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (!mountedRef.current) return;
        setRecording({
          dataBase64: toBase64(buffer),
          mimeType,
          durationMs,
          url,
        });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        revokePreview();
        setError({
          title: 'The recording could not be read',
          message: 'The audio was captured but could not be prepared. Try recording again.',
        });
        setPhase('error');
      });
  }, [detachRecorder, revokePreview, stopTracks]);

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    setActionError(null);
    setRecording(null);
    setPhase('requesting');

    const mediaDevices =
      typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      setError({
        title: 'Audio capture is unavailable',
        message: 'This build has no microphone interface. Recording needs the desktop app.',
      });
      setPhase('error');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(describeMicrophoneError(caught));
      setPhase('error');
      return;
    }

    if (!mountedRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;

    const mimeType = pickRecordingMimeType();
    if (!mimeType) {
      stopTracks();
      setError({
        title: 'No supported recording format',
        message:
          'This system cannot record audio in a format the app can use. Try another microphone, or update Windows.',
      });
      setPhase('error');
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (caught) {
      stopTracks();
      setError(describeMicrophoneError(caught));
      setPhase('error');
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      finalize();
    };
    startedAtRef.current = Date.now();
    elapsedRef.current = 0;

    try {
      recorder.start();
    } catch (caught) {
      releaseAll();
      setError(describeMicrophoneError(caught));
      setPhase('error');
      return;
    }

    setElapsedMs(0);
    setPhase('recording');
  }, [finalize, releaseAll, stopTracks]);

  useEffect(() => {
    mountedRef.current = true;
    void start();
    return () => {
      mountedRef.current = false;
      releaseAll();
    };
    // Mounting the panel is the request; `start` is stable for the mount's lifetime.
  }, [releaseAll, start]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    elapsedRef.current = Math.max(elapsedRef.current, Date.now() - startedAtRef.current);
    try {
      recorder.stop();
    } catch {
      // A recorder that cannot stop is unusable; release the device and say so
      // rather than leaving the microphone open behind an error state.
      releaseAll();
      setError({
        title: 'The recording could not be stopped',
        message: 'The microphone was released. Try recording again.',
      });
      setPhase('error');
    }
  }, [releaseAll]);

  /* Live elapsed timer, and the hard length cap from the shared limits. */
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      elapsedRef.current = elapsed;
      setElapsedMs(elapsed);
      if (elapsed >= ATTACHMENT_LIMITS.maxAudioSeconds * 1000) stopRecording();
    }, TIMER_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [phase, stopRecording]);

  /* Ask what can transcribe only once there is a recording to offer it for. */
  useEffect(() => {
    if (phase !== 'reviewing' || recording === null) return undefined;
    let alive = true;
    setTranscription({ status: 'checking' });
    getApi()
      .attachments.transcriptionStatus()
      .then((status) => {
        if (!alive) return;
        if (status.available) {
          setTranscription({ status: 'ready', providerName: status.providerName });
        } else {
          setTranscription({
            status: 'unavailable',
            reason: status.reason ?? 'No transcription provider is configured.',
          });
        }
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setTranscription({ status: 'unavailable', reason: errorSummary(toAppError(caught)) });
      });
    return () => {
      alive = false;
    };
  }, [phase, recording]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      discardRef.current = true;
      try {
        recorder.stop();
        return;
      } catch {
        discardRef.current = false;
      }
    }
    releaseAll();
    onClose();
  }, [onClose, releaseAll]);

  const discard = useCallback(() => {
    releaseAll();
    onClose();
  }, [onClose, releaseAll]);

  const transcribe = useCallback(async (): Promise<void> => {
    if (!recording) return;
    setBusy('transcribing');
    setActionError(null);
    try {
      const result = await getApi().attachments.transcribe({
        dataBase64: recording.dataBase64,
        mimeType: recording.mimeType,
        durationMs: recording.durationMs,
      });
      onTranscript(result.text);
      // Success: the audio is no longer needed, so release it and close.
      releaseAll();
      onClose();
    } catch (caught) {
      // Failure keeps the recording: the user has to be able to retry, and the
      // preview must still play.
      setActionError(errorSummary(toAppError(caught)));
      setBusy(null);
    }
  }, [onClose, onTranscript, recording, releaseAll]);

  const attachRecording = useCallback(async (): Promise<void> => {
    if (!recording) return;
    setBusy('attaching');
    setActionError(null);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await getApi().attachments.ingestBytes({
        name: `recording-${stamp}.${extensionForMimeType(recording.mimeType)}`,
        mimeType: recording.mimeType,
        dataBase64: recording.dataBase64,
        kindHint: 'file',
      });
      const attachment = result.attachments[0];
      if (!attachment) {
        setActionError(
          result.rejected[0]?.reason ?? 'The recording could not be attached to the message.',
        );
        setBusy(null);
        return;
      }
      onAttach(attachment);
      releaseAll();
      onClose();
    } catch (caught) {
      setActionError(errorSummary(toAppError(caught)));
      setBusy(null);
    }
  }, [onAttach, onClose, recording, releaseAll]);

  if (phase === 'error' && error) {
    return (
      <div className="pds-recorder pds-recorder--error" role="alert">
        <div className="pds-recorder__head">
          <span className="pds-recorder__icon" aria-hidden="true">
            <AlertCircleIcon />
          </span>
          <p className="pds-recorder__title">{error.title}</p>
        </div>
        <p className="pds-recorder__message">{error.message}</p>
        <div className="pds-recorder__actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void start();
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close recorder
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'requesting') {
    return (
      <div className="pds-recorder" role="group" aria-label="Voice recording" aria-busy="true">
        <div className="pds-recorder__head">
          <Spinner label="Waiting for the microphone" />
          <p className="pds-recorder__title">Waiting for the microphone…</p>
        </div>
        <p className="pds-recorder__message">Windows may ask for permission the first time.</p>
        <div className="pds-recorder__actions">
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel recording
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'recording') {
    return (
      <div className="pds-recorder" role="group" aria-label="Voice recording">
        <div className="pds-recorder__head">
          <span className="pds-recorder__dot" aria-hidden="true" />
          <p className="pds-recorder__title">Recording</p>
          <span className="pds-recorder__timer" data-testid="recording-timer">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <p className="pds-recorder__message">
          Speak now. The audio stays on this machine until you use or discard it.
        </p>
        <div className="pds-recorder__actions">
          <Button size="sm" variant="secondary" onClick={stopRecording}>
            Stop recording
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel recording
          </Button>
        </div>
      </div>
    );
  }

  const actionsDisabled = recording === null || busy !== null;

  return (
    <div className="pds-recorder" role="group" aria-label="Voice recording">
      <div className="pds-recorder__head">
        <p className="pds-recorder__title">Recording ready</p>
        <span className="pds-recorder__timer">{formatElapsed(recording?.durationMs ?? 0)}</span>
      </div>
      {recording ? (
        <audio
          className="pds-recorder__audio"
          controls
          src={recording.url}
          aria-label="Recording preview"
        />
      ) : (
        <p className="pds-recorder__message">Preparing the preview…</p>
      )}
      {actionError ? (
        <p className="pds-recorder__error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="pds-recorder__actions">
        <Button size="sm" variant="ghost" disabled={actionsDisabled} onClick={discard}>
          Discard recording
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'attaching'}
          disabled={actionsDisabled}
          onClick={() => {
            void attachRecording();
          }}
        >
          Use recording
        </Button>
        {transcription.status === 'ready' ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'transcribing'}
            disabled={actionsDisabled}
            onClick={() => {
              void transcribe();
            }}
          >
            Transcribe recording
          </Button>
        ) : null}
      </div>
      {transcription.status === 'checking' ? (
        <p className="pds-recorder__message">Checking for a transcription provider…</p>
      ) : null}
      {transcription.status === 'unavailable' ? (
        <p className="pds-recorder__note">{transcription.reason}</p>
      ) : null}
    </div>
  );
}
