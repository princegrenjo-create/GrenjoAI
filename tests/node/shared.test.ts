import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import {
  appError,
  AppError,
  asAppError,
  errorForStatus,
  formatIpcErrorMessage,
  parseIpcErrorMessage,
  redactSecrets,
  toAppError,
} from '@shared/errors';
import {
  resolveGenerationParams,
  validateGenerationParams,
  trimHistory,
  estimateTokens,
} from '@shared/params';
import { mergeSettings, normaliseSettings } from '@shared/settings';
import {
  isExternalLinkAllowed,
  isLoopbackHost,
  joinUrl,
  validateEndpointUrl,
} from '@shared/url-policy';
import type { ModelDescriptor } from '@shared/types';

const HTTPS = { requireHttps: true, allowInsecureLocalhost: true };

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'm1',
    providerId: 'p1',
    modelId: 'test-model',
    displayName: 'Test',
    source: 'catalog',
    capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false, imageOutput: false, imageEditing: false, videoInput: false, videoOutput: false, audioInput: false, audioOutput: false, embeddings: false },
    limits: {},
    description: '',
    supportedParams: ['temperature', 'topP', 'maxOutputTokens', 'stop'],
    weirdnessSupported: false,
    baseUrlOverride: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('generation parameter resolution', () => {
  it('applies precedent order: model default < app < agent < conversation', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [
        { source: 'model-default', params: { temperature: 1 } },
        { source: 'app-default', params: { temperature: 0.7, maxOutputTokens: 500 } },
        { source: 'agent', params: { temperature: 0.3 } },
        { source: 'conversation', params: { temperature: 0.1 } },
      ],
    });
    expect(result.values.temperature).toBe(0.1);
    expect(result.provenance.temperature).toBe('conversation');
    expect(result.values.maxOutputTokens).toBe(500);
    expect(result.provenance.maxOutputTokens).toBe('app-default');
  });

  it('drops a parameter the model does not support and explains why', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { topK: 20, temperature: 0.5 } }],
    });
    expect(result.values.topK).toBeUndefined();
    expect(result.suppressed.topK).toMatch(/does not document/i);
    expect(result.values.temperature).toBe(0.5);
  });

  it('clamps values into the documented range', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { temperature: 9, topP: -3 } }],
    });
    expect(result.values.temperature).toBe(2);
    expect(result.values.topP).toBe(0);
  });

  it('caps max output tokens at the model limit', () => {
    const result = resolveGenerationParams({
      model: model({ limits: { maxOutputTokens: 1024 } }),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { maxOutputTokens: 9000 } }],
    });
    expect(result.values.maxOutputTokens).toBe(1024);
    expect(result.suppressed.maxOutputTokens).toMatch(/capped/i);
  });

  it('forwards weirdness only to a model that declares support', () => {
    const native = resolveGenerationParams({
      model: model({ weirdnessSupported: true, supportedParams: ['temperature', 'weirdness'] }),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { weirdness: 0.4 } }],
    });
    expect(native.values.weirdness).toBe(0.4);
    expect(native.creativityBias).toBeNull();

    const unsupported = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'off', bias: 0.5 },
      layers: [{ source: 'app-default', params: { weirdness: 0.4 } }],
    });
    expect(unsupported.values.weirdness).toBeUndefined();
    expect(unsupported.suppressed.weirdness).toMatch(/does not support a weirdness parameter/i);
  });

  it('applies the labelled creativity bias when weirdness is unsupported and the fallback is on', () => {
    const result = resolveGenerationParams({
      model: model(),
      weirdness: { mode: 'creativityBias', bias: 1 },
      layers: [{ source: 'app-default', params: { weirdness: 0.5, temperature: 0.5, topP: 0.5 } }],
    });
    expect(result.values.weirdness).toBeUndefined();
    expect(result.creativityBias).not.toBeNull();
    expect(result.values.temperature).toBeCloseTo(0.75, 5);
    expect(result.values.topP).toBeCloseTo(0.575, 5);
    expect(result.suppressed.weirdness).toMatch(/creativity bias/i);
  });

  it('validates ranges and lists', () => {
    expect(validateGenerationParams({ temperature: 3 })).toHaveLength(1);
    expect(validateGenerationParams({ temperature: 0.5, topP: 0.9 })).toHaveLength(0);
    expect(validateGenerationParams({ stop: ['a', 'b', 'c', 'd', 'e'] })).toHaveLength(1);
  });
});

