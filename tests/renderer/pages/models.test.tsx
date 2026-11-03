import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_HINTS_AS_OF } from '@shared/defaults';
import { appError } from '@shared/errors';
import type { DiscoveredModel } from '@shared/provider-contract';
import type { ModelDescriptor, ProviderConfig } from '@shared/types';
import { ModelsPage } from '@renderer/pages/models/ModelsPage';
import { makeModel } from '../helpers/fake-api';
import { resetStores } from '../helpers/state';
import {
  bridgeError,
  installApi,
  makeProvider,
  never,
  renderPage,
  withinAlertDialog,
  withinDialog,
} from './support';

beforeEach(() => {
  resetStores();
});

describe('Models & Providers page', () => {
  it('renders a loading state while the catalogue is fetched', async () => {
    const fake = installApi();
    fake.api.providers.list = () => never<ProviderConfig[]>();
    fake.api.models.list = () => never<ModelDescriptor[]>();

    renderPage(fake, <ModelsPage />);

    expect(
      await screen.findByRole('status', { name: 'Loading providers and models' }),
    ).toBeInTheDocument();
  });

  it('renders a load error with a retry that re-reads the catalogue', async () => {
    const fake = installApi({ providers: [makeProvider()], models: [makeModel()] });
    const original = fake.api.providers.list;
    let calls = 0;
    fake.api.providers.list = async () => {
      calls += 1;
      if (calls === 1) throw bridgeError('storage', 'The database file is locked.');
      return original();
    };

    const { user } = renderPage(fake, <ModelsPage />);

    expect(await screen.findByText('Providers and models could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database file is locked.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(calls).toBe(2));
    expect((await screen.findAllByText('DeepSeek')).length).toBeGreaterThan(0);
  });

  it('renders the empty states, the hint banner and the custom-model section', async () => {
    const fake = installApi();

    renderPage(fake, <ModelsPage />);

    expect(await screen.findByText('No providers yet')).toBeInTheDocument();
    expect(screen.getByText('No models yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Others / Custom Models' })).toBeInTheDocument();
    expect(screen.getByText('No custom models yet. Add one when a provider serves a model that discovery cannot see, or when you need to pin down the endpoint and the parameters it honours.')).toBeInTheDocument();
    expect(screen.getByText(/The built-in model list is a/)).toBeInTheDocument();
    expect(screen.getByText(`hint list as of ${MODEL_HINTS_AS_OF}`)).toBeInTheDocument();
    expect(screen.getByText(/Discovery through the provider's own API is authoritative/)).toBeInTheDocument();
  });

  it('adds a provider with the typed values', async () => {
    const fake = installApi();
    fake.api.providers.upsert = vi.fn(async (input) =>
      makeProvider({
        id: 'provider-new',
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled ?? true,
      }),
    );

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No providers yet');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const form = withinDialog('Add a provider');
    const name = form.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Work DeepSeek');
    const baseUrl = form.getByLabelText('Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://api.example.com/v1');

    await user.click(form.getByRole('button', { name: 'Add provider' }));

    await waitFor(() =>
      expect(fake.api.providers.upsert).toHaveBeenCalledWith({
        kind: 'deepseek',
        name: 'Work DeepSeek',
        baseUrl: 'https://api.example.com/v1',
        enabled: true,
      }),
    );
    expect(await screen.findByText('Work DeepSeek')).toBeInTheDocument();
  });

  it('rejects a plain-HTTP non-loopback endpoint inline and does not save', async () => {
    const fake = installApi();
    fake.api.providers.upsert = vi.fn(async () => makeProvider());

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No providers yet');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const form = withinDialog('Add a provider');
    const baseUrl = form.getByLabelText('Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'http://example.com/v1');

    expect(
      await form.findByText(/Plain HTTP is only allowed for a loopback address/),
    ).toBeInTheDocument();

    await user.click(form.getByRole('button', { name: 'Add provider' }));
    expect(fake.api.providers.upsert).not.toHaveBeenCalled();
  });

  it('keeps the typed values when saving the provider fails', async () => {
    const fake = installApi();
    fake.api.providers.upsert = vi.fn(async () => {
      throw bridgeError('validation', 'A provider with that name already exists.');
    });

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('No providers yet');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const form = withinDialog('Add a provider');
    const name = form.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Duplicate desk');
    const baseUrl = form.getByLabelText('Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://api.example.com/v1');

    await user.click(form.getByRole('button', { name: 'Add provider' }));

    expect(
      await form.findByText('A provider with that name already exists.'),
    ).toBeInTheDocument();
    expect(form.getByLabelText('Name')).toHaveValue('Duplicate desk');
    expect(form.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1');
  });

  it('never pre-fills the key field and never renders the stored key', async () => {
    const fake = installApi({ providers: [makeProvider({ keyFingerprint: 'deadbeef' })] });

    const { user } = renderPage(fake, <ModelsPage />);

    expect(await screen.findByText('A key is stored (fingerprint deadbeef)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));

    const form = withinDialog('Replace the API key for DeepSeek');
    const key = form.getByLabelText('API key for DeepSeek');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('type', 'password');
    expect(document.body.textContent ?? '').not.toMatch(/sk-[A-Za-z0-9]{6,}/);
  });

  it('renders the mapped error and keeps the provider when a connection test fails', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    fake.api.providers.test = vi.fn(async () => ({
      ok: false,
      latencyMs: 12,
      message: 'The provider rejected the API key (HTTP 401)',
      modelsFound: null,
      error: appError('invalid_key', 'The provider rejected the API key (HTTP 401)', {
        status: 401,
        providerId: 'provider-1',
      }),
    }));

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('DeepSeek');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('The connection test failed')).toBeInTheDocument();
    expect(
      screen.getByText('The provider rejected the API key (HTTP 401)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Error code: invalid_key')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getAllByText('https://api.deepseek.com/v1').length).toBeGreaterThan(0);
  });

  it('renders latency and the models found when a connection test succeeds', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    fake.api.providers.test = vi.fn(async () => ({
      ok: true,
      latencyMs: 240,
      message: 'The provider answered.',
      modelsFound: 12,
      error: null,
    }));

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('DeepSeek');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/240 ms/)).toBeInTheDocument();
    expect(screen.getByText(/12 models found/)).toBeInTheDocument();
  });

  it('saves discovery results and reports the count', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    fake.api.providers.discoverModels = vi.fn(async (): Promise<DiscoveredModel[]> => [
      {
        modelId: 'discovered-1',
        displayName: 'Discovered one',
        description: 'Found through the provider.',
        capabilities: { chat: true, streaming: true, imageInput: false, toolCalling: false, imageOutput: false, imageEditing: false, videoInput: false, videoOutput: false, audioInput: false, audioOutput: false, embeddings: false },
        limits: { contextWindow: 32000 },
        supportedParams: ['temperature'],
        weirdnessSupported: false,
      },
    ]);
    fake.api.models.saveDiscovered = vi.fn(async () => []);

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('DeepSeek');
    await user.click(screen.getByRole('button', { name: 'Discover models' }));

    await waitFor(() =>
      expect(fake.api.models.saveDiscovered).toHaveBeenCalledWith('provider-1', [
        expect.objectContaining({ modelId: 'discovered-1' }),
      ]),
    );
    expect(await screen.findByText(/Discovered 1 model and saved them/)).toBeInTheDocument();
  });

  it('renders the discovery failure reason when enumeration is unsupported', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    fake.api.providers.discoverModels = vi.fn(async () => {
      throw bridgeError(
        'bad_request',
        'This endpoint does not expose a model-listing API. Add models manually under Others / Custom Models.',
      );
    });

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('DeepSeek');
    await user.click(screen.getByRole('button', { name: 'Discover models' }));

    expect(await screen.findByText('Model discovery failed')).toBeInTheDocument();
    expect(
      screen.getByText(/This endpoint does not expose a model-listing API/),
    ).toBeInTheDocument();
  });

  it('adds a custom model that appears under Others / Custom Models', async () => {
    const fake = installApi({ providers: [makeProvider()] });
    let catalogue: ModelDescriptor[] = [];
    fake.api.models.list = async () => catalogue;
    fake.api.models.upsert = vi.fn(async (input) => {
      const created = makeModel({
        id: 'custom:1',
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        source: 'custom',
        capabilities: input.capabilities,
        limits: input.limits ?? {},
        supportedParams: input.supportedParams ?? [],
        weirdnessSupported: input.weirdnessSupported ?? false,
        baseUrlOverride: input.baseUrlOverride ?? null,
        description: input.description ?? '',
      });
      catalogue = [created];
      return created;
    });

    const { user } = renderPage(fake, <ModelsPage />);
    await screen.findByText('DeepSeek');
    await user.click(screen.getByRole('button', { name: 'Add custom model' }));

    const form = withinDialog('Add a custom model');
    await user.type(form.getByLabelText('Display name'), 'My gateway model');
    await user.type(form.getByLabelText('Exact model id'), 'gw-1');
    await user.click(form.getByRole('button', { name: 'Add model' }));

    await waitFor(() =>
      expect(fake.api.models.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'provider-1',
          displayName: 'My gateway model',
          modelId: 'gw-1',
          capabilities: {
            chat: true,
            streaming: true,
            imageInput: false,
            toolCalling: false,
            imageOutput: false,
            imageEditing: false,
            videoInput: false,
            videoOutput: false,
            audioInput: false,
            audioOutput: false,
            embeddings: false,
          },
        }),
      ),
    );

    const heading = await screen.findByRole('heading', { name: 'Others / Custom Models' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(section?.textContent ?? '').toContain('My gateway model');
    expect(screen.queryByText(/No custom models yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete My gateway model' })).toBeInTheDocument();
  });

  it('asks before removing a provider and calls providers.remove only on the confirm', async () => {
    const fake = installApi({ providers: [makeProvider()], models: [makeModel()] });
    const remove = vi.fn(async () => undefined);
    fake.api.providers.remove = remove;

    const { user } = renderPage(fake, <ModelsPage />);
    await user.click(await screen.findByRole('button', { name: 'Remove DeepSeek' }));

    const confirm = withinAlertDialog('Remove this provider?');
    expect(confirm.getByText(/“DeepSeek” and its discovered models will be removed/)).toBeInTheDocument();
    expect(confirm.getByText(/API key will be deleted from the Windows credential store/)).toBeInTheDocument();
    expect(confirm.getByText(/This cannot be undone\./)).toBeInTheDocument();
    expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove DeepSeek' }));
    await user.click(
      withinAlertDialog('Remove this provider?').getByRole('button', { name: 'Remove provider' }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledWith('provider-1'));
  });

  it('asks before deleting a custom model and calls models.remove only on the confirm', async () => {
    const custom = makeModel({
      id: 'model-1',
      source: 'custom',
      displayName: 'My gateway model',
      modelId: 'gw-1',
    });
    const fake = installApi({ providers: [makeProvider()], models: [custom] });
    const remove = vi.fn(async () => undefined);
    fake.api.models.remove = remove;

    const { user } = renderPage(fake, <ModelsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete My gateway model' }));

    const confirm = withinAlertDialog('Delete this custom model?');
    expect(confirm.getByText(/“My gateway model” \(gw-1\) will be removed/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await user.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete My gateway model' }));
    await user.click(
      withinAlertDialog('Delete this custom model?').getByRole('button', { name: 'Delete model' }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledWith('model-1'));
  });

  it('keeps the delete prompt open with the reason when the delete fails', async () => {
    const custom = makeModel({
      id: 'model-1',
      source: 'custom',
      displayName: 'My gateway model',
      modelId: 'gw-1',
    });
    const fake = installApi({ providers: [makeProvider()], models: [custom] });
    fake.api.models.remove = vi.fn(async () => {
      throw bridgeError('storage', 'The database is locked.');
    });

    const { user } = renderPage(fake, <ModelsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete My gateway model' }));

    await user.click(
      withinAlertDialog('Delete this custom model?').getByRole('button', { name: 'Delete model' }),
    );

    const confirm = withinAlertDialog('Delete this custom model?');
    expect(await confirm.findByText('The model was not deleted')).toBeInTheDocument();
    expect(confirm.getByText('The database is locked.')).toBeInTheDocument();
    expect(confirm.getByRole('button', { name: 'Delete model' })).toBeEnabled();
  });
});
