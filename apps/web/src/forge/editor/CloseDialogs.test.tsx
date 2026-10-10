import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, installMockServer, renderWithQuery } from '../../test/app';
import { openFile } from './actions';
import { EditorArea } from './EditorArea';
import { useEditorStore } from './editor-store';
import { useBeforeUnloadGuard } from './guards';

installMockServer();

let projectId: string;
beforeEach(() => {
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, { 'a.ts': 'one', 'b.ts': 'bee' });
});

async function dirtyTab(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<EditorArea projectId={projectId} />);
  act(() => openFile(projectId, 'a.ts'));
  await user.type(await screen.findByLabelText('Editing a.ts'), '!');
}

describe('D299 §6.2 closing a tab with unsaved changes asks first', () => {
  it('Cancel keeps the tab and the changes', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save changes to a.ts?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('tab-a.ts')).toBeInTheDocument();
  });

  it('Don’t save closes the tab and drops the changes', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    await user.click(await screen.findByRole('button', { name: 'Don’t save' }));
    expect(screen.queryByTestId('tab-a.ts')).toBeNull();
    expect(db.filesOf(projectId)['a.ts']?.content).toBe('one');
  });

  it('Save writes the file, then closes the tab', async () => {
    const user = userEvent.setup();
    await dirtyTab(user);
    await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('tab-a.ts')).toBeNull());
    expect(db.filesOf(projectId)['a.ts']?.content).toBe('one!');
  });

  it('closing a clean tab asks nothing', async () => {
    const user = userEvent.setup();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'b.ts'));
    await user.click(await screen.findByRole('button', { name: 'Close b.ts' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('D299 §2.3 closing the browser tab with unsaved work asks first', () => {
  function Guard() {
    useBeforeUnloadGuard();
    return null;
  }

  it('cancels beforeunload only while something is unsaved', () => {
    renderWithQuery(<Guard />);
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);

    act(() => {
      useEditorStore.getState().open(projectId, 'a.ts');
      useEditorStore.getState().setDirty(projectId, 'a.ts', true);
    });
    const guarded = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);
  });
});
