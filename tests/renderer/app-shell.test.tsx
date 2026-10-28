import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@renderer/App';
import { PlaceholderPage } from '@renderer/components/layout/PlaceholderPage';
import { __setApiForTest } from '@renderer/lib/api';
import { resetStores } from './helpers/state';
import { createFakeApi, makeConversation, type FakeApi } from './helpers/fake-api';

beforeEach(() => {
  resetStores();
});

function setup(): FakeApi {
  const fake = createFakeApi({ conversations: [] });
  __setApiForTest(fake.api);
  return fake;
}

describe('App shell', () => {
  it('renders the five navigation entries and marks the active route', () => {
    setup();
    render(<App />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Chat', 'Agents', 'Models & Providers', 'Settings', 'Cloud Sync']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('navigates, updates the document title and focuses the page heading', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: 'Settings' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.title).toBe('Settings · Personal AI Desk');
    expect(window.location.hash).toBe('#/settings');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('routes to every navigation entry and moves focus to its heading', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);

    for (const label of ['Agents', 'Models & Providers', 'Cloud Sync', 'Chat']) {
      await user.click(screen.getByRole('link', { name: label }));
      const heading = await screen.findByRole('heading', { level: 1, name: label });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(document.title).toBe(`${label} · Personal AI Desk`);
    }
  });

  it('renders the explicit placeholder body for a screen that is not built yet', () => {
    render(<PlaceholderPage routeName="agents" planned={['Create an agent']} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByText('Not built yet')).toBeInTheDocument();
    expect(screen.getByText('This screen is a placeholder')).toBeInTheDocument();
    expect(screen.getByText('Create an agent')).toBeInTheDocument();
  });

  it('opens the route named in the initial hash', async () => {
    setup();
    window.location.hash = '#/models';
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Models & Providers' }),
    ).toBeInTheDocument();
  });

  it('applies the dark theme and releases the stream subscription on unmount', async () => {
    const fake = setup();
    const { unmount } = render(<App />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    await waitFor(() => expect(fake.listenerCount()).toBe(1));

    unmount();
    expect(fake.listenerCount()).toBe(0);
  });

  it('renders the chat route with its conversation history', async () => {
    const fake = createFakeApi({
      conversations: [makeConversation({ id: 'c1', title: 'Plan the week' })],
    });
    __setApiForTest(fake.api);

    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Plan the week' }),
    ).toBeInTheDocument();
  });

  it('shows a bridge failure instead of an empty window when preload is missing', async () => {
    __setApiForTest(null);
    // Simulate a renderer started without the preload bridge.
    Object.defineProperty(window, 'api', { configurable: true, value: undefined });
    render(<App />);

    expect(await screen.findByText('The desktop bridge did not load')).toBeInTheDocument();
    delete (window as { api?: unknown }).api;
  });
});
