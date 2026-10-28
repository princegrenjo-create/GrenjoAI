import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from '@renderer/components/markdown/Markdown';
import { __setApiForTest } from '@renderer/lib/api';
import { createFakeApi, type FakeApi } from './helpers/fake-api';
import { resetStores } from './helpers/state';
import { stubClipboard } from './helpers/clipboard';

let fake: FakeApi;

beforeEach(() => {
  resetStores();
  fake = createFakeApi();
  __setApiForTest(fake.api);
});

describe('Markdown rendering', () => {
  it('renders GFM structure: headings, lists and tables', () => {
    const content = [
      '## Plan',
      '',
      '1. First step',
      '2. Second step',
      '',
      '| Step | Owner |',
      '| --- | --- |',
      '| Plan | You |',
    ].join('\n');

    render(<Markdown content={content} />);

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('First step')).toBeInTheDocument();
  });

  it('never renders a javascript: URL as an anchor', () => {
    const { container } = render(<Markdown content={'[click me](javascript:alert(1))'} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.textContent).toContain('click me');
    expect(container.textContent).toContain('(link blocked)');
  });

  it('renders a plain-HTTP link as blocked text instead of an anchor', () => {
    const { container } = render(
      <Markdown content={'[insecure](http://example.com/page)'} />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.textContent).toContain('insecure');
    expect(container.textContent).toContain('(link blocked)');
  });

  it('opens an HTTPS link through the shared external-link policy', async () => {
    const user = userEvent.setup();
    render(<Markdown content={'Read [the docs](https://example.com/docs).'} />);

    const link = screen.getByRole('link', { name: /the docs/ });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');

    await user.click(link);
    expect(fake.api.app.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('does not execute raw HTML from model output', () => {
    const { container } = render(
      <Markdown content={'<div class="evil">hello</div>\n\n**Safe bold**'} />,
    );

    expect(container.querySelector('div.evil')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The markup survives only as inert text.
    expect(container.textContent).toContain('<div class="evil">hello</div>');
    expect(screen.getByText('Safe bold')).toBeInTheDocument();
  });

  it('renders a fenced code block with its language and copies the exact code', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<Markdown content={'```ts\nconst answer = 42;\n```'} />);

    expect(screen.getByText('ts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
  });

  it('blocks a remote image instead of issuing a network request', () => {
    const { container } = render(
      <Markdown content={'![diagram](https://example.com/diagram.png)'} />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('images are blocked');
  });
});
