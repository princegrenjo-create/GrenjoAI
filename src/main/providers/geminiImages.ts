/**
 * Gemini image-generation adapter.
 *
 * Endpoint (confirmed against the Gemini API documentation on 2026-11-03):
 * `POST /v1beta/interactions` with `x-goog-api-key`. This is **not** the chat
 * `generateContent` shape: the body carries an `input` array of content blocks and
 * a `response_format` array describing the output, and the reply is a list of
 * steps. There is no `output_image` field in the raw REST payload — that is an SDK
 * convenience — so the parser walks `steps[] → model_output → content[] → image`.
 *
 * What this adapter does not send, because the API does not document it: a
 * negative prompt, a seed, or a count of outputs (`n`). Those controls are not
 * offered for these models, so they cannot reach the wire from the UI.
 */
import type { MediaJobAdapter, MediaJobOutcome, SubmitMediaInput } from '@shared/media-job';
import type { MediaParams } from '@shared/media';
import type { HttpRequestSpec, ProviderTransport } from '@shared/provider-contract';
import { joinUrl } from '@shared/url-policy';
import { decodeBase64, mediaErrorFromResponse, toDataUrlData } from './media-adapter';

const DEFAULT_TIMEOUT_MS = 180_000;

/** `image_size` is a preset, not pixels: the API documents these three. */
const IMAGE_SIZES = new Set(['1K', '2K', '4K', '512px']);

export interface GeminiImageAdapterOptions {
  baseUrl: string;
  apiKey(): Promise<string>;
  transport: ProviderTransport;
  timeoutMs?: number;
}

function stringParam(params: MediaParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildGeminiImageBody(input: SubmitMediaInput): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];

  for (const reference of input.references ?? []) {
    blocks.push({
      type: 'image',
      mime_type: reference.mime,
      data: toDataUrlData(reference.mime, reference.bytes),
    });
  }

  const format: Record<string, unknown> = {
    type: 'image',
    mime_type: stringParam(input.params, 'mime_type') ?? 'image/png',
  };
  const aspectRatio = stringParam(input.params, 'aspect_ratio');
  if (aspectRatio !== undefined) format.aspect_ratio = aspectRatio;
  const imageSize = stringParam(input.params, 'image_size');
  if (imageSize !== undefined && IMAGE_SIZES.has(imageSize)) format.image_size = imageSize;

  return {
    model: input.modelId,
    input: blocks,
    response_format: [format],
  };
}

export function createGeminiImageAdapter(options: GeminiImageAdapterOptions): MediaJobAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const submit = async (input: SubmitMediaInput): Promise<MediaJobOutcome> => {
    const apiKey = await options.apiKey();
    if (apiKey.length === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'missing_key',
          message:
            'No Google Gemini API key is stored, so image generation cannot run. Add one on the Models & Providers page.',
          retryable: false,
        },
      };
    }

    const spec: HttpRequestSpec = {
      url: joinUrl(options.baseUrl, 'interactions'),
      method: 'POST',
      headers: {
        // The key travels in a header, never a query string, so it cannot end up
        // in a URL that is logged or shown.
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildGeminiImageBody(input)),
    };

    const response = await options.transport.send(spec, { timeoutMs, maxRetries: 0 });
    if (response.status >= 300) {
      return {
        kind: 'failed',
        error: mediaErrorFromResponse('Google Gemini', response.status, response.body),
      };
    }

    return parseGeminiImageResponse(response.body);
  };

  return {
    supportsCancel: false,
    maxConcurrent: null,
    submit,
    async poll() {
      return {
        kind: 'failed',
        error: {
          code: 'provider_error',
          message: 'Gemini image generation is synchronous and cannot be polled.',
          retryable: false,
        },
      };
    },
  };
}

interface ContentBlock {
  type?: unknown;
  data?: unknown;
  mime_type?: unknown;
}

/**
 * Parses one Interactions response.
 *
 * Walks every `model_output` step in order and keeps every image block, because a
 * model that interleaves text and images returns several. Thinking steps carry
 * interim images too; those are `type: 'thought'` and are skipped — the last image
 * in a model_output step is the rendered one.
 */
export function parseGeminiImageResponse(body: string): MediaJobOutcome {
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
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const interactionId = typeof record.id === 'string' ? record.id : null;

  const outputs: Array<{ bytes: Uint8Array; mime: string; width?: number; height?: number }> = [];
  for (const step of steps) {
    const entry = (typeof step === 'object' && step !== null ? step : {}) as Record<string, unknown>;
    if (entry.type !== 'model_output') continue;
    const content = Array.isArray(entry.content) ? entry.content : [];
    for (const block of content as ContentBlock[]) {
      if (block.type !== 'image') continue;
      const bytes = decodeBase64(block.data);
      if (!bytes) continue;
      const mime = typeof block.mime_type === 'string' ? block.mime_type : 'image/png';
      outputs.push({ bytes, mime });
    }
  }

  if (outputs.length === 0) {
    return {
      kind: 'failed',
      error: {
        code: 'provider_error',
        message: 'Gemini reported success but the reply contained no image block.',
        retryable: true,
      },
    };
  }

  return { kind: 'done', outputs, providerJobId: interactionId };
}