describe('history trimming', () => {
  it('keeps the newest messages and always keeps the final question', () => {
    const history = [
      { role: 'user' as const, content: 'x'.repeat(4000) },
      { role: 'assistant' as const, content: 'y'.repeat(4000) },
      { role: 'user' as const, content: 'z'.repeat(4000) },
    ];
    const trimmed = trimHistory(history, 500);
    expect(trimmed.kept).toHaveLength(1);
    expect(trimmed.kept[0]?.content.startsWith('z')).toBe(true);
    expect(trimmed.dropped).toBe(2);
  });

  it('estimates tokens roughly four characters to one', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('endpoint URL policy', () => {
  it('accepts an HTTPS base URL and normalises it', () => {
    expect(validateEndpointUrl('https://api.example.com/v1/', HTTPS)).toEqual({
      ok: true,
      url: 'https://api.example.com/v1',
    });
  });

  it('rejects plain HTTP for a remote host', () => {
    const result = validateEndpointUrl('http://api.example.com/v1', HTTPS);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : '').toMatch(/plain http/i);
  });

  it('allows plain HTTP on loopback only when the setting permits it', () => {
    expect(validateEndpointUrl('http://localhost:11434/v1', HTTPS).ok).toBe(true);
    expect(
      validateEndpointUrl('http://localhost:11434/v1', {
        requireHttps: true,
        allowInsecureLocalhost: false,
      }).ok,
    ).toBe(false);
    expect(isLoopbackHost('127.0.0.5')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('rejects credentials embedded in the URL, query strings and odd schemes', () => {
    expect(validateEndpointUrl('https://user:pass@example.com/v1', HTTPS).ok).toBe(false);
    expect(validateEndpointUrl('https://example.com/v1?key=abc', HTTPS).ok).toBe(false);
    expect(validateEndpointUrl('file:///etc/passwd', HTTPS).ok).toBe(false);
    expect(validateEndpointUrl('javascript:alert(1)', HTTPS).ok).toBe(false);
    expect(validateEndpointUrl('not a url', HTTPS).ok).toBe(false);
  });

  it('only allows HTTPS external links', () => {
    expect(isExternalLinkAllowed('https://example.com')).toBe(true);
    expect(isExternalLinkAllowed('http://example.com')).toBe(false);
    expect(isExternalLinkAllowed('javascript:alert(1)')).toBe(false);
    expect(isExternalLinkAllowed('https://user:pass@example.com')).toBe(false);
  });

  it('joins a base URL and a path without a double slash', () => {
    expect(joinUrl('https://x.test/v1/', '/chat/completions')).toBe(
      'https://x.test/v1/chat/completions',
    );
  });
});

describe('error redaction and mapping', () => {
  it('removes key-shaped tokens from a message', () => {
    const message = redactSecrets(
      'failed with Authorization: Bearer sk-live-abcdef123456 and AIzaSyABCDEFGHIJKLMNOP and eyJhbGciOiJI.eyJzdWIiOiIx.abcdefgh',
    );
    expect(message).not.toContain('sk-live-abcdef123456');
    expect(message).not.toContain('AIzaSyABCDEFGHIJKLMNOP');
    expect(message).not.toContain('eyJhbGciOiJI');
    expect(message).toContain('REDACTED');
  });

  it('redacts a key echoed in a query string', () => {
    expect(redactSecrets('GET https://x.test/v1?api_key=supersecret123')).toContain(
      'api_key=REDACTED',
    );
  });

  it('maps HTTP statuses to the shared error vocabulary', () => {
    expect(errorForStatus(401, 'bad key').code).toBe('invalid_key');
    expect(errorForStatus(404, null).code).toBe('model_not_found');
    expect(errorForStatus(400, 'bad body').code).toBe('bad_request');
    expect(errorForStatus(429, null).retryable).toBe(true);
    expect(errorForStatus(503, null).retryable).toBe(true);
    expect(errorForStatus(413, null).code).toBe('context_length');
  });

  it('redacts a provider body before it reaches the error shape', () => {
    const shape = errorForStatus(401, 'your key sk-abcdef123456 is wrong');
    expect(shape.message).not.toContain('sk-abcdef123456');
  });

  it('recovers a structured error from the preload bridge', () => {
    const error = new Error('boom') as Error & { appError: unknown };
    error.appError = appError('rate_limited', 'slow down');
    expect(asAppError(error).code).toBe('rate_limited');
    expect(asAppError(new AppError(appError('offline', 'no net'))).code).toBe('offline');
    expect(asAppError('plain string').code).toBe('unknown');
  });
});

/**
 * Electron's contextBridge keeps only a thrown value's message (proven by
 * `.work/2026-10-29-personal-ai-desk/tmp/apperror-probe.cjs`), so the code must
 * travel inside the message. These tests pin both ends of that encoding.
 */
describe('IPC error message encoding', () => {
  it('round-trips a code through the message', () => {
    const original = appError('missing_key', 'No API key is stored for DeepSeek.');
    const message = formatIpcErrorMessage(original);

    expect(message).toBe('missing_key: No API key is stored for DeepSeek.');
    // What actually arrives in the renderer: a bare Error with only that message.
    const arrival = new Error(message);
    const decoded = asAppError(arrival);
    expect(decoded.code).toBe('missing_key');
    expect(decoded.message).toBe('No API key is stored for DeepSeek.');
    expect(decoded.retryable).toBe(false);
  });

  it('derives retryability from the code, since the boolean does not travel', () => {
    expect(asAppError(new Error(formatIpcErrorMessage(appError('rate_limited', 'slow down')))).retryable).toBe(true);
    expect(asAppError(new Error(formatIpcErrorMessage(appError('invalid_key', 'bad key')))).retryable).toBe(false);
    expect(asAppError(new Error(formatIpcErrorMessage(appError('timeout', 'no answer')))).retryable).toBe(true);
    expect(asAppError(new Error(formatIpcErrorMessage(appError('offline', 'no net')))).retryable).toBe(true);
  });

  it('decodes through toAppError as well as asAppError', () => {
    const text = formatIpcErrorMessage(appError('context_length', 'too long'));
    expect(toAppError(new Error(text)).code).toBe('context_length');
    expect(toAppError(text).code).toBe('context_length');
  });

  it('does not mistake ordinary text for an encoded error', () => {
    expect(parseIpcErrorMessage('Something failed: not a code')).toBeNull();
    expect(asAppError(new Error('Connection refused')).code).toBe('unknown');
    expect(asAppError(new Error('Connection refused')).message).toBe('Connection refused');
  });

  it('keeps a credential out of the encoded message', () => {
    const encoded = formatIpcErrorMessage(appError('invalid_key', 'your key sk-live-abcdef1234567890 was rejected'));
    expect(encoded).not.toContain('sk-live-abcdef1234567890');
    expect(asAppError(new Error(encoded)).message).not.toContain('sk-live-abcdef1234567890');
  });
});

describe('settings composition', () => {
  it('fills a corrupt document with defaults without throwing', () => {
    const settings = normaliseSettings({ general: 'nope', generation: { maxRetries: 99 } });
    expect(settings.general.theme).toBe(DEFAULT_SETTINGS.general.theme);
    expect(settings.generation.maxRetries).toBe(5);
    expect(settings.schemaVersion).toBe(DEFAULT_SETTINGS.schemaVersion);
  });

  it('clamps out-of-range values and ignores unknown keys', () => {
    const settings = normaliseSettings({
      generation: { requestTimeoutMs: 5, historyTokenBudget: 9_999_999 },
      advanced: { logLevel: 'verbose' },
      rogue: true,
    });
    expect(settings.generation.requestTimeoutMs).toBe(1000);
    expect(settings.generation.historyTokenBudget).toBe(2_000_000);
    expect(settings.advanced.logLevel).toBe('info');
    expect('rogue' in settings).toBe(false);
  });

  it('merges a partial patch without losing untouched sections', () => {
    const merged = mergeSettings(normaliseSettings(DEFAULT_SETTINGS), {
      general: { theme: 'light' },
      defaults: { params: { temperature: 0.2 } },
    });
    expect(merged.general.theme).toBe('light');
    expect(merged.general.sendOnEnter).toBe(DEFAULT_SETTINGS.general.sendOnEnter);
    expect(merged.defaults.params.temperature).toBe(0.2);
    expect(merged.defaults.params.maxOutputTokens).toBe(
      DEFAULT_SETTINGS.defaults.params.maxOutputTokens,
    );
  });
});
