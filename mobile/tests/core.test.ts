/**
 * Shared-core and turn-assembly tests for the mobile project.
 *
 * These are the pieces that run in plain Node: the copied shared core (params,
 * errors, URL policy, attachment sizing) and the mobile turn helpers. Screens and
 * native modules are verified by `tsc --noEmit` and the Metro bundle, not here.
 */
import { describe, expect, it } from 'vitest';
import { appError, asAppError, errorForStatus, formatIpcErrorMessage, redactSecrets } from '@core/errors';
import { resolveGenerationParams, validateGenerationParams } from '@core/params';
import { validateEndpointUrl, isExternalLinkAllowed } from '@core/url-policy';
import { ATTACHMENT_LIMITS, formatBytes } from '@core/attachments';
import { normaliseSettings } from '@core/settings';
import { DEFAULT_SETTINGS } from '@core/defaults';
import type { ModelDescriptor } from '@core/types';
import { composeHistory, resolveParamsForTurn } from '@ai/turn';
import type { IngestedAttachment } from '@/attachments/ingest';
import { createHash } from '@/keys/hash';

const HTTPS = { requireHttps: true, allowInsecureLocalhost: true };

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'm',
    providerId: 'p',
    modelId: 'test',
    displayName: 'Test',
    source: 'catalog',
    capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false },
    limits: {},
    description: '',
    supportedParams: ['temperature', 'topP', 'maxOutputTokens'],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attachment(overrides: Partial<IngestedAttachment> = {}): IngestedAttachment {
  return {
    meta: {
      id: 'a1',
      kind: 'text',
      name: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 1536,
      contentStatus: 'extracted',
      contentNote: null,
      extractedChars: 12,
      sentToProvider: false,
      imageWidth: null,
      imageHeight: null,
      previewDataUrl: null,
      durationMs: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    text: 'extracted body',
    image: null,
    uri: 'file:///tmp/a',
    ...overrides,
  };
}

describe('shared core on mobile', () => {
  it('keeps the same precedence order as desktop', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [
        { source: 'app-default', params: { temperature: 0.7 } },
        { source: 'agent', params: { temperature: 0.3 } },
        { source: 'conversation', params: { temperature: 0.1 } },
      ],
    });
    expect(result.values.temperature).toBe(0.1);
  });

  it('drops a parameter the model does not document', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { topK: 20 } }],
    });
    expect(result.values.topK).toBeUndefined();
    expect(result.suppressed.topK).toMatch(/does not document/i);
  });

  it('validates parameter ranges', () => {
    expect(validateGenerationParams({ temperature: 5 })).toHaveLength(1);
    expect(validateGenerationParams({ temperature: 0.5 })).toHaveLength(0);
  });

  it('refuses a plain-HTTP remote endpoint', () => {
    expect(validateEndpointUrl('http://api.example.com/v1', HTTPS).ok).toBe(false);
    expect(validateEndpointUrl('https://api.example.com/v1', HTTPS).ok).toBe(true);
  });

  it('only opens HTTPS links', () => {
    expect(isExternalLinkAllowed('https://example.com')).toBe(true);
    expect(isExternalLinkAllowed('http://example.com')).toBe(false);
  });

  it('maps HTTP statuses to the shared vocabulary', () => {
    expect(errorForStatus(401, 'nope').code).toBe('invalid_key');
    expect(errorForStatus(429, null).code).toBe('rate_limited');
    expect(errorForStatus(500, null).retryable).toBe(true);
  });

  it('redacts a credential from an error message', () => {
    expect(redactSecrets('key sk-live-abcdef123456 rejected')).not.toContain('sk-live-abcdef123456');
  });

  it('decodes the bridge error marker the desktop uses', () => {
    const encoded = formatIpcErrorMessage(appError('missing_key', 'No key stored.'));
    expect(asAppError(new Error(encoded)).code).toBe('missing_key');
  });

  it('formats attachment sizes for the chips', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('normalises a corrupt settings document', () => {
    const settings = normaliseSettings({ general: 'nope', generation: { maxRetries: 99 } });
    expect(settings.general.theme).toBe(DEFAULT_SETTINGS.general.theme);
    expect(settings.generation.maxRetries).toBe(5);
  });

  it('keeps the attachment limits in one place', () => {
    expect(ATTACHMENT_LIMITS.maxPerMessage).toBe(8);
    expect(ATTACHMENT_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024);
  });
});

describe('mobile turn assembly', () => {
  it('leaves a plain message untouched', () => {
    expect(composeHistory('hello', [])).toBe('hello');
  });

  it('fences extracted document text with the file name', () => {
    const composed = composeHistory('summarise', [attachment()]);
    expect(composed).toContain('--- Attached file: notes.md');
    expect(composed).toContain('extracted body');
    expect(composed).toContain('--- End of notes.md ---');
  });

  it('names a PDF whose contents mobile could not read', () => {
    const composed = composeHistory('look at this', [
      attachment({
        meta: {
          ...attachment().meta,
          name: 'report.pdf',
          mimeType: 'application/pdf',
          contentStatus: 'metadata-only',
          contentNote: 'PDF extraction is desktop-only in this release.',
        },
        text: null,
      }),
    ]);
    expect(composed).toContain('contents not included');
    expect(composed).toContain('desktop-only');
  });

  it('does not fold an image into the text', () => {
    const image = attachment({
      meta: { ...attachment().meta, kind: 'image', name: 'shot.png', mimeType: 'image/png' },
      text: null,
    });
    expect(composeHistory('what is this', [image])).toBe('what is this');
  });

  it('resolves turn parameters through the shared precedence', () => {
    const params = resolveParamsForTurn({
      model: model(),
      appDefaults: { temperature: 0.7 },
      agentParams: { temperature: 0.2 },
      conversationParams: null,
      weirdness: { mode: 'off', bias: 0.5 },
    });
    expect(params.temperature).toBe(0.2);
  });
});

describe('key fingerprint hash', () => {
  it('is a stable 64-character digest', () => {
    const digest = createHash('sk-test-key');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(createHash('sk-test-key'));
    expect(digest).not.toBe(createHash('sk-test-key2'));
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(createHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
