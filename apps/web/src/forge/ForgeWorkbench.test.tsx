import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useLayoutStore } from '../app/stores/layout';
import { mockVersion } from '../mocks/files';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, renderApp, server } from '../test/app';
import { FakeTerminal } from '../test/FakeTerminal';
import { useComposerChips } from '../chat/composer-chips';
import { setSelectionSource } from './ask-agent';
import { openFile } from './editor/actions';
import { useEditorStore } from './editor/editor-store';

installMockServer();
beforeEach(() => useRunStore.getState().reset());

let projectId: string;
let workflowId: string;
function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  projectId = project.id;
  workflowId = workflow.id;
  db.seedFiles(project.id, { 'src/app.ts': 'export {};', 'README.md': '# Shop' });
  return `/projects/${project.id}/workflows/${workflow.id}/forge`;
}

describe('D334 FR-GIT-003 Forge in the theme’s code view', () => {
  it('lays out the Explorer with the project’s files beside the code column, and nothing else', async () => {
    renderApp(seed());
    const forge = await screen.findByTestId('forge');
    const explorer = within(forge).getByRole('navigation', { name: 'Explorer' });
    expect(explorer).toHaveClass('w-[248px]', 'bg-[var(--panel)]');
    expect(
      await within(explorer).findByRole('tree', { name: 'Files of Shop' }),
    ).toBeInTheDocument();
    expect(await within(explorer).findByTestId('explorer-count')).toHaveTextContent('2 files');
    expect(within(forge).getByRole('region', { name: 'Editor' })).toBeInTheDocument();
    expect(within(forge).getByRole('tablist', { name: 'Open files' })).toBeInTheDocument();
    expect(within(forge).getByText('Open a file from the explorer')).toBeInTheDocument();
    // the activity bar, Open editors, the Output panel and the status bar are gone; the bottom
    // panel (Problems) stays closed until asked for
    expect(within(forge).queryByRole('navigation', { name: 'Forge views' })).toBeNull();
    expect(within(forge).queryByRole('region', { name: 'Open editors' })).toBeNull();
    expect(within(forge).queryByRole('region', { name: 'Panel' })).toBeNull();
    expect(within(forge).queryByTestId('status-bar')).toBeNull();
    expect(within(forge).queryByTestId('path-bar')).toBeNull();
  });

  it('hides and shows the Explorer with Ctrl+B, and remembers; Ctrl+J shows and hides the Problems panel (D299)', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByRole('tree', { name: 'Files of Shop' });

    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Explorer' })).toBeNull();
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    await user.keyboard('{Control>}b{/Control}');
    expect(await screen.findByRole('tree', { name: 'Files of Shop' })).toBeInTheDocument();

    await user.keyboard('{Control>}j{/Control}');
    const panel = screen.getByRole('region', { name: 'Panel' });
    expect(within(panel).getByText('No problems in the open files.')).toBeInTheDocument();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'problems' });
    await user.keyboard('{Control>}j{/Control}');
    expect(screen.queryByRole('region', { name: 'Panel' })).toBeNull();
    await user.keyboard('{Control>}j{/Control}');
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('region', { name: 'Panel' })).toBeNull();
  });

  it('maximizes the panel over the code column, and restores it', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    await user.keyboard('{Control>}j{/Control}');
    await user.click(screen.getByRole('button', { name: 'Maximize panel' }));
    expect(screen.queryByRole('region', { name: 'Editor' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Restore panel size' }));
    expect(screen.getByRole('region', { name: 'Editor' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Panel' })).toBeInTheDocument();
  });

  it('review I1: Save all (Ctrl+Alt+S; the Open editors button left with D334) writes only an unsaved buffer that is not in conflict', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    // a clean tab whose file was deleted on disk: Save all never brings it back
    act(() => openFile(projectId, 'src/app.ts', { preview: false }));
    await screen.findByLabelText('Editing src/app.ts');
    act(() => {
      db.deleteFileExternally(projectId, 'src/app.ts');
      useEditorStore.getState().markDeletedOnDisk(projectId, 'src/app.ts');
    });
    // an unsaved buffer in conflict: the conflict bar's to resolve, not Save all's
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await user.type(await screen.findByLabelText('Editing README.md'), '!');
    act(() => useEditorStore.getState().conflicted(projectId, 'README.md', 'changed'));

    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(db.filesOf(projectId)['src/app.ts']).toBeUndefined();
    expect(db.filesOf(projectId)['README.md']?.content).toBe('# Shop');

    act(() => useEditorStore.getState().resolved(projectId, 'README.md', mockVersion('# Shop')));
    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    await waitFor(() => expect(db.filesOf(projectId)['README.md']?.content).toBe('# Shop!'));
    expect(db.filesOf(projectId)['src/app.ts']).toBeUndefined();
  });

  it('opens a file under the path bar, whose ▶ Run pipeline starts this workflow’s run', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    act(() => openFile(projectId, 'src/app.ts'));

    const bar = await screen.findByTestId('path-bar');
    await waitFor(() =>
      expect(
        within(bar)
          .getAllByTestId('crumb')
          .map((crumb) => crumb.textContent),
      ).toEqual(['shop', 'src', 'app.ts']),
    );
    const run = within(bar).getByRole('button', { name: 'Run pipeline' });
    await user.click(run);
    await waitFor(() => expect(db.listRuns(workflowId)).toHaveLength(1));
    expect(useRunStore.getState().workflowId).toBe(workflowId);
  });

  it('D301 Ctrl+` opens the Terminal pill focused, and closes it again', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    // user-event's key map has no backquote: a typed ` would arrive as code "Unknown" and match
    // nothing. [Backquote] names the key by its code, which is what the shortcut matches.
    await user.keyboard('{Control>}[Backquote]{/Control}');
    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
    expect(useLayoutStore.getState().panelTab).toBe('terminal');
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(FakeTerminal.latest().focused).toBe(1));
    await user.keyboard('{Control>}[Backquote]{/Control}');
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });

  it('D301 the empty editor offers the Terminal as a third pill with its key, and focuses it', async () => {
    const user = userEvent.setup();
    renderApp(seed());
    await screen.findByTestId('forge');
    const pill = screen.getByRole('button', { name: /^Terminal/ });
    expect(pill).toHaveTextContent('Terminal Ctrl+`');
    expect(pill).toHaveClass('rounded-full');
    await user.click(pill);
    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
    await waitFor(() => expect(FakeTerminal.latest().focused).toBe(1));
  });
});

