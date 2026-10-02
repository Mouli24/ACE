import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installMockServer, renderApp } from '../test/app';
import { GUIDE_PAGES, GUIDE_SLUGS, prepareGuideMarkdown } from './guide';

installMockServer();

const REQUIRED = [
  'getting-started',
  'providers',
  'building-a-workflow',
  'guardrails',
  'knowledge-bases',
  'tools',
  'troubleshooting',
];

describe('FR-ONB-003 the bundled user guide', () => {
  it('bundles every page R5 §5 item 6 names', () => {
    expect(GUIDE_SLUGS).toEqual(expect.arrayContaining(REQUIRED));
    for (const page of GUIDE_PAGES) expect(page.markdown.length).toBeGreaterThan(200);
  });

  it('every link from one guide page to another resolves', () => {
    for (const page of GUIDE_PAGES) {
      for (const [, target] of page.markdown.matchAll(/\]\(([^)]+)\.md\)/g)) {
        expect(GUIDE_SLUGS, `${page.slug} → ${target}`).toContain(target);
      }
    }
  });

  it('every /help link in the app points at a page that exists', () => {
    const sources = import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const targets = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const [, slug] of text.matchAll(/["'`]\/help\/([a-z0-9-]+)["'`]/g)) targets.add(slug!);
      for (const [, slug] of text.matchAll(/<HelpLink page="([a-z0-9-]+)"/g)) targets.add(slug!);
    }
    expect(targets.size).toBeGreaterThan(0);
    for (const slug of targets) expect(GUIDE_SLUGS).toContain(slug);
  });

  it('renders a page with the index beside it', async () => {
    renderApp('/help/getting-started');
    const article = await screen.findByTestId('help-article');
    expect(within(article).getByRole('heading', { level: 1 })).toHaveTextContent('Getting started');
    const index = screen.getByRole('navigation', { name: 'User guide' });
    expect(within(index).getAllByRole('link')).toHaveLength(GUIDE_PAGES.length);
    expect(within(index).getByRole('link', { name: 'Getting started' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens a link to another guide page in the app', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/help/getting-started');
    const article = await screen.findByTestId('help-article');
    await user.click(within(article).getAllByRole('link', { name: 'Providers' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/help/providers'));
    expect(screen.getByTestId('help-article')).toHaveAttribute('data-page', 'providers');
  });

  it('says so for a page that does not exist', async () => {
    renderApp('/help/nope');
    const missing = await screen.findByTestId('help-not-found');
    expect(missing).toHaveTextContent('nope');
    expect(within(missing).getByRole('link', { name: 'Getting started' })).toHaveAttribute(
      'href',
      '/help/getting-started',
    );
  });
});

describe('prepareGuideMarkdown', () => {
  it('joins hard-wrapped paragraphs and list items, keeps code and headings', () => {
    const out = prepareGuideMarkdown(
      '# Title\n\nOne\ntwo.\n\n1. Item\n   more.\n2. Next\n\n```sh\na\nb\n```\n',
      'http://x',
    );
    expect(out).toBe('# Title\n\nOne two.\n\n1. Item more.\n2. Next\n\n```sh\na\nb\n```\n');
  });

  it('rewrites sibling .md links to /help on this origin', () => {
    expect(prepareGuideMarkdown('See [Tools](tools.md#mcp).', 'http://x')).toBe(
      'See [Tools](http://x/help/tools#mcp).',
    );
  });
});
