/**
 * Generated media: the row, the file it points at, and the job that produced it.
 *
 * Two deliberate rules shape this module:
 *
 *  1. **Bytes never live in the database and never cross IPC as JSON.** A row
 *     stores a relative path and a sha256; the file itself lives under the
 *     profile's media directory and is served to the renderer through a protocol
 *     handler, not through a base64 string.
 *  2. **A media row is local-only.** It has no sync header (`version`, `dirty`,
 *     …) because generated media is never uploaded automatically — the owner
 *     decided media stays local. Adding it to the sync set later is a separate,
 *     explicit change.
 *
 * The job row exists so a minutes-long video generation survives a restart: it
 * is the durable record of "a provider is working on this", and the engine
 * resumes it rather than losing it when the window closes.
 */
import type { Id } from './types';

export type MediaKind = 'image' | 'video';

/**
 * Where a generation has got to.
 *
 * `expired` is distinct from `failed`: it means the provider accepted the job but
 * the handle no longer resolves (a signed URL died, an operation was GC'd). The
 * bytes cannot be recovered, so the honest instruction is "generate it again",
 * not "retry" — a retry would be a fresh, billable job.
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'expired',
] as const;

export type GenerationJobStatus = (typeof JOB_STATUSES)[number];

/** A normalised generation parameter value. Never a credential, never a path. */
export type MediaParamValue = string | number | boolean | null;
export type MediaParams = Readonly<Record<string, MediaParamValue>>;

export interface GenerationMedia {
  id: Id;
  kind: MediaKind;
  providerId: Id;
  /** The exact model id the provider was asked for. Never rewritten. */
  modelId: string;
  prompt: string;
  negativePrompt: string | null;
  params: MediaParams;
  /** Pixels for an image; the encoded frame size for a video, when the provider says. */
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bytes: number;
  sha256: string;
  mime: string;
  /** Path relative to the media root, e.g. `ab/abcdef…f.png`. Never absolute. */
  relativePath: string;
  conversationId: Id | null;
  messageId: Id | null;
  jobId: string | null;
  /** The provider's own handle, kept for support and duplicate detection. */
  providerJobId: string | null;
  createdAt: string;
}

export interface GenerationJob {
  id: string;
  task: Exclude<MediaKind, never>;
  providerId: Id;
  modelId: string;
  status: GenerationJobStatus;
  /** 0–100 when the provider reports it; null means "working, no estimate". */
  progress: number | null;
  prompt: string;
  params: MediaParams;
  /** Provider handle: an interaction id, a prediction id, an operation name. */
  remoteId: string | null;
  /** Where to poll, when the provider hands one back. */
  pollUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  attempts: number;
  /** When the engine should poll next; the scheduler reads this. */
  nextPollAt: string | null;
  mediaId: Id | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** True when a job is still occupying a provider slot. */
export function isActiveJob(job: Pick<GenerationJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** True when the job will never change again. */
export function isTerminalStatus(status: GenerationJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'expired';
}

/**
 * Limits for generated work. Deliberately generous for a single-user desktop app
 * but finite: an unbounded media directory is a disk-full bug waiting for a
 * video model to produce a 4K clip.
 */
export const MEDIA_LIMITS = {
  /** Largest single generated file we will store (a 1080p short clip fits). */
  maxFileBytes: 512 * 1024 * 1024,
  /** Total media directory budget before the app refuses to store more. */
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  /** Prompt ceiling, matching the largest documented provider limit. */
  maxPromptChars: 32_000,
  /** How many jobs may run at once per provider. Providers document their own caps. */
  defaultMaxConcurrentJobs: 2,
} as const;

/** The extension a stored file gets, from its MIME type. Never from a provider string. */
export function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    default:
      return 'bin';
  }
}
