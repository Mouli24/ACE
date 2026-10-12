import type { AceSocketStatus } from '@ace/sdk';
import { act, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useEditorStatus } from '../../forge/editor/editor-status';
import { EMPTY_EDITOR, useEditorStore, type OpenFile } from '../../forge/editor/editor-store';
import type { WorkflowMode } from '../../forge/mode';
import type * as RunHooks from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, renderWithQuery } from '../../test/app';
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
  useWorkspaceStatus.setState({ messageCount: null, tokens: null });
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

    it('in Ideate and Forge, this workflow’s run totals from the live overlay', () => {
      const { workflow } = renderFooter('forge');
      act(() =>
        useRunStore.setState({
          workflowId: workflow.id,
          totals: { tokensIn: 12_345, tokensOut: 812, costUsd: 0.01 },
        }),
      );
      expect(screen.getByTestId('footer-tokens')).toHaveTextContent('12.3k in / 812 out');
    });

    it('never another workflow’s run totals', () => {
      renderFooter('ideate');
      act(() =>
        useRunStore.setState({
          workflowId: 'OTHER',
          totals: { tokensIn: 5, tokensOut: 5, costUsd: 0 },
        }),
      );
      expect(screen.getByTestId('footer-tokens')).toHaveTextContent('— in / — out');
    });

    it('in Domain, what the Domain page publishes', () => {
      const { workflow } = renderFooter('domain');
      act(() => {
        useRunStore.setState({
          workflowId: workflow.id,
          totals: { tokensIn: 5, tokensOut: 5, costUsd: 0 },
        });
        useWorkspaceStatus.getState().setTokens({ in: 1_230_000, out: 45_600 });
      });
      expect(screen.getByTestId('footer-tokens')).toHaveTextContent('1.23M in / 45.6k out');
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
    act(() => useRunStore.setState({ workflowId: workflow.id, status: 'COMPLETE' }));
    expect(footer()).toHaveAttribute('data-run-status', 'COMPLETE');
    expect(footer()).not.toHaveTextContent(/complete/i);
    act(() => useRunStore.setState({ workflowId: 'OTHER', status: 'RUNNING' }));
    expect(footer()).not.toHaveAttribute('data-run-status');
  });
});
