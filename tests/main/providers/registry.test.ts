import { describe, expect, it } from 'vitest';
import { PROVIDER_ORDER, PROVIDER_PRESETS } from '@shared/defaults';
import type { ProviderKind } from '@shared/types';
import { AppError } from '@shared/errors';
import { createRegistry } from '@main/providers/registry';

const registry = createRegistry();

describe('createRegistry', () => {
  it('returns all five adapters in provider order', () => {
    const adapters = registry.all();
    expect(adapters).toHaveLength(5);
    expect(adapters.map((adapter) => adapter.kind)).toEqual([...PROVIDER_ORDER]);
  });

  it('matches each preset label, discovery flag and parameter list', () => {
    for (const adapter of registry.all()) {
      const preset = PROVIDER_PRESETS[adapter.kind];
      expect(adapter.label).toBe(preset.label);
      expect([...adapter.supportedParams]).toEqual(preset.supportedParams);
      expect(adapter.supportsModelDiscovery).toBe(preset.supportsModelDiscovery);
    }
  });

  it('exposes a discovery request for every adapter', () => {
    for (const adapter of registry.all()) {
      const request = adapter.buildListModelsRequest({
        providerId: 'p',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test-KEY-0123456789abcdef',
        timeoutMs: 5_000,
      });
      expect(request, adapter.kind).not.toBeNull();
      expect(request?.method, adapter.kind).toBe('GET');
    }
  });

  it('returns the same adapter instance that all() lists', () => {
    for (const adapter of registry.all()) {
      expect(registry.get(adapter.kind)).toBe(adapter);
    }
  });

  it('rejects an unknown provider kind with a typed error', () => {
    const bogus = 'not-a-provider' as ProviderKind;
    let caught: unknown;
    try {
      registry.get(bogus);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ shape: { code: 'not_found' } });
  });
});
