import type { AceSocketStatus } from '@ace/sdk';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { useEditorStatus } from '../../forge/editor/editor-status';
import { EMPTY_EDITOR, useEditorStore, type OpenFile } from '../../forge/editor/editor-store';
import type { WorkflowMode } from '../../forge/mode';
import type * as RunHooks from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, processes, renderWithQuery } from '../../test/app';
import { usePanelsStore } from '../stores/panels';
import { useWorkspaceStatus } from '../stores/workspace-status';
import { WorkspaceFooter } from './WorkspaceFooter';

installMockServer();

const socket = vi.hoisted(() => ({ status: 'open' as AceSocketStatus }));
vi.mock('../../runs/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof RunHooks>()),
  useSocketStatus: () => socket.status,
}));

afterEach(() => {
  socket.status = 'open';
  useRunStore.getState().reset();
  useWorkspaceStatus.setState({ messageCount: null });
  useEditorStatus.getState().clear();
});

function renderFooter(mode: WorkflowMode, name = 'Shop Floor') {
  const project = db.createProject({ name });
  const workflow = db.createWorkflow(project.id, 'Main');
  renderWithQuery(
    <MemoryRouter>
      <WorkspaceFooter projectId={project.id} workflowId={workflow.id} mode={mode} />
    </MemoryRouter>,
  );
  return { project, workflow };
}

const footer = () => screen.getByRole('contentinfo');

