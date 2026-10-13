import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import { installMockServer, renderWithQuery } from '../../test/app';
import { ProblemsCount } from '../layout/StatusBar';
import { BottomPanel } from './BottomPanel';
import { useProblemsStore, type Problem } from './problems-store';

installMockServer();

const P = 'p1';
const problem = (severity: Problem['severity'], line: number): Problem => ({
  path: 'src/a.ts',
  line,
  column: 1,
  severity,
  message: `${severity} on ${line}`,
  source: 'ts',
});

describe('D299 D334 Forge’s bottom panel in the theme', () => {
  it('is the canvas’s bottom panel: 232px on the panel colour, the views as the segmented pill', () => {
    renderWithQuery(<BottomPanel projectId={P} />);
    const panel = screen.getByRole('region', { name: 'Panel' });
    expect(panel).toHaveClass('h-[232px]', 'bg-[var(--panel)]', 'border-t');
    expect(within(panel).getByRole('tablist', { name: 'Panel views' })).toHaveClass(
      'rounded-full',
      'bg-[var(--soft)]',
    );
    expect(within(panel).getByRole('tab', { name: 'Problems' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByText('No problems in the open files.')).toBeInTheDocument();
    expect(screen.queryByTestId('problems-count')).toBeNull();
  });

  it('counts the problems on the tab as a mono chip, red while one is an error', () => {
    act(() => useProblemsStore.setState({ byProject: { [P]: [problem('warning', 2)] } }));
    renderWithQuery(<BottomPanel projectId={P} />);
    const count = screen.getByTestId('problems-count');
    expect(count).toHaveTextContent('1');
    expect(count).toHaveClass('font-machine', 'bg-[var(--hover)]');
    act(() =>
      useProblemsStore.setState({
        byProject: { [P]: [problem('error', 1), problem('warning', 2)] },
      }),
    );
    expect(screen.getByTestId('problems-count')).toHaveTextContent('2');
    expect(screen.getByTestId('problems-count')).toHaveClass('text-[#c94c27]');
  });

  it('counts one error once when Monaco and the checks both report it, and lists both rows (smoke S-2)', () => {
    const message = "Argument of type 'string' is not assignable to parameter of type 'number'.";
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [P]: [
            {
              path: 'src/main.ts',
              line: 3,
              column: 5,
              severity: 'error',
              message,
              source: undefined,
              code: '2345',
            },
          ],
        },
        checks: {
          [P]: {
            status: 'done',
            command: 'tsc --noEmit -p .',
            startedAt: '2026-10-13T10:00:00.000Z',
            finishedAt: '2026-10-13T10:00:02.000Z',
            exitCode: 2,
            problems: [
              {
                path: 'src/main.ts',
                line: 3,
                column: 5,
                severity: 'error',
                message,
                source: 'tsc',
                code: 'TS2345',
              },
            ],
          },
        },
      }),
    );
    renderWithQuery(
      <>
        <BottomPanel projectId={P} />
        <ProblemsCount projectId={P} />
      </>,
    );
    expect(screen.getByTestId('problems-count')).toHaveTextContent(/^1$/);
    expect(screen.getByTestId('footer-problems')).toHaveAccessibleName('1 error, 0 warnings');
    // the list keeps both: the open file's marker and the Checks group's row
    expect(
      within(screen.getByRole('list', { name: 'Problems in src/main.ts' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: 'Checks' })).getByRole('button', {
        name: /not assignable/,
      }),
    ).toHaveTextContent('tsc(TS2345) [Ln 3, Col 5]');
  });

  it('lists a file’s problems in one surface card, the severity as the Validation tab’s glyph', () => {
    act(() =>
      useProblemsStore.setState({
        byProject: { [P]: [problem('error', 1), problem('warning', 2), problem('info', 3)] },
      }),
    );
    renderWithQuery(<BottomPanel projectId={P} />);
    const card = screen.getByRole('list', { name: 'Problems in src/a.ts' });
    expect(card).toHaveClass('rounded-[12px]', 'bg-[var(--surface)]');
    // one row per problem, each opening it; D302 gives every row a Fix with agent beside it
    expect(within(card).getAllByRole('button', { name: /\[Ln/ })).toHaveLength(3);
    expect(within(card).getAllByRole('button', { name: 'Fix with agent' })).toHaveLength(3);
    expect(within(card).getByRole('img', { name: 'Error' })).toHaveClass('text-[#c94c27]');
    expect(within(card).getByRole('img', { name: 'Warning' })).toHaveClass('text-[#e8572e]');
    expect(within(card).getByRole('img', { name: 'Info' })).toHaveClass('text-[var(--muted)]');
    expect(within(card).getByRole('button', { name: /error on 1/ })).toHaveTextContent(
      'ts [Ln 1, Col 1]',
    );
  });

  it('maximizes with the theme’s ⛶, pressed while maximized, and closes with the 28px ✕', async () => {
    const user = userEvent.setup();
    act(() => useLayoutStore.getState().showPanel('problems'));
    renderWithQuery(<BottomPanel projectId={P} />);
    const maximize = screen.getByRole('button', { name: 'Maximize panel' });
    expect(maximize).toHaveTextContent('⛶');
    expect(maximize).toHaveClass('h-7', 'w-7', 'rounded-[7px]');
    await user.click(maximize);
    expect(screen.getByRole('region', { name: 'Panel' })).toHaveClass('flex-1');
    expect(screen.getByRole('button', { name: 'Restore panel size' })).toHaveStyle({
      color: '#ef6b3f',
    });
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: false, panelMaximized: false });
  });
});
