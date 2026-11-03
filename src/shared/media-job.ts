/**
 * The port between the job engine and a provider's media API.
 *
 * Deliberately narrow and provider-neutral: an adapter submits work, polls a
 * handle, and may cancel. Everything the engine needs to be honest about
 * long-running work — that a submit can fail, that a poll can be *done*, and that
 * some providers cannot cancel — is expressed here, so the engine never has to
 * guess what a particular API does.
 *
 * Adapters are synchronous-API providers that resolve immediately (`kind: 'done'`
 * from `submit`) as well as genuinely asynchronous ones; the engine treats both
 * the same way.
 */
import type { MediaKind, MediaParams } from './media';

export interface MediaOutput {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface MediaJobError {
  code: string;
  message: string;
  /** False for a user-correctable failure: retrying it would fail identically. */
  retryable: boolean;
}

export interface SubmitMediaInput {
  task: MediaKind;
  modelId: string;
  prompt: string;
  negativePrompt: string | null;
  params: MediaParams;
}

export interface PollMediaInput {
  task: MediaKind;
  modelId: string;
  /** The provider's handle, as returned by `submit`. */
  remoteId: string;
  /** The provider's own polling URL, when it handed one back. */
  pollUrl: string | null;
}

export type MediaJobOutcome =
  | { kind: 'done'; outputs: MediaOutput[]; providerJobId: string | null }
  | {
      kind: 'pending';
      remoteId: string;
      pollUrl: string | null;
      progress: number | null;
    }
  | { kind: 'failed'; error: MediaJobError };

export interface MediaJobAdapter {
  /** True when the provider documents a cancel operation. The UI is gated on this. */
  readonly supportsCancel: boolean;
  /** Documented concurrent-job limit for this provider, if it publishes one. */
  readonly maxConcurrent: number | null;
  submit(input: SubmitMediaInput): Promise<MediaJobOutcome>;
  poll(input: PollMediaInput): Promise<MediaJobOutcome>;
  /** Only called when `supportsCancel` is true. */
  cancel?(input: PollMediaInput): Promise<void>;
}
