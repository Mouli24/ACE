import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, renderApp, renderWithQuery, server } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { ExplorerView } from '../explorer/ExplorerView';
import { useSideViewStore } from '../explorer/side-view-store';
import { SearchView } from './SearchView';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, {
    'src/app.ts': 'export const needle = 1;\nconst Needle = needle + 1;\n',
    'src/deep/b.tsx': 'needles();',
    'README.md': '# about the needle',
    'node_modules/x/i.js': 'needle',
  });
});

/** Every POST /files/search the view sent, as its body. */
function searchesSent(): unknown[] {
  const sent: unknown[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && request.url.endsWith('/files/search')) {
      void request
        .clone()
        .json()
        .then((body: unknown) => sent.push(body));
    }
  });
  return sent;
}

const query = () => screen.getByRole('textbox', { name: 'Search' });

describe('D299 Phase 4 the Explorer header switches EXPLORER · SEARCH', () => {
  it('shows the switch in the theme’s pill, Explorer first; Search swaps the tree for the search', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const switcher = await screen.findByRole('tablist', { name: 'Side bar views' });
    expect(
      within(switcher)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['EXPLORER', 'SEARCH']);
    expect(switcher).toHaveClass('rounded-full', 'bg-[var(--soft)]');
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();

    await user.click(within(switcher).getByRole('tab', { name: 'SEARCH' }));
    expect(useSideViewStore.getState().view).toBe('search');
    expect(query()).toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: 'Files of Shop' })).toBeNull();
    expect(screen.queryByTestId('explorer-count')).toBeNull();

    await user.click(within(switcher).getByRole('tab', { name: 'EXPLORER' }));
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();
  });
});

describe('D299 Phase 4 Search', () => {
  it('waits 300 ms after typing, then lists the results by file with counts and highlights', async () => {
    const user = userEvent.setup();
    const sent = searchesSent();
    renderWithQuery(<SearchView projectId={projectId} />);
    await user.type(query(), 'needle');
    expect(await screen.findByText('5 results in 3 files')).toBeInTheDocument();
    // one request for the whole word typed, not one per key
    expect(sent).toEqual([{ query: 'needle' }]);

    const app = screen.getByRole('region', { name: 'src/app.ts' });
    expect(within(app).getByTestId('search-file-count')).toHaveTextContent('3');
    const rows = within(app).getAllByRole('button', { name: /^Line \d+/ });
    expect(rows).toHaveLength(3);
    const marks = rows.map((row) => row.querySelector('mark')?.textContent);
    expect(marks).toEqual(['needle', 'Needle', 'needle']);
    expect(rows[1]).toHaveTextContent('const Needle = needle + 1;');
    // node_modules is never searched
    expect(screen.queryByRole('region', { name: 'node_modules/x/i.js' })).toBeNull();
  });

  it('narrows with match case, whole word, regex and the include and exclude globs', async () => {
    const user = userEvent.setup();
    renderWithQuery(<SearchView projectId={projectId} />);
    await user.type(query(), 'needle');
    await screen.findByText('5 results in 3 files');

    const matchCase = screen.getByRole('button', { name: 'Match case' });
    await user.click(matchCase);
    expect(matchCase).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('4 results in 3 files')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Match whole word' }));
    expect(await screen.findByText('3 results in 2 files')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Files to exclude' }), '*.md');
    expect(await screen.findByText('2 results in 1 file')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Files to include' }), 'deep');
    expect(await screen.findByText('No results')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Files to include' }));
    await user.clear(screen.getByRole('textbox', { name: 'Files to exclude' }));
    await user.click(screen.getByRole('button', { name: 'Match whole word' }));
    await user.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await user.clear(query());
    await user.type(query(), 'needle[[s(]');
    expect(await screen.findByText('1 result in 1 file')).toBeInTheDocument();
  });

  it('says why a regex cannot run, inline, and sends nothing', async () => {
    const user = userEvent.setup();
    const sent = searchesSent();
    renderWithQuery(<SearchView projectId={projectId} />);
    await user.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await user.type(query(), '(a+)+');
    expect(await screen.findByRole('alert')).toHaveTextContent(/too long/);
    expect(query()).toHaveAttribute('aria-invalid', 'true');
    await new Promise((settle) => setTimeout(settle, 400));
    expect(sent).toEqual([]);
  });

  it('opens a match’s file at its line and column', async () => {
    const user = userEvent.setup();
    renderWithQuery(<SearchView projectId={projectId} />);
    await user.type(query(), 'Needle');
    await screen.findByText('5 results in 3 files');
    const app = screen.getByRole('region', { name: 'src/app.ts' });
    await user.click(within(app).getByRole('button', { name: /^Line 2, column 7/ }));
    const editor = useEditorStore.getState().projects[projectId];
    expect(editor?.tabs).toContain('src/app.ts');
    expect(editor?.active).toBe('src/app.ts');
    expect(editor?.reveal).toEqual({ path: 'src/app.ts', line: 2, column: 7 });
  });

  it('says it shows only the first 2,000 when the engine cut the results short', async () => {
    const user = userEvent.setup();
    db.seedFiles(projectId, { 'many.txt': 'x\n'.repeat(2_001) });
    renderWithQuery(<SearchView projectId={projectId} />);
    await user.type(query(), 'x');
    expect(await screen.findByText(/showing the first 2,000/)).toBeInTheDocument();
  });
});

describe('D299 Phase 4 Ctrl/⌘+Shift+F', () => {
  it('opens Search with the focus in its query, even with the side bar hidden', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Forge' });
    const workflow = db.createWorkflow(project.id, 'Main');
    db.seedFiles(project.id, { 'a.ts': 'export {};' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByRole('tree', { name: 'Files of Forge' });

    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Explorer' })).toBeNull();
    await user.keyboard('{Control>}{Shift>}f{/Shift}{/Control}');
    await waitFor(() => expect(query()).toHaveFocus());
    expect(useSideViewStore.getState().view).toBe('search');
  });
});
