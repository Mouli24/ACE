import { toast } from '@ace/ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockVersion } from '../../mocks/files';
import { db, installMockServer, queryClient, renderApp, server } from '../../test/app';
import { fileKeys } from '../files/keys';
import { applyFilesChanged } from '../files/project-socket';
import { openFile, saveFile } from './actions';
import { useEditorStore } from './editor-store';

installMockServer();

let projectId: string;
let path: string;
beforeEach(() => {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  projectId = project.id;
  path = `/projects/${project.id}/workflows/${workflow.id}/forge`;
  db.seedFiles(projectId, { 'a.ts': 'one' });
});
afterEach(() => vi.restoreAllMocks());

/** What the watcher would send for an agent's write. */
function agentWrites(content: string) {
  act(() => {
    db.writeFileExternally(projectId, 'a.ts', content);
    applyFilesChanged(queryClient, {
      projectId,
      changes: [{ path: 'a.ts', kind: 'changed' }],
      resync: false,
    });
  });
}

describe('D299 §5.4 the disk changes under an open file', () => {
  it('a clean buffer follows the disk, an unsaved one gets the conflict bar', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    const editor = await screen.findByLabelText('Editing a.ts');

    agentWrites('two');
    await waitFor(() => expect(editor).toHaveValue('two'));
    expect(screen.queryByTestId('conflict-bar')).toBeNull();

    await user.type(editor, '!');
    agentWrites('three');
    expect(await screen.findByTestId('conflict-bar')).toHaveTextContent(
      'a.ts changed on disk while you were editing it.',
    );
    expect(editor).toHaveValue('two!');
  });

  it('D334 the warning reaches the toaster; the quiet reload does not', async () => {
    const warning = vi.spyOn(toast, 'warning');
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    const editor = await screen.findByLabelText('Editing a.ts');

    agentWrites('two');
    await waitFor(() => expect(editor).toHaveValue('two'));
    expect(warning).not.toHaveBeenCalled();

    await user.type(editor, '!');
    agentWrites('three');
    await screen.findByTestId('conflict-bar');
    expect(warning).toHaveBeenCalledWith('a.ts changed on disk while you were editing it.');
  });

  it('a clean file deleted on disk is struck through, and saving brings it back', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    await screen.findByLabelText('Editing a.ts');

    act(() => {
      db.deleteFileExternally(projectId, 'a.ts');
      applyFilesChanged(queryClient, {
        projectId,
        changes: [{ path: 'a.ts', kind: 'deleted' }],
        resync: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId('tab-a.ts')).toHaveClass('line-through'));
    expect(screen.getByTestId('deleted-bar')).toBeInTheDocument();

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(db.filesOf(projectId)['a.ts']?.content).toBe('one'));
    expect(useEditorStore.getState().projects[projectId]?.files['a.ts']?.deletedOnDisk).toBe(false);
  });
});

describe('review I2: a save’s cache write never loses to an older read', () => {
  /** The next content read answers late, with the text from before the save. */
  function slowStaleRead(): { served: () => boolean } {
    let served = false;
    server.use(
      http.get(
        '*/api/v1/projects/:id/files/content',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          served = true;
          return HttpResponse.json({
            kind: 'text',
            path: 'a.ts',
            content: 'one',
            version: mockVersion('one'),
            eol: 'lf',
            bom: false,
            size: 3,
          });
        },
        { once: true },
      ),
    );
    return { served: () => served };
  }

  /** Save while a refetch that started before the save is still in flight, then let both settle. */
  async function saveDuringRefetch(user: ReturnType<typeof userEvent.setup>) {
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    const editor = await screen.findByLabelText('Editing a.ts');
    await user.type(editor, '!');
    const read = slowStaleRead();
    act(() => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.content(projectId, 'a.ts') });
    });
    expect(await act(() => saveFile(projectId, 'a.ts', queryClient))).toBe(true);
    expect(read.served()).toBe(false);
    return { editor, read };
  }

  async function settled(read: { served: () => boolean }) {
    await waitFor(() => expect(read.served()).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  }

  it('a clean buffer keeps the saved text, and so does the cache', async () => {
    const user = userEvent.setup();
    const { editor, read } = await saveDuringRefetch(user);
    await settled(read);

    expect(editor).toHaveValue('one!');
    expect(queryClient.getQueryData(fileKeys.content(projectId, 'a.ts'))).toMatchObject({
      content: 'one!',
      version: mockVersion('one!'),
    });
    expect(screen.queryByTestId('conflict-bar')).toBeNull();
    expect(useEditorStore.getState().projects[projectId]?.files['a.ts']).toMatchObject({
      dirty: false,
      baseVersion: mockVersion('one!'),
    });
  });

  it('typing after the save raises no phantom conflict', async () => {
    const user = userEvent.setup();
    const { editor, read } = await saveDuringRefetch(user);
    await user.type(editor, '?');
    await settled(read);

    expect(editor).toHaveValue('one!?');
    expect(screen.queryByTestId('conflict-bar')).toBeNull();
    expect(conflictOf()).toBeUndefined();
  });
});

function agentDeletes() {
  act(() => {
    db.deleteFileExternally(projectId, 'a.ts');
    applyFilesChanged(queryClient, {
      projectId,
      changes: [{ path: 'a.ts', kind: 'deleted' }],
      resync: false,
    });
  });
}

const conflictOf = () => useEditorStore.getState().projects[projectId]?.files['a.ts']?.conflict;

describe('D299 §5.4 no button discards unsaved text without asking', () => {
  it('Close on the deleted bar asks when the text typed after the delete is unsaved', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    const editor = await screen.findByLabelText('Editing a.ts');
    agentDeletes();
    await screen.findByTestId('deleted-bar');
    await user.type(editor, '!');

    await user.click(
      within(screen.getByTestId('deleted-bar')).getByRole('button', { name: 'Close' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Save changes to a.ts?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Don’t save' }));
    expect(screen.queryByTestId('tab-a.ts')).toBeNull();
  });

  it('Discard and close on a deleted conflict asks first', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    agentDeletes();
    await waitFor(() => expect(conflictOf()).toBe('deleted'));

    await user.click(screen.getByRole('button', { name: 'Discard and close' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save changes to a.ts?' }),
    ).toBeInTheDocument();
  });
});

describe('D299 §5.4 a conflict always says what the disk holds now', () => {
  it('deleted, then recreated by an agent, becomes changed and offers Compare', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    agentDeletes();
    await waitFor(() => expect(conflictOf()).toBe('deleted'));

    agentWrites('recreated');
    await waitFor(() => expect(conflictOf()).toBe('changed'));
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument();
  });

  it('changed, then deleted, becomes deleted', async () => {
    const user = userEvent.setup();
    renderApp(path);
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'a.ts'));
    await user.type(await screen.findByLabelText('Editing a.ts'), '!');
    agentWrites('theirs');
    await waitFor(() => expect(conflictOf()).toBe('changed'));

    agentDeletes();
    await waitFor(() => expect(conflictOf()).toBe('deleted'));
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
  });
});
