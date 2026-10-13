import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useComposerChips } from '../../chat/composer-chips';
import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { ProblemsView } from './ProblemsView';
import { useProblemsStore } from './problems-store';

installMockServer();

describe('D299 §6.4 the Problems panel', () => {
  it('says so when there are none', () => {
    renderWithQuery(<ProblemsView projectId="p1" />);
    expect(screen.getByText('No problems in the open files.')).toBeInTheDocument();
  });

  it('lists problems by file, and a click opens the file at the problem', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'P' }).id;
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            {
              path: 'src/a.ts',
              line: 9,
              column: 3,
              severity: 'error',
              message: 'type error',
              source: 'ts',
            },
          ],
        },
      }),
    );
    renderWithQuery(<ProblemsView projectId={projectId} />);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /type error/ }));
    expect(useEditorStore.getState().projects[projectId]).toMatchObject({
      active: 'src/a.ts',
      reveal: { path: 'src/a.ts', line: 9, column: 3 },
    });
  });
});

describe('D302 Fix with agent on a problem', () => {
  it('every row has the button; with no node selected it fills the composer with the problem', async () => {
    const user = userEvent.setup();
    useComposerChips.getState().reset();
    const projectId = db.createProject({ name: 'P' }).id;
    db.seedFiles(projectId, {
      'src/a.ts': Array.from({ length: 12 }, (_, index) => `const v${index + 1} = 1;`).join('\n'),
    });
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            {
              path: 'src/a.ts',
              line: 9,
              column: 3,
              severity: 'error',
              message: 'type error',
              source: 'ts',
            },
            {
              path: 'src/a.ts',
              line: 2,
              column: 1,
              severity: 'warning',
              message: 'unused',
              source: undefined,
            },
          ],
        },
      }),
    );
    renderWithQuery(<ProblemsView projectId={projectId} />);
    const buttons = screen.getAllByRole('button', { name: 'Fix with agent' });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]!);
    await waitFor(() =>
      expect(useComposerChips.getState().chips).toMatchObject([
        { path: 'src/a.ts', startLine: 4, endLine: 12, language: 'typescript' },
      ]),
    );
    expect(useComposerChips.getState().draft).toBe('Fix this problem: type error (ts)');
    expect(useComposerChips.getState().chips[0]?.text).toContain('const v9 = 1;');
  });
});
