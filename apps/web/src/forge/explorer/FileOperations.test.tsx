import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { ExplorerView } from './ExplorerView';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, {
    'src/app.ts': 'export {};',
    'notes.md': '# notes',
    'docs/readme.md': '',
  });
});

const tabs = () => useEditorStore.getState().projects[projectId]?.tabs ?? [];
const onDisk = () => Object.keys(db.filesOf(projectId)).sort();

describe('D299 FR-GIT-003 file operations in the Explorer', () => {
  it('creates a file inline from the header button and opens it', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    await user.type(screen.getByRole('textbox', { name: 'New file name' }), 'todo.md{Enter}');
    await waitFor(() => expect(onDisk()).toContain('todo.md'));
    expect(tabs()).toContain('todo.md');
  });

  it('refuses a bad name inline, without asking the engine', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    await user.type(screen.getByRole('textbox', { name: 'New file name' }), 'notes.md{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('“notes.md” already exists here.');
    expect(onDisk().filter((path) => path === 'notes.md')).toHaveLength(1);
  });

  it('renames with F2, and an open tab follows the file', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename notes.md' });
    await user.clear(input);
    await user.type(input, 'journal.md{Enter}');
    await waitFor(() => expect(onDisk()).toContain('journal.md'));
    expect(tabs()).toEqual(['journal.md']);
  });

  it('moves a file by dragging it onto a folder, after a confirm', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const file = await screen.findByTestId('tree-item-notes.md');
    const folder = screen.getByTestId('tree-item-docs');
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'move',
      dropEffect: 'move',
      types: ['application/x-ace-path'],
    };
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'Move “notes.md” into docs?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onDisk()).toContain('docs/notes.md'));
  });

  it('deletes after a confirm that says it cannot be undone, and closes the tab', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete “notes.md”?' });
    expect(dialog).toHaveTextContent('This cannot be undone.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDisk()).not.toContain('notes.md'));
    expect(tabs()).toEqual([]);
  });

  it('offers the operations on a right click', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    fireEvent.contextMenu(await screen.findByTestId('tree-item-src'));
    for (const name of [
      'New File',
      'New Folder',
      'Rename',
      'Delete',
      'Copy Path',
      'Copy Relative Path',
    ]) {
      expect(await screen.findByRole('menuitem', { name: new RegExp(name) })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('menuitem', { name: /New Folder/ }));
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toBeInTheDocument();
  });
});
