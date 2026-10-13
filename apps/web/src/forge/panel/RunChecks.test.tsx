import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import {
  db,
  installMockServer,
  installMockSocket,
  processes,
  renderApp,
  server,
} from '../../test/app';
import { useEditorStore } from '../editor/editor-store';
import { useTerminalStore } from '../terminal/terminal-store';
import { useProblemsStore } from './problems-store';

installMockServer();
installMockSocket();

const TSC = 'echo src/app.ts(2,3): error TS2322: Type is wrong.';

/** Forge for a new project, with the Problems panel open. */
function openForge(project: { checkCommand?: string; terminal?: 'on' | 'scripts' | 'off' } = {}) {
  const created = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(created.id, 'Main');
  db.seedFiles(created.id, { 'src/app.ts': 'export {};\nconst x: number = "a";\n' });
  if (Object.keys(project).length > 0) db.updateProject(created.id, project);
  act(() => useLayoutStore.setState({ panelOpen: true, panelTab: 'problems' }));
  renderApp(`/projects/${created.id}/workflows/${workflow.id}/forge`);
  return created.id;
}

describe('D299 Phase 4 Run checks in the Problems panel', () => {
  it('reads "Set a check command" and goes to the project page while none is set', async () => {
    const projectId = openForge();
    const link = await screen.findByTestId('set-check-command');
    expect(link).toHaveTextContent('Set a check command');
    expect(link).toHaveAttribute('href', `/projects/${projectId}`);
    expect(screen.queryByTestId('run-checks')).toBeNull();
  });

  it('runs the command, then lists what it found under Checks with its tool and time; a row opens the file', async () => {
    const user = userEvent.setup();
    const projectId = openForge({ checkCommand: TSC });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const group = await screen.findByRole('region', { name: 'Checks' });
    const row = await within(group).findByRole('button', { name: /Type is wrong\./ });
    expect(row).toHaveTextContent('tsc(TS2322) [Ln 2, Col 3]');
    expect(within(group).getByTestId('checks-sources')).toHaveTextContent('tsc');
    expect(within(group).getByTestId('checks-time')).toHaveTextContent(
      /Just now · \d+\.\d s · exit 0/,
    );
    // the process is in the Terminal's list like any other
    expect(processes.list(projectId)[0]).toMatchObject({ label: 'Checks', status: 'exited' });
    // the footer and the panel count it
    expect(screen.getByTestId('footer-problems')).toHaveAccessibleName('1 error, 0 warnings');
    expect(screen.getByTestId('problems-count')).toHaveTextContent('1');

    await user.click(row);
    expect(useEditorStore.getState().projects[projectId]).toMatchObject({
      active: 'src/app.ts',
      reveal: { path: 'src/app.ts', line: 2, column: 3 },
    });
  });

  it('Clear empties the checks, and the markers never overwrite them', async () => {
    const user = userEvent.setup();
    const projectId = openForge({ checkCommand: TSC });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole('region', { name: 'Checks' });

    act(() => useProblemsStore.setState({ byProject: { [projectId]: [] } }));
    expect(screen.getByRole('region', { name: 'Checks' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Checks' })).toBeNull();
    expect(screen.getByTestId('footer-problems')).toHaveAccessibleName('0 errors, 0 warnings');
  });

  it('with the terminal off, Run checks is disabled and Problems shows the trust notice', async () => {
    openForge({ checkCommand: TSC, terminal: 'off' });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(screen.getByTestId('terminal-trust-notice')).toBeInTheDocument());
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'The terminal is off for this project');
  });

  it('under scripts, a typed command shows the engine’s refusal in the Checks group', async () => {
    const user = userEvent.setup();
    openForge({ checkCommand: 'pnpm tsc --noEmit', terminal: 'scripts' });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const group = await screen.findByRole('region', { name: 'Checks' });
    expect(within(group).getByRole('alert')).toHaveTextContent(
      /only its own package\.json scripts/,
    );
  });

  it('Ctrl/⌘+Shift+B opens Problems and runs the checks', async () => {
    const user = userEvent.setup();
    const projectId = openForge({ checkCommand: TSC });
    act(() => useLayoutStore.setState({ panelOpen: false }));
    await screen.findByRole('tree', { name: 'Files of Shop' });
    await waitFor(() => expect(db.getProject(projectId)?.checkCommand).toBe(TSC));

    await user.keyboard('{Control>}{Shift>}b{/Shift}{/Control}');
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'problems' });
    expect(await screen.findByRole('region', { name: 'Checks' })).toBeInTheDocument();
    // Ctrl+B alone still toggles the side bar, and Ctrl+Alt+B the chat
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });
});

describe('D299 Phase 4 fix I2: a failed run never reads as a clean one', () => {
  it('a non-zero exit with nothing recognised says the checks failed, with its exit code and Show output', async () => {
    const user = userEvent.setup();
    const projectId = openForge({ checkCommand: 'fail' });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const group = await screen.findByRole('region', { name: 'Checks' });
    expect(
      await within(group).findByText(
        'Checks failed (exit 1); no problems recognised in the output',
      ),
    ).toBeInTheDocument();
    expect(within(group).queryByText(/No problems found/)).toBeNull();
    expect(within(group).getByTestId('checks-time')).toHaveTextContent('exit 1');

    await user.click(within(group).getByRole('button', { name: 'Show output' }));
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: 'terminal' });
    // a tab of its own, named for the process, showing what it printed
    await waitFor(() => {
      const tabs = useTerminalStore.getState().projects[projectId]?.tabs ?? [];
      expect(tabs.map((tab) => tab.label)).toContain('Checks');
    });
    expect(processes.list(projectId)[0]?.label).toBe('Checks');
  });

  it('a clean exit with nothing found still says so, with exit 0', async () => {
    const user = userEvent.setup();
    openForge({ checkCommand: 'echo all good' });
    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const group = await screen.findByRole('region', { name: 'Checks' });
    expect(await within(group).findByText(/No problems found by/)).toBeInTheDocument();
    expect(within(group).getByTestId('checks-time')).toHaveTextContent('exit 0');
  });
});

describe('D299 Phase 4 fix Minor 6: following a run stops when Forge goes', () => {
  it('stops asking the engine about a run that never ends once Forge unmounts', async () => {
    const user = userEvent.setup();
    const created = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(created.id, 'Main');
    db.updateProject(created.id, { checkCommand: 'serve' });
    act(() => useLayoutStore.setState({ panelOpen: true, panelTab: 'problems' }));
    const { router } = renderApp(`/projects/${created.id}/workflows/${workflow.id}/forge`);
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && /\/processes\/[0-9A-HJKMNP-TV-Z]{26}$/.test(path)) {
        asked.push(path);
      }
    });

    const button = await screen.findByTestId('run-checks');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    // a run that never exits: Run checks follows it, asking about it every second
    await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });

    await act(() => router.navigate(`/projects/${created.id}`));
    await screen.findByTestId('project-checks-card');
    const before = asked.length;
    await new Promise((settle) => setTimeout(settle, 2_500));
    expect(asked.length).toBe(before);
    // and it says so, rather than running forever in Problems
    expect(useProblemsStore.getState().checks[created.id]?.status).not.toBe('running');
    processes.stopProject(created.id);
  }, 15_000);
});
