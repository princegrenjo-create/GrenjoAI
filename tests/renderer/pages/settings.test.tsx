import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCapabilities } from '@shared/capabilities';
import { DEFAULT_SETTINGS, PARAM_SPECS } from '@shared/defaults';
import type { AppSettings, GenParamKey } from '@shared/types';
import { useSettingsStore } from '@renderer/lib/store';
import { SettingsPage } from '@renderer/pages/settings/SettingsPage';
import { makeAgent, makeModel } from '../helpers/fake-api';
import { resetStores } from '../helpers/state';
import {
  bridgeError,
  installApi,
  makeAppInfo,
  makePaths,
  renderPage,
} from './support';

function openSettings(settings?: AppSettings) {
  const fake = installApi(settings ? { settings } : {});
  fake.api.app.info = vi.fn(async () => makeAppInfo());
  fake.api.app.paths = vi.fn(async () => makePaths());
  const harness = renderPage(fake, <SettingsPage />);
  return { fake, user: harness.user };
}

beforeEach(() => {
  resetStores();
});

describe('Settings page', () => {
  it('offers only text models as the default for a new conversation', async () => {
    const fake = installApi({
      models: [
        makeModel({ id: 'm-chat', modelId: 'chat-model', displayName: 'Chat model' }),
        makeModel({
          id: 'm-image',
          modelId: 'image-model',
          displayName: 'Image model',
          capabilities: { ...makeCapabilities({ imageOutput: true }), chat: false },
        }),
        makeModel({
          id: 'm-unknown',
          modelId: 'unclassified-model',
          displayName: 'Unclassified model',
          capabilities: makeCapabilities(),
        }),
      ],
    });
    fake.api.app.info = vi.fn(async () => makeAppInfo());
    fake.api.app.paths = vi.fn(async () => makePaths());
    const harness = renderPage(fake, <SettingsPage />);

    const trigger = await screen.findByRole('combobox', { name: 'Default model' });
    await harness.user.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: 'Default model' });

    // The default model starts every new conversation, so an image-only or
    // undeclared model here would be selectable and then unable to answer.
    expect(within(listbox).getByRole('option', { name: /Chat model/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /Image model/ })).toBeNull();
    expect(within(listbox).queryByRole('option', { name: /Unclassified model/ })).toBeNull();
  });

  it('renders a loading state until the settings document is read', async () => {
    const fake = installApi();
    fake.api.settings.get = () => new Promise<AppSettings>(() => undefined);
    fake.api.app.info = vi.fn(async () => makeAppInfo());
    fake.api.app.paths = vi.fn(async () => makePaths());

    renderPage(fake, <SettingsPage />);

    expect(await screen.findByRole('status', { name: 'Loading settings' })).toBeInTheDocument();
  });

  it('renders a load error with a retry that re-reads the document', async () => {
    const fake = installApi();
    const original = fake.api.settings.get;
    let calls = 0;
    fake.api.settings.get = async () => {
      calls += 1;
      if (calls === 1) throw bridgeError('storage', 'The settings table is unreadable.');
      return original();
    };
    fake.api.app.info = vi.fn(async () => makeAppInfo());
    fake.api.app.paths = vi.fn(async () => makePaths());

    const { user } = renderPage(fake, <SettingsPage />);

    expect(await screen.findByText('Settings could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The settings table is unreadable.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByLabelText('Theme')).toBeInTheDocument();
  });

  it('renders one control for every declared generation parameter', async () => {
    openSettings();
    await screen.findByLabelText('Theme');

    for (const key of Object.keys(PARAM_SPECS) as GenParamKey[]) {
      const spec = PARAM_SPECS[key];
      if (spec.control === 'select') {
        expect(screen.getByRole('combobox', { name: spec.label })).toBeInTheDocument();
      } else {
        expect(screen.getByLabelText(spec.label)).toBeInTheDocument();
      }
    }
  });

  it('rejects an out-of-range value with the range in the message and does not save it', async () => {
    const { fake, user } = openSettings();
    await screen.findByLabelText('Theme');

    const timeout = screen.getByLabelText('Request timeout');
    await user.clear(timeout);
    await user.type(timeout, '999');

    expect(await screen.findByText('Request timeout must be at least 1000')).toBeInTheDocument();
    await user.tab();
    expect(fake.api.settings.patch).not.toHaveBeenCalled();

    const output = screen.getByLabelText('Max output tokens');
    await user.clear(output);
    await user.type(output, '0');
    expect(await screen.findByText('Max output tokens must be at least 1')).toBeInTheDocument();
  });

  it('stores a valid numeric change once editing ends', async () => {
    const { fake, user } = openSettings();
    await screen.findByLabelText('Theme');

    const timeout = screen.getByLabelText('Request timeout');
    await user.clear(timeout);
    await user.type(timeout, '45000');
    await user.tab();

    await waitFor(() =>
      expect(fake.api.settings.patch).toHaveBeenCalledWith({ generation: { requestTimeoutMs: 45000 } }),
    );
    expect(useSettingsStore.getState().settings.generation.requestTimeoutMs).toBe(45000);
  });

  it('resets one advanced row to its documented default', async () => {
    const customized: AppSettings = {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, logLevel: 'debug' },
    };
    const { fake, user } = openSettings(customized);
    await screen.findByLabelText('Theme');

    expect(screen.getByRole('combobox', { name: 'Log level' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Reset Log level to the default' }));

    await waitFor(() =>
      expect(fake.api.settings.patch).toHaveBeenCalledWith({ advanced: { logLevel: 'info' } }),
    );
    await waitFor(() =>
      expect(useSettingsStore.getState().settings.advanced.logLevel).toBe('info'),
    );
  });

  it('describes the advanced table with a type, a range and a default per row', async () => {
    openSettings();
    await screen.findByLabelText('Theme');

    expect(screen.getByRole('table')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Stream idle timeout/ });
    expect(within(row).getByText('Number')).toBeInTheDocument();
    expect(within(row).getByText('5,000 – 600,000 ms')).toBeInTheDocument();
    expect(within(row).getByText('60,000')).toBeInTheDocument();
  });

  it('shows the export as a read-only document that records credentials as excluded', async () => {
    const { fake, user } = openSettings();
    fake.api.settings.exportConfig = vi.fn(async () => ({
      app: 'personal-ai-desk' as const,
      exportedAt: '2026-10-29T00:00:00.000Z',
      settings: DEFAULT_SETTINGS,
      providers: [],
      agents: [],
      customModels: [],
      credentials: 'excluded' as const,
    }));

    await screen.findByLabelText('Theme');
    await user.click(screen.getByRole('button', { name: 'Export configuration' }));

    const field = await screen.findByLabelText('Configuration export (JSON)');
    expect(field).toHaveAttribute('readonly');
    expect((field as HTMLTextAreaElement).value).toContain('"credentials": "excluded"');
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeInTheDocument();
  });

  it('renders the warnings an import of a tampered document returns', async () => {
    const { fake, user } = openSettings();
    fake.api.settings.importConfig = vi.fn(async () => ({
      applied: ['settings'],
      skipped: ['apiKey'],
      warnings: ['Ignored "apiKey": credentials are never imported from a file.'],
    }));

    await screen.findByLabelText('Theme');
    const pasted = '{"app":"personal-ai-desk","apiKey":"sk-should-not-be-here"}';
    fireEvent.change(screen.getByLabelText('Import a configuration'), {
      target: { value: pasted },
    });
    await user.click(screen.getByRole('button', { name: 'Import configuration' }));

    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(
      screen.getByText('Ignored "apiKey": credentials are never imported from a file.'),
    ).toBeInTheDocument();
    expect(fake.api.settings.importConfig).toHaveBeenCalledWith(pasted);
  });

  it('states that creativity bias is an application-level bias, not a model parameter', async () => {
    openSettings();
    await screen.findByLabelText('Theme');

    expect(screen.getByText(/Creativity bias is an/)).toBeInTheDocument();
    expect(screen.getByText(/not a model parameter/)).toBeInTheDocument();
    expect(screen.getByLabelText('Bias strength')).toBeDisabled();
  });

  it('keeps every section that does not depend on a failed supporting read', async () => {
    const fake = installApi();
    fake.api.app.info = vi.fn(async () => makeAppInfo());
    fake.api.app.paths = vi.fn(async () => makePaths());
    let agentCalls = 0;
    fake.api.agents.list = async () => {
      agentCalls += 1;
      if (agentCalls === 1) throw bridgeError('storage', 'The agents table is unreadable.');
      return [makeAgent({ id: 'agent-1', name: 'Writing partner' })];
    };

    const { user } = renderPage(fake, <SettingsPage />);

    /* The document loaded, so every section that only needs it is still there. */
    expect(await screen.findByLabelText('Theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Request timeout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Generation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Advanced configuration' })).toBeInTheDocument();
    expect(screen.getByText(makePaths().database)).toBeInTheDocument();
    expect(screen.getByText(makeAppInfo().electronVersion)).toBeInTheDocument();

    /* The failure is reported inside the section that needed the agents, only. */
    expect(screen.getByText('The agent list could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/The agents table is unreadable./)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Default agent' })).toBeNull();
    expect(screen.queryByText('Settings could not be loaded')).toBeNull();

    /* Retrying re-reads the agent list and restores just that control. */
    await user.click(screen.getByRole('button', { name: 'Retry loading agent list' }));
    await waitFor(() => expect(agentCalls).toBe(2));
    expect(await screen.findByRole('combobox', { name: 'Default agent' })).toBeInTheDocument();
    expect(screen.queryByText('The agent list could not be loaded')).toBeNull();
  });

  it('still renders generation and advanced when the data locations fail', async () => {
    const fake = installApi();
    fake.api.app.info = vi.fn(async () => makeAppInfo());
    fake.api.app.paths = vi.fn(async () => {
      throw bridgeError('storage', 'The path table is unreadable.');
    });

    renderPage(fake, <SettingsPage />);

    expect(await screen.findByLabelText('Theme')).toBeInTheDocument();
    expect(screen.getByLabelText('History token budget')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('The data locations could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/The path table is unreadable./)).toBeInTheDocument();
    /* Export does not depend on the paths, so it is still offered. */
    expect(screen.getByRole('button', { name: 'Export configuration' })).toBeInTheDocument();
  });

  it('guides the owner when no providers, models or agents exist yet', async () => {
    openSettings();
    await screen.findByLabelText('Theme');

    expect(
      screen.getByText('No providers yet. Add one under Models & Providers.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No agents yet. Create one on the Agents screen.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Default model' })).toBeDisabled();
  });

  it('lists the data locations and the build information', async () => {
    const paths = makePaths();
    const info = makeAppInfo();
    const fake = installApi();
    fake.api.app.info = vi.fn(async () => info);
    fake.api.app.paths = vi.fn(async () => paths);

    renderPage(fake, <SettingsPage />);

    expect(await screen.findByText(paths.database)).toBeInTheDocument();
    expect(screen.getByText(paths.logs)).toBeInTheDocument();
    expect(screen.getByText(info.electronVersion)).toBeInTheDocument();
    expect(screen.getByText(info.chromeVersion)).toBeInTheDocument();
    expect(screen.getByText(info.nodeVersion)).toBeInTheDocument();
    expect(screen.getByText('Development build')).toBeInTheDocument();
    expect(screen.getByText('Windows credential store available')).toBeInTheDocument();
  });
});
