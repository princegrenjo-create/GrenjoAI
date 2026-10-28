/**
 * Microphone and MediaRecorder doubles for the voice-recorder suites.
 *
 * Nothing here touches a real device: `getUserMedia` resolves a stream whose
 * tracks are spies, and `MediaRecorder` is a deterministic in-memory recorder
 * that hands back a Blob when it is stopped. The tests assert on the spies, so
 * "the microphone was released" is a recorded fact rather than an assumption.
 */
import { vi, type Mock } from 'vitest';

interface FakeTrack {
  kind: 'audio';
  stop: Mock;
}

export interface FakeMediaRecorderInstance {
  state: 'inactive' | 'recording';
  mimeType: string;
  stream: MediaStream;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

/** Recorder that behaves like the browser's, only synchronously. */
class FakeMediaRecorder implements FakeMediaRecorderInstance {
  static instances: FakeMediaRecorder[] = [];
  static supported: string[] = ['audio/webm;codecs=opus'];

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.includes(type);
  }

  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  stream: MediaStream;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['fake-recording-bytes'], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  }
}

export interface MediaHarness {
  getUserMedia: Mock;
  tracks: FakeTrack[];
  stream: MediaStream;
  /** The only track the fake microphone exposes; throws when there is none. */
  track(): FakeTrack;
  /** Every MediaRecorder the component constructed, in order. */
  recorders(): FakeMediaRecorderInstance[];
  /** The most recent MediaRecorder; throws when none was constructed. */
  recorder(): FakeMediaRecorderInstance;
  restore(): void;
}

export interface MediaMockOptions {
  /** Make `getUserMedia` reject with this error, as a denied device would. */
  micError?: Error;
  /** Which recording types the fake MediaRecorder reports as supported. */
  supported?: string[];
}

export function installMediaMocks(options: MediaMockOptions = {}): MediaHarness {
  const tracks: FakeTrack[] = [{ kind: 'audio', stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    void constraints;
    if (options.micError) throw options.micError;
    return stream;
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });

  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = options.supported ?? ['audio/webm;codecs=opus'];
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);

  return {
    getUserMedia,
    tracks,
    stream,
    track() {
      const track = tracks[0];
      if (!track) throw new Error('The fake microphone exposes no track');
      return track;
    },
    recorders: () => FakeMediaRecorder.instances,
    recorder() {
      const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
      if (!recorder) throw new Error('The component constructed no MediaRecorder');
      return recorder;
    },
    restore() {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
    },
  };
}

/** Spy on the blob URL lifecycle; jsdom implements neither function. */
export function stubObjectUrls(): { create: Mock; revoke: Mock } {
  const create = vi.fn(() => 'blob:mock-recording');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return { create, revoke };
}
