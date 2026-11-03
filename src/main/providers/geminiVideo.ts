/**
 * Gemini video generation, on the Interactions endpoint.
 *
 * Video is genuinely asynchronous here, which is why the job engine exists:
 *
 *  - `submit` posts the interaction with `background: true` and returns the
 *    interaction id as a provider handle;
 *  - `poll` reads `GET /interactions/{id}` until the status is terminal, then
 *    walks `steps[] → model_output → content[type=video].data`.
 *
 * The video arrives inline as base64, even when it was created with
 * `delivery: "uri"` — the documentation states the `uri` field is only guaranteed
 * on the creation response — so there is no expiring link to chase for this
 * provider. That matters: an expiring link is the failure mode this adapter does
 * not have.
 *
 * What is not sent, because the API does not document it: a duration, a negative
 * prompt, a seed, or a count. Gemini Omni extends a clip in ten-second steps rather
 * than taking a duration, and the model cards say so; offering a duration control
 * here would be a lie the request cannot honour.
 */
import type { MediaJobAdapter, MediaJobOutcome, MediaReference, SubmitMediaInput } from '@shared/media-job';
import type { MediaParams } from '@shared/media';
import type { HttpRequestSpec, ProviderTransport } from '@shared/provider-contract';
import { joinUrl } from '@shared/url-policy';
import { decodeBase64, mediaErrorFromResponse } from './media-adapter';
import { buildGeminiImageBody } from './geminiImages';

/** A video generation is expected to take minutes, not a chat round trip. */
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 60_000;

export interface GeminiVideoAdapterOptions {
  baseUrl: string;
  apiKey(): Promise<string>;
  transport: ProviderTransport;
  timeoutMs?: number;
}

function stringParam(params: MediaParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildGeminiVideoBody(input: SubmitMediaInput): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  for (const reference of input.references ?? []) {
    blocks.push({
      type: 'image',
      mime_type: reference.mime,
      data: Buffer.from(reference.bytes).toString('base64'),
    });
  }

  const format: Record<string, unknown> = { type: 'video' };
  const aspectRatio = stringParam(input.params, 'aspect_ratio');
  if (aspectRatio !== undefined) format.aspect_ratio = aspectRatio;
  const resolution = stringParam(input.params, 'resolution');
  if (resolution !== undefined) format.resolution = resolution;

  return {
    model: input.modelId,
    input: blocks,
    response_format: format,
    // The only way to be told "keep polling" rather than blocking on a request
    // that may outlive every sensible HTTP timeout.
    background: true,
  };
}

interface VideoStep {
  type?: unknown;
  content?: Array<{ type?: unknown; data?: unknown; mime_type?: unknown }>;
}

/** Statuses the Interactions API uses. Unknown values are treated as "still working". */
const TERMINAL_FAILURES = new Set(['failed', 'error', 'cancelled', 'canceled']);

/**
 * Reads a video out of an interaction body.
 *
 * Returns `null` when there is no video yet (still running), and a failure when
 * the interaction reports one. `providerJobId` is the interaction id, kept so a
 * support question can be traced to the provider's own record.
 */
export function parseGeminiInteraction(body: string): MediaJobOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      kind: 'failed',
      error: { code: 'provider_error', message: 'Gemini returned a response that is not JSON.', retryable: true },
    };
  }

  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const interactionId = typeof record.id === 'string' ? record.id : null;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';

  const steps = (Array.isArray(record.steps) ? record.steps : []) as VideoStep[];
  for (const step of steps) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) {
      if (block.type !== 'video') continue;
      const bytes = decodeBase64(block.data);
      if (!bytes) continue;
      const mime = typeof block.mime_type === 'string' ? block.mime_type : 'video/mp4';
      return { kind: 'done', outputs: [{ bytes, mime }], providerJobId: interactionId };
    }
  }

  if (TERMINAL_FAILURES.has(status)) {
    const error = (typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return {
      kind: 'failed',
      error: {
        code: 'provider_error',
        message:
          typeof error.message === 'string'
            ? `Gemini could not complete the video: ${error.message}`
            : 'Gemini reported that the video generation failed.',
        // A provider-side failure after accepting the job is not the request's
        // fault; retrying the same job is reasonable.
        retryable: true,
      },
    };
  }

  if (!interactionId) {
    return {
      kind: 'failed',
      error: {
        code: 'provider_error',
        message: 'Gemini accepted the request but returned no interaction id, so it cannot be followed.',
        retryable: true,
      },
    };
  }

  return { kind: 'pending', remoteId: interactionId, pollUrl: null, progress: null };
}

export function createGeminiVideoAdapter(options: GeminiVideoAdapterOptions): MediaJobAdapter {
  const submitTimeout = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;

  const headers = async (): Promise<Record<string, string> | null> => {
    const apiKey = await options.apiKey();
    if (apiKey.length === 0) return null;
    return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  };

  return {
    // The documentation exposes no cancel for a background interaction; deleting a
    // stored interaction is not the same thing and is not offered as one.
    supportsCancel: false,
    maxConcurrent: null,

    async submit(input: SubmitMediaInput): Promise<MediaJobOutcome> {
      const requestHeaders = await headers();
      if (!requestHeaders) {
        return {
          kind: 'failed',
          error: {
            code: 'missing_key',
            message:
              'No Google Gemini API key is stored, so video generation cannot run. Add one on the Models & Providers page.',
            retryable: false,
          },
        };
      }

      const spec: HttpRequestSpec = {
        url: joinUrl(options.baseUrl, 'interactions'),
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(buildGeminiVideoBody(input)),
      };
      const response = await options.transport.send(spec, {
        timeoutMs: submitTimeout,
        maxRetries: 0,
      });
      if (response.status >= 300) {
        return { kind: 'failed', error: mediaErrorFromResponse('Google Gemini', response.status, response.body) };
      }
      return parseGeminiInteraction(response.body);
    },

    async poll(input): Promise<MediaJobOutcome> {
      const requestHeaders = await headers();
      if (!requestHeaders) {
        return {
          kind: 'failed',
          error: {
            code: 'missing_key',
            message: 'The Gemini API key is no longer available, so this video cannot be followed.',
            retryable: false,
          },
        };
      }

      const spec: HttpRequestSpec = {
        url: joinUrl(options.baseUrl, `interactions/${encodeURIComponent(input.remoteId)}`),
        method: 'GET',
        headers: requestHeaders,
        body: null,
      };
      const response = await options.transport.send(spec, {
        timeoutMs: POLL_TIMEOUT_MS,
        maxRetries: 0,
      });
      if (response.status >= 300) {
        return { kind: 'failed', error: mediaErrorFromResponse('Google Gemini', response.status, response.body) };
      }
      return parseGeminiInteraction(response.body);
    },
  };
}

/** Reference images for image-to-video, kept next to the body builder for symmetry. */
export type { MediaReference };
