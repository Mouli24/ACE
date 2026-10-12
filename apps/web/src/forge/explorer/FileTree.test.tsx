import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery, server } from '../../test/app';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { useExplorerStore } from './explorer-store';
import { ExplorerView } from './ExplorerView';
import { FileTree } from './FileTree';

installMockServer();

function seed() {
  const project = db.createProject({ name: 'Shop' });
  db.seedFiles(project.id, {
    'src/app.ts': 'export {};',
    'src/util/math.ts': '',
    'README.md': '# Shop',
    'node_modules/x/index.js': '',
  });
  db.setRepoStatus(project.id, {
    repo: true,
    branch: 'main',
    truncated: false,
    files: [{ path: 'src/app.ts', status: 'modified' }],
  });
  return project.id;
}

describe('FR-GIT-003 the Explorer tree', () => {
  it('lists the root with folders first, ignored folders dimmed', async () => {
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    const tree = await screen.findByRole('tree', { name: 'Files' });
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole('treeitem')
          .map((item) => item.textContent),
      ).toEqual(['node_modules', 'src', 'README.md']),
    );
    expect(screen.getByTestId('tree-item-node_modules')).toHaveClass('opacity-50');
  });

  it('expands a folder on click, showing its children one level deeper, with git marks (D299) as CSS glyphs (D334)', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await user.click(await screen.findByTestId('tree-item-src'));
    const app = await screen.findByTestId('tree-item-src/app.ts');
    expect(app).toHaveAttribute('aria-level', '2');
    expect(screen.getByTestId('tree-item-src')).toHaveAttribute('aria-expanded', 'true');
    // the repo says src/app.ts is modified: an M, drawn as CSS content so a row's text stays its name
    expect(app).toHaveTextContent(/^app\.ts$/);
    expect(within(app).getByTitle('Modified')).toHaveAttribute('data-glyph', 'M');
    expect(screen.getByTestId('tree-item-src')).toHaveTextContent(/^src$/);
  });

  it('opens a file as a preview on click, and pinned on double click or Enter', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={onOpen} />);
    await user.click(await screen.findByTestId('tree-item-README.md'));
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: true });
    await user.dblClick(screen.getByTestId('tree-item-README.md'));
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: false });
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith('README.md', { preview: false });
  });

  it('moves with the arrow keys: down, right into a folder, left back out', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    // focus, not click: a click on a folder also opens it
    const first = await screen.findByTestId('tree-item-node_modules');
    act(() => first.focus());
    // nothing selected: the focused first row is the current row, so one ArrowDown reaches the second
    await user.keyboard('{ArrowDown}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src');
    await user.keyboard('{ArrowRight}');
    await screen.findByTestId('tree-item-src/app.ts');
    await user.keyboard('{ArrowRight}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src/util');
    await user.keyboard('{ArrowLeft}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('tree-item-src')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps exactly one tab stop when the selected row is hidden, and keys start from it', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await user.click(await screen.findByTestId('tree-item-src'));
    await user.click(await screen.findByTestId('tree-item-src/app.ts'));
    act(() => useExplorerStore.getState().collapse(projectId, 'src'));
    await waitFor(() => expect(screen.queryByTestId('tree-item-src/app.ts')).toBeNull());
    const stops = screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0);
    expect(stops.map((item) => item.textContent)).toEqual(['node_modules']);
    act(() => stops[0]!.focus());
    await user.keyboard('{ArrowDown}');
    expect(useExplorerStore.getState().projects[projectId]?.selected).toBe('src');
  });

  it('says so when the folder cannot be read', async () => {
    renderWithQuery(
      <FileTree projectId="01J9ZZZZZZZZZZZZZZZZZZZZZZ" label="Files" onOpen={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t read the project folder/i);
  });
});

describe('D334 the theme’s Explorer rows', () => {
  const writer = { nodeId: 'n1', name: 'Writer', letter: 'W', color: '#7a62d6', index: 1 };

  it('marks the open file, dots an unsaved one, and badges a file an agent is writing', async () => {
    const projectId = seed();
    act(() => {
      openFile(projectId, 'README.md');
      useEditorStore.getState().setDirty(projectId, 'README.md', true);
    });
    renderWithQuery(
      <FileTree
        projectId={projectId}
        label="Files"
        onOpen={vi.fn()}
        live={new Map([['README.md', writer]])}
      />,
    );
    const readme = await screen.findByTestId('tree-item-README.md');
    expect(readme).toHaveClass('bg-[var(--hover)]', 'font-semibold');
    expect(screen.getByTestId('tree-item-src')).not.toHaveClass('bg-[var(--hover)]');
    expect(screen.getByTestId('tree-dirty-README.md')).toBeInTheDocument();
    const badge = screen.getByTestId('tree-agent-README.md');
    expect(badge).toHaveAttribute('title', 'Writer is editing');
    expect(badge).toHaveAttribute('data-glyph', 'W');
    expect(badge.style.animation).toBe('livePulse 2s ease-in-out infinite');
    // the letter and the caret are CSS content: a row's text stays its name
    expect(readme.textContent).toBe('README.md');
    expect(screen.getByTestId('tree-item-src')).toHaveTextContent(/^src$/);
  });

  it('has no badge on a file no running agent is writing', async () => {
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await screen.findByTestId('tree-item-README.md');
    expect(screen.queryByTestId('tree-agent-README.md')).toBeNull();
  });
});

describe('D334 the Explorer’s header and filter', () => {
  it('counts the project’s files, and says nothing while the list loads', async () => {
    const projectId = seed();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    expect(screen.getByText('EXPLORER')).toBeInTheDocument();
    expect(screen.queryByTestId('explorer-count')).toBeNull();
    // node_modules is ignored, so it is not listed
    expect(await screen.findByTestId('explorer-count')).toHaveTextContent('3 files');
  });

  it('says n+ when the engine cut the list short', async () => {
    const projectId = seed();
    server.use(
      http.get('*/api/v1/projects/:id/files/list', () =>
        HttpResponse.json({ files: ['a.ts', 'b.ts'], truncated: true }),
      ),
    );
    renderWithQuery(<ExplorerView projectId={projectId} />);
    expect(await screen.findByTestId('explorer-count')).toHaveTextContent('2+ files');
  });

  it('filters the file list by a case-insensitive substring, flat, each by its full path', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const tree = await screen.findByRole('tree', { name: 'Files of Shop' });
    await screen.findByTestId('explorer-count');

    await user.type(screen.getByRole('textbox', { name: 'Filter files' }), 'MATH');
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole('treeitem')
          .map((item) => item.textContent),
      ).toEqual(['src/util/math.ts']),
    );
    const row = screen.getByTestId('tree-item-src/util/math.ts');
    expect(row).toHaveAttribute('aria-level', '1');
    expect(row).toHaveStyle({ paddingLeft: '8px' });

    await user.click(row);
    expect(useEditorStore.getState().projects[projectId]?.active).toBe('src/util/math.ts');

    await user.clear(screen.getByRole('textbox', { name: 'Filter files' }));
    await user.type(screen.getByRole('textbox', { name: 'Filter files' }), 'nothing-like-it');
    expect(await screen.findByText('No files match.')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Filter files' }));
    expect(await screen.findByTestId('tree-item-src')).toBeInTheDocument();
  });
});
