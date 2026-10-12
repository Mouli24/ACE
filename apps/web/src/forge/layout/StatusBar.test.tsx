import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import { db, installMockServer, renderWithQuery } from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { useEditorStatus } from '../editor/editor-status';
import { useProblemsStore } from '../panel/problems-store';
import { CursorInfo, ProblemsCount } from './StatusBar';

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
