import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/types';
import { AgentsPage } from '@renderer/pages/agents/AgentsPage';
import { useShellStore } from '@renderer/lib/store';
import { makeAgent, makeConversation, makeModel } from '../helpers/fake-api';
import { resetStores } from '../helpers/state';
import {
  bridgeError,
  installApi,
  makeProvider,
  never,
  renderPage,
  withinDialog,
} from './support';

const AGENT = makeAgent({
  id: 'agent-1',
  name: 'Writing partner',
  description: 'A terse editor.',
  providerId: 'provider-1',
  modelId: 'deepseek-chat',
  systemPrompt: 'You are a terse editor.',
  params: { temperature: 0.4 },
});

function openAgents(overrides: { agents?: Agent[] } = {}) {
  const fake = installApi({
    agents: overrides.agents ?? [AGENT],
    providers: [makeProvider()],
    models: [makeModel()],
  });
  const harness = renderPage(fake, <AgentsPage />);
  return { fake, user: harness.user };
}

beforeEach(() => {
  resetStores();
});

describe('Agents page', () => {
  it('renders a loading state while the agents are fetched', async () => {
    const fake = installApi();
    fake.api.agents.list = () => never<Agent[]>();

    renderPage(fake, <AgentsPage />);

    expect(await screen.findByRole('status', { name: 'Loading agents' })).toBeInTheDocument();
  });

  it('renders a load error with a retry that re-reads the list', async () => {
    const fake = installApi({ agents: [AGENT] });
    const original = fake.api.agents.list;
    let calls = 0;
    fake.api.agents.list = async () => {
      calls += 1;
      if (calls === 1) throw bridgeError('storage', 'The database file is locked.');
      return original();
    };

    const { user } = renderPage(fake, <AgentsPage />);

    expect(await screen.findByText('Agents could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database file is locked.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByLabelText('Name')).toHaveValue('Writing partner');
  });

  it('renders the empty state when nothing has been saved', async () => {
    const fake = installApi();
    renderPage(fake, <AgentsPage />);

    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(screen.getByText('Agents you save appear here.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New agent' }).length).toBeGreaterThan(0);
  });

  it('opens the first agent and gates parameters the model does not document', async () => {
    openAgents();

    expect(await screen.findByLabelText('Name')).toHaveValue('Writing partner');
    expect(screen.getByLabelText('System prompt')).toHaveValue('You are a terse editor.');
    expect(screen.getByLabelText('Temperature')).toBeEnabled();
    expect(screen.getByLabelText('Max output tokens')).toBeEnabled();
    expect(screen.getByLabelText('Top-k')).toBeDisabled();
    expect(
      screen.getAllByText(/The selected model does not document this parameter/).length,
    ).toBeGreaterThan(0);
  });

  it('duplicates an agent into a second row with its own id', async () => {
    const { fake, user } = openAgents();
    fake.api.agents.duplicate = vi.fn(async () =>
      makeAgent({ id: 'agent-2', name: 'Writing partner (copy)' }),
    );
    fake.api.conversations.create = vi.fn(async (input) =>
      makeConversation({ id: 'conv-copy', agentId: input.agentId ?? null }),
    );

    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(fake.api.agents.duplicate).toHaveBeenCalledWith('agent-1'));

    const list = screen.getByRole('list', { name: 'Saved agents' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByText('Writing partner (copy)')).toBeInTheDocument();

    /* The draft follows the copy, so the next chat uses the copy's own id. */
    await user.click(screen.getByRole('button', { name: 'New chat with this agent' }));
    await waitFor(() =>
      expect(fake.api.conversations.create).toHaveBeenCalledWith({ agentId: 'agent-2' }),
    );
  });

  it('asks before deleting and names the agent it will remove', async () => {
    const { fake, user } = openAgents();
    fake.api.agents.remove = vi.fn(async () => undefined);

    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'Delete agent' }));

    const confirm = withinDialog('Delete this agent?');
    expect(confirm.getByText(/“Writing partner” will be removed/)).toBeInTheDocument();

    await user.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(fake.api.agents.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete agent' }));
    await user.click(withinDialog('Delete this agent?').getByRole('button', { name: 'Delete agent' }));

    await waitFor(() => expect(fake.api.agents.remove).toHaveBeenCalledWith('agent-1'));
  });

  it('starts a chat with the saved agent and navigates to it', async () => {
    const { fake, user } = openAgents();
    fake.api.conversations.create = vi.fn(async (input) =>
      makeConversation({ id: 'conv-42', agentId: input.agentId ?? null }),
    );

    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'New chat with this agent' }));

    await waitFor(() =>
      expect(fake.api.conversations.create).toHaveBeenCalledWith({ agentId: 'agent-1' }),
    );
    await waitFor(() => expect(useShellStore.getState().route.conversationId).toBe('conv-42'));
    expect(window.location.hash).toBe('#/chat/conv-42');
  });

  it('saves an edited agent through the bridge', async () => {
    const { fake, user } = openAgents();
    fake.api.agents.update = vi.fn(async (id, input) =>
      makeAgent({ id, name: input.name, systemPrompt: input.systemPrompt }),
    );

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Sharp editor');
    await user.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() =>
      expect(fake.api.agents.update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ name: 'Sharp editor', providerId: 'provider-1' }),
      ),
    );
  });

  it('creates a new agent from the empty draft', async () => {
    const { fake, user } = openAgents();
    fake.api.agents.create = vi.fn(async (input) =>
      makeAgent({ id: 'agent-new', name: input.name, systemPrompt: input.systemPrompt }),
    );

    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'New agent' }));

    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('');
    await user.type(name, 'Research assistant');
    await user.type(screen.getByLabelText('System prompt'), 'Find primary sources.');
    await user.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() =>
      expect(fake.api.agents.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Research assistant' }),
      ),
    );
  });

  it('refuses to save an agent without a name', async () => {
    const { fake, user } = openAgents();
    fake.api.agents.update = vi.fn(async (id, input) => makeAgent({ id, name: input.name }));

    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('button', { name: 'Save agent' }));

    expect(await screen.findByText('An agent needs a name.')).toBeInTheDocument();
    expect(fake.api.agents.create).not.toHaveBeenCalled();
    expect(fake.api.agents.update).not.toHaveBeenCalled();
  });
});
