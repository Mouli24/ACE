import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useExplorerStore } from './explorer-store';
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

  it('expands a folder on click, showing its children one level deeper, with decorations', async () => {
    const user = userEvent.setup();
    const projectId = seed();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await user.click(await screen.findByTestId('tree-item-src'));
    const app = await screen.findByTestId('tree-item-src/app.ts');
    expect(app).toHaveAttribute('aria-level', '2');
    expect(screen.getByTestId('tree-item-src')).toHaveAttribute('aria-expanded', 'true');
    expect(within(app).getByText('M')).toHaveAttribute('title', 'Modified');
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
    await user.keyboard('{ArrowDown}');
    expect(
      useExplorerStore.getState().projects[projectId]?.selected,
      'nothing selected yet: the first row',
    ).toBe('node_modules');
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

  it('says so when the folder cannot be read', async () => {
    renderWithQuery(
      <FileTree projectId="01J9ZZZZZZZZZZZZZZZZZZZZZZ" label="Files" onOpen={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t read the project folder/i);
  });
});
