/**
 * Black Forest Labs video generation (`POST /v1/flux-3-video`).
 *
 * The most asynchronous of the providers this build supports:
 *
 *  1. `POST /v1/flux-3-video` with `x-key` and `{ mode: 't2v', prompt }` returns
 *     `{ id, polling_url }`;
 *  2. `GET {polling_url}` returns `{ status }`, one of `Ready`, `Error` or
 *     `Failed` — anything else means "keep polling";
 *  3. on `Ready`, `result.sample` is a **signed URL valid for ten minutes**, which
 *     is downloaded immediately because a stored URL is a dead link tomorrow.
 *
 * The auth header is `x-key`, not `Authorization: Bearer` — a detail that fails
 * silently if copied from another provider, so it is asserted in a test.
 *
 * `mode: 't2v'` is the text-to-video mode. Image-to-video needs a documented mode
 * and input shape that this build has not verified, so it is not offered rather
 * than guessed at.
 */
import type { MediaJobAdapter, MediaJobOutcome, SubmitMediaInput } from '@shared/media-job';
import type { MediaParams } from '@shared/media';
import type { HttpRequestSpec, ProviderTransport } from '@shared/provider-contract';
import { joinUrl } from '@shared/url-policy';
import { downloadBytes, DownloadError } from './media-download';
import { mediaErrorFromResponse } from './media-adapter';

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 60_000;

/** Documented delivery host for a finished result. */
export const BFL_RESULT_HOSTS = ['bfl.ai'] as const;

/** Statuses that mean the job is over, one way or the other. */
const READY = new Set(['ready', 'succeeded', 'completed']);
const FAILED = new Set(['error', 'failed', 'canceled', 'cancelled']);

export interface BflVideoAdapterOptions {
  baseUrl: string;
  apiKey(): Promise<string>;
  transport: ProviderTransport;
  /** Injected so a test can serve bytes without a network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function stringParam(params: MediaParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildBflVideoBody(input: SubmitMediaInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: 't2v',
    prompt: input.prompt,
  };
  // BFL documents aspect ratio and duration per endpoint; only what is declared in
  // the model catalogue is forwarded.
  const aspectRatio = stringParam(input.params, 'aspect_ratio');
  if (aspectRatio !== undefined) body.aspect_ratio = aspectRatio;
  return body;
}

interface BflPollBody {
  status: string;
  result?: { sample?: unknown } | null;
  error?: { message?: unknown } | string | null;
}

/**
 * Parses one poll response.
 *
 * A `Ready` body without a usable URL is a failure rather than a success: the job
 * is over and there is nothing to store.
 */
export function parseBflPollBody(body: string): {
  status: 'pending' | 'ready';
  sampleUrl: string | null;
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'pending', sampleUrl: null, error: null };
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as BflPollBody;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';

  if (FAILED.has(status)) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.error?.message === 'string'
          ? record.error.message
          : null;
    return { status: 'pending', sampleUrl: null, error: message ?? 'The provider reported that the video failed.' };
  }

  if (READY.has(status)) {
    const sample = record.result?.sample;
    return { status: 'ready', sampleUrl: typeof sample === 'string' && sample.length > 0 ? sample : null, error: null };
  }

  // Anything else is an intermediate status the documentation does not enumerate.
  return { status: 'pending', sampleUrl: null, error: null };
}

export function createBflVideoAdapter(options: BflVideoAdapterOptions): MediaJobAdapter {
  const submitTimeout = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;

  const key = async (): Promise<string | null> => {
    const apiKey = await options.apiKey();
    return apiKey.length > 0 ? apiKey : null;
  };

  return {
    // BFL documents no cancel operation for a submitted job.
    supportsCancel: false,
    // Documented concurrent-task budget, so the engine does not open more than the
    // account allows.
    maxConcurrent: 24,

    async submit(input: SubmitMediaInput): Promise<MediaJobOutcome> {
      const apiKey = await key();
      if (!apiKey) {
        return {
          kind: 'failed',
          error: {
            code: 'missing_key',
            message:
              'No Black Forest Labs API key is stored, so video generation cannot run. Add one on the Models & Providers page.',
            retryable: false,
          },
        };
      }

      const spec: HttpRequestSpec = {
        url: joinUrl(options.baseUrl, 'flux-3-video'),
        method: 'POST',
        headers: {
          // Not `Authorization`: BFL documents `x-key`, and copying the Bearer form
          // from another provider produces a 401 that looks like a bad key.
          'x-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBflVideoBody(input)),
      };

      const response = await options.transport.send(spec, { timeoutMs: submitTimeout, maxRetries: 0 });
      if (response.status >= 300) {
        return { kind: 'failed', error: mediaErrorFromResponse('Black Forest Labs', response.status, response.body) };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return {
          kind: 'failed',
          error: { code: 'provider_error', message: 'BFL returned a response that is not JSON.', retryable: true },
        };
      }
      const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : null;
      const pollingUrl = typeof record.polling_url === 'string' ? record.polling_url : null;
      if (!id || !pollingUrl) {
        return {
          kind: 'failed',
          error: {
            code: 'provider_error',
            message: 'BFL accepted the request but returned no id or polling URL, so it cannot be followed.',
            retryable: true,
          },
        };
      }

      return { kind: 'pending', remoteId: id, pollUrl: pollingUrl, progress: null };
    },

    async poll(input): Promise<MediaJobOutcome> {
      const apiKey = await key();
      if (!apiKey) {
        return {
          kind: 'failed',
          error: {
            code: 'missing_key',
            message: 'The Black Forest Labs API key is no longer available, so this video cannot be followed.',
            retryable: false,
          },
        };
      }
      if (!input.pollUrl) {
        return {
          kind: 'failed',
          error: {
            code: 'provider_error',
            message: 'The polling URL for this job was not recorded, so it cannot be followed.',
            retryable: false,
          },
        };
      }

      const spec: HttpRequestSpec = {
        url: input.pollUrl,
        method: 'GET',
        headers: { 'x-key': apiKey },
        body: null,
      };
      const response = await options.transport.send(spec, { timeoutMs: POLL_TIMEOUT_MS, maxRetries: 0 });
      if (response.status >= 300) {
        return { kind: 'failed', error: mediaErrorFromResponse('Black Forest Labs', response.status, response.body) };
      }

      const parsed = parseBflPollBody(response.body);
      if (parsed.error) {
        return {
          kind: 'failed',
          error: { code: 'provider_error', message: parsed.error, retryable: true },
        };
      }
      if (parsed.status === 'pending') {
        return { kind: 'pending', remoteId: input.remoteId, pollUrl: input.pollUrl, progress: null };
      }
      if (!parsed.sampleUrl) {
        return {
          kind: 'failed',
          error: {
            code: 'provider_error',
            message: 'BFL reported the video ready but returned no file URL.',
            retryable: true,
          },
        };
      }

      // The signed URL expires in ten minutes: fetch the bytes now, not later.
      try {
        const bytes = await downloadBytes(parsed.sampleUrl, {
          allowedHosts: BFL_RESULT_HOSTS,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        return {
          kind: 'done',
          outputs: [{ bytes, mime: 'video/mp4' }],
          providerJobId: input.remoteId,
        };
      } catch (error) {
        const message =
          error instanceof DownloadError
            ? error.message
            : "The video was generated but its download failed. The provider's link may have expired; generate it again.";
        return { kind: 'failed', error: { code: 'provider_error', message, retryable: false } };
      }
    },
  };
}
