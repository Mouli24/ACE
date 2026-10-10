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

function dragOf() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'move',
    dropEffect: 'move',
    types: ['application/x-ace-path'],
  };
}

describe('D299 drops land where they are aimed', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await user.click(await screen.findByTestId('tree-item-src'));
    await user.click(await screen.findByTestId('tree-item-docs'));
    return {
      app: await screen.findByTestId('tree-item-src/app.ts'),
      readme: await screen.findByTestId('tree-item-docs/readme.md'),
      src: screen.getByTestId('tree-item-src'),
    };
  };

  it('refuses a drop onto the folder the file is already in', async () => {
    const user = userEvent.setup();
    const { app, src } = await open(user);
    const dataTransfer = dragOf();
    fireEvent.dragStart(app, { dataTransfer });
    fireEvent.dragOver(src, { dataTransfer });
    fireEvent.drop(src, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('none');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('treats a drop onto a file as a drop into its folder', async () => {
    const user = userEvent.setup();
    const { app, readme } = await open(user);
    const dataTransfer = dragOf();
    fireEvent.dragStart(app, { dataTransfer });
    fireEvent.dragOver(readme, { dataTransfer });
    fireEvent.drop(readme, { dataTransfer });
    expect(
      await screen.findByRole('dialog', { name: 'Move “app.ts” into docs?' }),
    ).toBeInTheDocument();
  });

  it('means the project folder only on the empty area of the tree', async () => {
    const user = userEvent.setup();
    const { app } = await open(user);
    const dataTransfer = dragOf();
    fireEvent.dragStart(app, { dataTransfer });
    fireEvent.dragOver(screen.getByRole('tree'), { dataTransfer });
    fireEvent.drop(screen.getByRole('tree'), { dataTransfer });
    expect(
      await screen.findByRole('dialog', { name: 'Move “app.ts” into the project folder?' }),
    ).toBeInTheDocument();
  });
});

describe('D299 focus stays in the Explorer', () => {
  it('returns to the renamed row after Enter and to the original row after Escape', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{F2}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByTestId('tree-item-notes.md')).toHaveFocus());
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename notes.md' });
    await user.clear(input);
    await user.type(input, 'journal.md{Enter}');
    await waitFor(() => expect(screen.getByTestId('tree-item-journal.md')).toHaveFocus());
  });

  it('lands on a row after a delete confirm', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDisk()).not.toContain('notes.md'));
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'));
  });

  it('keeps the caret in the field when the engine refuses', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file name' });
    await user.type(input, 'docs/readme.md{Enter}');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).not.toBeDisabled();
  });
});

describe('D299 nothing moves mid-save', () => {
  it('refuses a rename while the file is saving', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => useEditorStore.getState().saveStarted(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename notes.md' });
    await user.clear(input);
    await user.type(input, 'journal.md{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the save to finish.');
    expect(onDisk()).toContain('notes.md');
    expect(onDisk()).not.toContain('journal.md');
  });

  it('refuses a delete while a file inside is saving', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ExplorerView projectId={projectId} />);
    const row = await screen.findByTestId('tree-item-src');
    act(() => openFile(projectId, 'src/app.ts'));
    act(() => useEditorStore.getState().saveStarted(projectId, 'src/app.ts'));
    act(() => row.focus());
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Wait for the save to finish.',
    );
    expect(onDisk()).toContain('src/app.ts');
  });
});

describe('D299 an edit ended by a click elsewhere leaves focus there', () => {
  const withOutside = () =>
    renderWithQuery(
      <>
        <button type="button">Elsewhere</button>
        <ExplorerView projectId={projectId} />
      </>,
    );

  it('keeps focus on the button clicked during a rename', async () => {
    const user = userEvent.setup();
    withOutside();
    const row = await screen.findByTestId('tree-item-notes.md');
    act(() => openFile(projectId, 'notes.md'));
    act(() => row.focus());
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename notes.md' });
    await user.clear(input);
    await user.type(input, 'journal.md');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(onDisk()).toContain('journal.md'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('keeps focus on the button clicked during a New File', async () => {
    const user = userEvent.setup();
    withOutside();
    await screen.findByTestId('tree-item-notes.md');
    await user.click(screen.getByRole('button', { name: 'New File' }));
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('textbox', { name: 'New file name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });
});