describe('D330 the workspace footer', () => {
  it('is the theme’s 24px footer with the 28×4 bar in the middle', async () => {
    renderFooter('ideate');
    await screen.findByTestId('project-slug');
    expect(footer()).toHaveClass(
      'h-6',
      'grid-cols-[1fr_auto_1fr]',
      'bg-[var(--hdr)]',
      'border-t',
      'text-[10px]',
      'text-[var(--muted)]',
    );
    const bar = footer().children[1] as HTMLElement;
    expect(bar).toHaveClass('h-1', 'w-7', 'rounded-[2px]', 'bg-[var(--iconLine)]');
  });

  describe('the connection (FR-EXE-014)', () => {
    it('reads Connected with a green dot while the socket is open', () => {
      renderFooter('ideate');
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Connected');
      expect((status.firstElementChild as HTMLElement).style.background).toBe('rgb(47, 158, 99)');
      expect(screen.queryByTestId('socket-reconnecting')).toBeNull();
    });

    it.each(['connecting', 'reconnecting'] as const)(
      'reads Reconnecting… while %s, under the testid the e2e watches',
      (status) => {
        socket.status = status;
        renderFooter('ideate');
        const notice = screen.getByTestId('socket-reconnecting');
        expect(notice).toHaveAttribute('role', 'status');
        expect(notice).toHaveTextContent('Reconnecting…');
        expect((notice.firstElementChild as HTMLElement).style.background).toBe(
          'rgb(163, 157, 151)',
        );
      },
    );

    it.each(['idle', 'closed', 'unauthorized'] as const)('reads Disconnected when %s', (status) => {
      socket.status = status;
      renderFooter('ideate');
      const notice = screen.getByRole('status');
      expect(notice).toHaveTextContent('Disconnected');
      expect((notice.firstElementChild as HTMLElement).style.background).toBe('rgb(201, 76, 39)');
    });

    it('after a 4403, says this address may not connect, as a red alert that says how to fix it (FR-SYS-003, D301)', () => {
      socket.status = 'forbidden_origin';
      renderFooter('ideate');
      const notice = within(footer()).getByRole('alert');
      expect(notice).toHaveAttribute('data-testid', 'socket-forbidden-origin');
      expect(notice).toHaveTextContent('this address may not connect to the engine');
      expect(notice).toHaveAttribute('title', expect.stringContaining('allowedOrigins'));
      expect(notice).toHaveClass('text-danger');
      expect(notice.firstElementChild).toHaveClass('h-[6px]', 'w-[6px]', 'rounded-full');
      expect(within(footer()).queryByText('Disconnected')).toBeNull();
      expect(screen.queryByTestId('socket-reconnecting')).toBeNull();
    });
  });

  it('shows the project as its slug, in mono', async () => {
    renderFooter('ideate', 'Shop Floor');
    const slug = await screen.findByTestId('project-slug');
    expect(slug).toHaveTextContent('shop-floor');
    expect(slug).toHaveClass('font-machine');
    expect(slug).toHaveAttribute('title', 'Shop Floor');
  });

  it.each([
    ['ideate', 'Ideate'],
    ['forge', 'Forge'],
    ['domain', 'Domain'],
  ] as const)('labels the mode in %s', (mode, label) => {
    renderFooter(mode);
    expect(screen.getByTestId('footer-mode')).toHaveTextContent(label);
  });

  describe('tokens', () => {
    it('shows — in / — out with no data', () => {
      renderFooter('ideate');
      expect(screen.getByTestId('footer-tokens')).toHaveTextContent('— in / — out');
    });

    // PG-3.3: one source in every mode — the selected run's totals (PG-3.2), live from the overlay.
    it.each(['ideate', 'forge', 'domain'] as const)(
      'in %s, the selected run’s totals from the live overlay',
      (mode) => {
        const { workflow } = renderFooter(mode);
        act(() =>
          useRunStore.setState({
            workflowId: workflow.id,
            runId: 'RUN1',
            active: true,
            totals: { tokensIn: 12_345, tokensOut: 812, costUsd: 0.01 },
          }),
        );
        expect(screen.getByTestId('footer-tokens')).toHaveTextContent('12.3k in / 812 out');
      },
    );

    it('never another workflow’s run totals', () => {
      renderFooter('ideate');
      act(() =>
        useRunStore.setState({
          workflowId: 'OTHER',
          runId: 'RUN1',
          active: true,
          totals: { tokensIn: 5, tokensOut: 5, costUsd: 0 },
        }),
      );
      expect(screen.getByTestId('footer-tokens')).toHaveTextContent('— in / — out');
    });
  });

  it('counts the open conversation’s messages, and hides the count when there is none', () => {
    renderFooter('ideate');
    expect(screen.queryByTestId('footer-messages')).toBeNull();
    act(() => useWorkspaceStatus.getState().setMessageCount(7));
    expect(screen.getByTestId('footer-messages')).toHaveTextContent('7 messages');
    act(() => useWorkspaceStatus.getState().setMessageCount(0));
    expect(screen.getByTestId('footer-messages')).toHaveTextContent('0 messages');
  });

  describe('Forge’s cursor line and file facts', () => {
    const file = (path: string, dirty: boolean): OpenFile => ({
      path,
      baseVersion: 'v1',
      bom: false,
      dirty,
      saving: false,
      conflict: undefined,
      deletedOnDisk: false,
      error: undefined,
    });

    /** What Forge reports: the open file's buffer, and the text file the editor shows (or null). */
    function openFile(projectId: string, path: string, dirty: boolean, shown: string | null) {
      act(() => {
        useEditorStore.setState({
          projects: {
            [projectId]: {
              ...EMPTY_EDITOR,
              tabs: [path],
              active: path,
              files: { [path]: file(path, dirty) },
            },
          },
        });
        useEditorStatus.setState({ path: shown });
      });
    }

    it('reads Ln, Col · indentation · encoding · line endings · language · unsaved while the editor shows a text file (D299)', () => {
      const { project } = renderFooter('forge');
      act(() => useEditorStatus.setState({ line: 3, column: 7, language: 'typescript' }));
      openFile(project.id, 'src/app.ts', true, 'src/app.ts');
      const cursor = screen.getByTestId('footer-cursor');
      expect(cursor).toHaveTextContent(
        'Ln 3, Col 7 · Spaces: 2 · UTF-8 · LF · TypeScript · unsaved',
      );
      // first in the right-hand group, before the mode
      const right = within(footer()).getByTestId('footer-mode').parentElement!;
      expect(right.firstElementChild).toBe(cursor);
      expect(right).toHaveClass('gap-[14px]', 'font-machine', 'text-[9.5px]', 'whitespace-nowrap');
    });

    it('drops "unsaved" for a clean buffer', () => {
      const { project } = renderFooter('forge');
      act(() => useEditorStatus.setState({ line: 1, column: 1, language: 'markdown' }));
      openFile(project.id, 'README.md', false, 'README.md');
      expect(screen.getByTestId('footer-cursor')).toHaveTextContent(
        /^Ln 1, Col 1 · Spaces: 2 · UTF-8 · LF · Markdown$/,
      );
    });

    it('is absent while the editor shows no text file (none open, an image, a notice)', () => {
      const { project } = renderFooter('forge');
      expect(screen.queryByTestId('footer-cursor')).toBeNull();
      openFile(project.id, 'logo.png', false, null);
      expect(screen.queryByTestId('footer-cursor')).toBeNull();
    });

    it('is absent in Ideate even with a file open', () => {
      const { project } = renderFooter('ideate');
      openFile(project.id, 'src/app.ts', true, 'src/app.ts');
      expect(screen.queryByTestId('footer-cursor')).toBeNull();
    });
  });

  it('carries this workflow’s run state as data, drawing nothing for it', () => {
    const { workflow } = renderFooter('ideate');
    expect(footer()).not.toHaveAttribute('data-run-status');
    // PG-3.2: the selected run's state — here the run the overlay follows for this workflow.
    act(() =>
      useRunStore.setState({
        workflowId: workflow.id,
        runId: 'RUN1',
        active: true,
        status: 'COMPLETE',
      }),
    );
    expect(footer()).toHaveAttribute('data-run-status', 'COMPLETE');
    expect(footer()).not.toHaveTextContent(/complete/i);
    act(() => useRunStore.setState({ workflowId: 'OTHER', status: 'RUNNING' }));
    expect(footer()).not.toHaveAttribute('data-run-status');
  });

  it('D301 in Forge, ▶ N running follows the problem counts while a process runs', async () => {
    const project = db.createProject({ name: 'Shop Floor' });
    const workflow = db.createWorkflow(project.id, 'Main');
    processes.start(project.id, { command: 'serve' });
    renderWithQuery(
      <MemoryRouter>
        <WorkspaceFooter projectId={project.id} workflowId={workflow.id} mode="forge" />
      </MemoryRouter>,
    );
    const running = await within(footer()).findByRole('button', { name: '1 running' });
    expect(within(footer()).getByTestId('footer-problems').nextElementSibling).toBe(running);
    processes.stopProject(project.id);
  });

  it('D301 has no running count outside Forge', async () => {
    const project = db.createProject({ name: 'Shop Floor' });
    const workflow = db.createWorkflow(project.id, 'Main');
    processes.start(project.id, { command: 'serve' });
    renderWithQuery(
      <MemoryRouter>
        <WorkspaceFooter projectId={project.id} workflowId={workflow.id} mode="ideate" />
      </MemoryRouter>,
    );
    await screen.findByTestId('project-slug');
    expect(screen.queryByTestId('footer-running')).toBeNull();
    processes.stopProject(project.id);
  });
});

describe('PG-1.2 a visible Problems & events button in the footer (D360)', () => {
  afterEach(() => usePanelsStore.setState({ bottomOpen: false, bottomTab: 'validation' }));

  it.each(['ideate', 'forge', 'domain'] as const)('is a named, visible button in %s', (mode) => {
    renderFooter(mode);
    expect(within(footer()).getByRole('button', { name: /Problems & events/ })).toBeVisible();
  });

  it('in Ideate it opens the bottom panel on Problems, and a second click closes it', async () => {
    renderFooter('ideate');
    const button = within(footer()).getByRole('button', { name: /Problems & events/ });
    await userEvent.click(button);
    expect(usePanelsStore.getState()).toMatchObject({ bottomOpen: true, bottomTab: 'validation' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(button);
    expect(usePanelsStore.getState().bottomOpen).toBe(false);
  });
});
