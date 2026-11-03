/**
 * OpenAI Images adapter.
 *
 * Endpoints (confirmed against the OpenAI Images reference on 2026-11-03):
 *  - `POST /v1/images/generations` — text to image, JSON body.
 *  - `POST /v1/images/edits` — image to image, JSON body with an `images` array
 *    of `{ image_url }` (a data URL is accepted), optional `mask`, and up to 16
 *    reference images.
 *
 * What this adapter deliberately does **not** send: `negative_prompt`, `seed` and
 * `aspect_ratio` do not exist on this API. The model catalogue declares which
 * parameters a model honours, and the Image Studio only offers those, so an
 * unsupported field cannot reach the wire from the UI. Dropping it silently here
 * would be the same failure with a quieter symptom.
 *
 * The response carries `b64_json` only: "url" is unsupported for the GPT image
 * models this build targets, so there is no expiring URL to download.
 */
import type { MediaJobAdapter, MediaJobOutcome, SubmitMediaInput } from '@shared/media-job';
import type { MediaParams } from '@shared/media';
import type { FetchLike, HttpRequestSpec } from '@shared/provider-contract';
import { joinUrl } from '@shared/url-policy';
import type { ProviderTransport } from '@shared/provider-contract';
import { decodeBase64, mediaErrorFromResponse, parseErrorBody, toDataUrl } from './media-adapter';

/** Generation is documented as taking up to two minutes for a complex prompt. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Which documented sizes this build offers, so a caller cannot invent one. */
const DOCUMENTED_SIZES = new Set([
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '256x256',
  '512x512',
  '1792x1024',
  '1024x1792',
]);

export interface OpenAiImageAdapterOptions {
  baseUrl: string;
  /** Resolved per call, so a rotated key takes effect without a restart. */
  apiKey(): Promise<string>;
  transport: ProviderTransport;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function stringParam(params: MediaParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberParam(params: MediaParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildOpenAiImageBody(input: SubmitMediaInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.modelId,
    prompt: input.prompt,
  };

  const n = numberParam(input.params, 'n');
  if (n !== undefined) body.n = Math.min(10, Math.max(1, Math.trunc(n)));

  const size = stringParam(input.params, 'size');
  // An arbitrary WxH is documented (multiples of 16, 1:3–3:1); only the named
  // presets are in the set, so a custom size is passed through verbatim and left
  // to the provider to accept or reject.
  if (size !== undefined && (DOCUMENTED_SIZES.has(size) || /^\d+x\d+$/.test(size))) {
    body.size = size;
  }

  for (const key of ['quality', 'background', 'output_format', 'moderation'] as const) {
    const value = stringParam(input.params, key);
    if (value !== undefined) body[key] = value;
  }

  const compression = numberParam(input.params, 'output_compression');
  if (compression !== undefined) body.output_compression = Math.min(100, Math.max(0, Math.trunc(compression)));

  const safety = stringParam(input.params, 'safety_identifier');
  if (safety !== undefined) body.safety_identifier = safety;

  // The GPT image models always return base64; asking for a URL would be ignored.
  body.response_format = 'b64_json';

  if (input.references && input.references.length > 0) {
    body.images = input.references
      .slice(0, 16)
      .map((reference) => ({ image_url: toDataUrl(reference.mime, reference.bytes) }));
    if (input.mask) {
      body.mask = { image_url: toDataUrl(input.mask.mime, input.mask.bytes) };
    }
  }

  return body;
}

export function createOpenAiImageAdapter(options: OpenAiImageAdapterOptions): MediaJobAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const submit = async (input: SubmitMediaInput): Promise<MediaJobOutcome> => {
    const apiKey = await options.apiKey();
    if (apiKey.length === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'missing_key',
          message: 'No OpenAI API key is stored, so image generation cannot run. Add one on the Models & Providers page.',
          retryable: false,
        },
      };
    }

    const editing = (input.references?.length ?? 0) > 0;
    const spec: HttpRequestSpec = {
      url: joinUrl(options.baseUrl, editing ? 'images/edits' : 'images/generations'),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildOpenAiImageBody(input)),
    };

    const response = await options.transport.send(spec, { timeoutMs, maxRetries: 0 });
    if (response.status >= 300) {
      return {
        kind: 'failed',
        error: mediaErrorFromResponse('OpenAI', response.status, response.body),
      };
    }

    return parseOpenAiImageResponse(response.body);
  };

  return {
    // The Images API has no job to cancel: the request either completes or it does
    // not, and a client-side abort is the only lever.
    supportsCancel: false,
    maxConcurrent: null,
    submit,
    async poll() {
      // A synchronous provider is never polled. Reaching here means the engine was
      // given a job from a different adapter; fail loudly rather than hang.
      return {
        kind: 'failed',
        error: {
          code: 'provider_error',
          message: 'OpenAI image generation is synchronous and cannot be polled.',
          retryable: false,
        },
      };
    },
  };
}

/**
 * Parses one ImagesResponse.
 *
 * `data[].b64_json` is the only image channel for the GPT image models; a body
 * with no decodable image is a failure, not an empty success — the difference
 * matters because an empty success would mark a job done with nothing to show.
 */
export function parseOpenAiImageResponse(body: string): MediaJobOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      kind: 'failed',
      error: { code: 'provider_error', message: 'OpenAI returned a response that is not JSON.', retryable: true },
    };
  }

  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const outputFormat = typeof record.output_format === 'string' ? record.output_format : 'png';
  const mime = outputFormat === 'jpeg' ? 'image/jpeg' : outputFormat === 'webp' ? 'image/webp' : 'image/png';

  const size = typeof record.size === 'string' ? record.size : null;
  const [width, height] = size && /^\d+x\d+$/.test(size) ? size.split('x').map(Number) : [undefined, undefined];

  const outputs = data
    .map((entry) => {
      const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      return decodeBase64(item.b64_json);
    })
    .filter((bytes): bytes is Uint8Array => bytes !== null)
    .map((bytes) => ({ bytes, mime, width, height }));

  if (outputs.length === 0) {
    const parsedError = parseErrorBody(body);
    return {
      kind: 'failed',
      error: {
        code: 'provider_error',
        message: `OpenAI reported success but returned no image.${parsedError.message ? ` ${parsedError.message}` : ''}`,
        retryable: true,
      },
    };
  }

  return { kind: 'done', outputs, providerJobId: null };
}
