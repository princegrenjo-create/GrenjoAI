/**
 * Credential-handling battery across all five adapters.
 *
 * These are the assertions the rest of the app's security posture rests on:
 * the key travels in a header only, never in a URL, never in a body, and a
 * provider that echoes it back cannot get it into an error message the UI or a
 * log would show.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRequestSpec } from '@shared/provider-contract';
import type { ProviderKind } from '@shared/types';
import { createRegistry } from '@main/providers/registry';
import {
  TEST_ANTHROPIC_KEY,
  TEST_GEMINI_KEY,
  TEST_KEY,
  createRequest,
  createRuntime,
  headersCarrying,
} from './fake-http';

const registry = createRegistry();

const KEY_FOR: Record<ProviderKind, string> = {
  deepseek: TEST_KEY,
  openai: TEST_KEY,
  gemini: TEST_GEMINI_KEY,
  anthropic: TEST_ANTHROPIC_KEY,
  'openai-compatible': TEST_KEY,
  // BFL has no chat adapter to test here; the key still has to be mapped.
  bfl: TEST_KEY,
};

for (const kind of ['deepseek', 'openai', 'gemini', 'anthropic', 'openai-compatible'] as const) {
  describe(`${kind} credential handling`, () => {
    const adapter = registry.get(kind);
    const key = KEY_FOR[kind];
    const runtime = createRuntime({ apiKey: key, baseUrl: 'https://api.example.test/v1' });

    const specs: HttpRequestSpec[] = [
      adapter.buildChatRequest(runtime, createRequest()),
      adapter.buildChatRequest(runtime, createRequest({ stream: false })),
      adapter.buildTestRequest(runtime),
    ];
    const discovery = adapter.buildListModelsRequest(runtime);
    if (discovery) specs.push(discovery);

    it('never places the credential in a URL', () => {
      for (const spec of specs) {
        expect(spec.url, spec.url).not.toContain(key);
        expect(spec.url).not.toMatch(/[?&](key|api_key|apikey|token|access_token)=/i);
      }
    });

    it('places the credential in exactly one header', () => {
      for (const spec of specs) {
        const carriers = headersCarrying(spec, key);
        expect(carriers, `${spec.method} ${spec.url} carried ${JSON.stringify(carriers)}`).toHaveLength(1);
      }
    });

    it('never places the credential in a request body', () => {
      for (const spec of specs) {
        expect(spec.body ?? '').not.toContain(key);
      }
    });

    it('redacts the credential and the header dump from an error message', () => {
      const chatSpec = specs[0];
      if (!chatSpec) throw new Error('expected a chat request spec');
      const headerDump = JSON.stringify(chatSpec.headers);
      const echoed = JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${key}. The request sent ${headerDump}`,
        },
      });

      const shape = adapter.parseError(401, echoed, 'prov-test');

      expect(shape.code).toBe('invalid_key');
      expect(shape.message).not.toContain(key);
      expect(shape.message).not.toContain(headerDump);
      expect(shape.message).not.toContain(`Bearer ${key}`);
      expect(shape.message).toContain('REDACTED');
    });

    it('never echoes the header dump through a test-response error either', () => {
      const chatSpec = specs[0];
      if (!chatSpec) throw new Error('expected a chat request spec');
      const headerDump = JSON.stringify(chatSpec.headers);
      const echoed = JSON.stringify({
        error: { message: `denied. headers=${headerDump}` },
      });
      const result = adapter.parseTestResponse(401, echoed);
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(chatSpec.headers['Authorization'] ?? '__none__');
      expect(result.message).not.toContain(headerDump);
    });
  });
}
