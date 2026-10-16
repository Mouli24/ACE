import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import { db, installMockServer, processes, queryClient, renderWithQuery } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { useEditorStatus } from '../editor/editor-status';
import { useProblemsStore } from '../panel/problems-store';
import { processKeys } from '../terminal/hooks';
import { CursorInfo, ProblemsCount, RunningCount } from './StatusBar';

installMockServer();

describe('D299 the status bar, in the workspace footer since D330', () => {
  it('counts errors and warnings, and a click opens Problems', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            {
              path: 'a.ts',
              line: 1,
              column: 1,
              severity: 'error',
              message: 'x',
              source: undefined,
            },
            {
              path: 'a.ts',
              line: 2,
              column: 1,
              severity: 'warning',
              message: 'y',
              source: undefined,
            },
            {
              path: 'b.ts',
              line: 1,
              column: 1,
              severity: 'error',
              message: 'z',
              source: undefined,
            },
          ],
        },
      }),
    );
    renderWithQuery(<ProblemsCount projectId={projectId} />);
    await user.click(screen.getByRole('button', { name: '2 errors, 1 warning' }));
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'problems' });
  });

  it('describes the active text file: position, indentation, encoding, line endings, language', () => {
    const projectId = db.createProject({ name: 'P' }).id;
    act(() => {
      useEditorStore.getState().open(projectId, 'a.ts');
      // the editor reports the text file it shows (D330): the facts are about that file
      useEditorStatus.setState({
        path: 'a.ts',
        line: 12,
        column: 4,
        indentation: 'Spaces: 2',
        bom: true,
        eol: 'CRLF',
        language: 'typescript',
      });
    });
    renderWithQuery(<CursorInfo projectId={projectId} />);
    for (const text of ['Ln 12, Col 4', 'Spaces: 2', 'UTF-8 with BOM', 'CRLF', 'TypeScript']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});

describe('D330 D334 the status bar’s pieces in the footer’s type', () => {
  it('the counts are mono and muted, each mark in its Validation colour only while not zero', () => {
    const projectId = db.createProject({ name: 'P' }).id;
    renderWithQuery(<ProblemsCount projectId={projectId} />);
    const button = screen.getByRole('button', { name: '0 errors, 0 warnings' });
    expect(button).toHaveClass('font-machine', 'text-[10px]', 'text-[var(--muted)]');
    // PG-1.2 (D360): the ✕ mark is an SVG icon in a span that carries the colour
    expect(screen.getByTestId('problems-error-mark')).not.toHaveStyle({ color: '#c94c27' });
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            {
              path: 'a.ts',
              line: 1,
              column: 1,
              severity: 'error',
              message: 'x',
              source: undefined,
            },
          ],
        },
      }),
    );
    expect(screen.getByRole('button', { name: '1 error, 0 warnings' })).toBeInTheDocument();
    expect(screen.getByTestId('problems-error-mark')).toHaveStyle({ color: '#c94c27' });
    expect(screen.getByText('!')).not.toHaveStyle({ color: '#e8572e' });
  });

  it('the file facts are one line, joined by the theme’s middots', () => {
    const projectId = db.createProject({ name: 'P' }).id;
    act(() => {
      useEditorStore.getState().open(projectId, 'a.ts');
      useEditorStatus.setState({ path: 'a.ts', line: 3, column: 9, language: 'markdown' });
    });
    renderWithQuery(<CursorInfo projectId={projectId} />);
    expect(screen.getByTestId('footer-cursor')).toHaveTextContent(
      /^Ln 3, Col 9 · Spaces: 2 · UTF-8 · LF · Markdown$/,
    );
  });

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('D301 counts the running processes as ▶ N running, in the counts’ type; a click opens the Terminal', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    processes.start(projectId, { command: 'serve' });
    processes.start(projectId, { command: 'serve' });
    renderWithQuery(<RunningCount projectId={projectId} />);
    const count = await screen.findByRole('button', { name: '2 running' });
    expect(count).toHaveClass('font-machine', 'text-[10px]', 'text-[var(--muted)]');
    // PG-1.2 (D360): the ▶ mark is an SVG play icon in a span that carries the colour
    expect(screen.getByTestId('running-mark')).toHaveStyle({ color: '#ef6b3f' });
    await user.click(count);
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'terminal' });
    processes.stopProject(projectId);
  });

  it('D301 says nothing about processes when none runs', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    renderWithQuery(<RunningCount projectId={projectId} />);
    // The list has arrived (empty): only now does "no count" mean something.
    await waitFor(() =>
      expect(queryClient.getQueryState(processKeys.list(projectId))?.status).toBe('success'),
    );
    expect(screen.queryByTestId('footer-running')).toBeNull();
  });
});
