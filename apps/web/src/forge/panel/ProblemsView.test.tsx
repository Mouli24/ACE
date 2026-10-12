import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

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