describe('[audit F-6] switching modes keeps Forge’s project services', () => {
  it('Ideate → Forge → Ideate → Forge walks the project and reads its type sources once', async () => {
    const forgePath = seed();
    const ideatePath = forgePath.replace(/\/forge$/, '');
    const reads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/files/list') || pathname.endsWith('/files/sources')) {
        reads.push(pathname.slice(pathname.lastIndexOf('/') + 1));
      }
    });
    const { router } = renderApp(ideatePath);
    await act(() => router.navigate(forgePath));
    expect(await screen.findByTestId('explorer-count')).toHaveTextContent('2 files');
    await act(() => router.navigate(ideatePath));
    await waitFor(() => expect(screen.queryByTestId('forge')).toBeNull());
    await act(() => router.navigate(forgePath));
    expect(await screen.findByTestId('explorer-count')).toHaveTextContent('2 files');

    await waitFor(() => expect(reads.filter((read) => read === 'sources')).toHaveLength(1));
    expect(reads.filter((read) => read === 'list')).toHaveLength(1);
    server.events.removeAllListeners('request:start');
  });
});

describe('D302 Ctrl/⌘+L asks the agent', () => {
  it('adds the editor’s selection, or the active file when no editor can say', async () => {
    const user = userEvent.setup();
    useComposerChips.getState().reset();
    renderApp(seed());
    await screen.findByRole('tree', { name: 'Files of Shop' });
    act(() => openFile(projectId, 'src/app.ts', { preview: false }));
    await screen.findByTestId('fake-editor');

    // the stand-in editor reads no selection: the active file goes, by its path
    await user.keyboard('{Control>}l{/Control}');
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'src/app.ts', language: 'typescript' },
    ]);

    const stop = setSelectionSource(() => ({
      path: 'src/app.ts',
      startLine: 1,
      endLine: 1,
      text: 'export {};',
      language: 'typescript',
    }));
    await user.keyboard('{Control>}l{/Control}');
    expect(useComposerChips.getState().chips[1]).toMatchObject({
      path: 'src/app.ts',
      startLine: 1,
      endLine: 1,
      text: 'export {};',
    });
    stop();
  });
});
