import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { useLayoutStore } from '../../app/stores/layout';
import { MOCK_MESSAGES } from '../../mocks/processes';
import {
  db,
  installMockServer,
  installMockSocket,
  processes,
  renderApp,
  renderWithQuery,
} from '../../test/app';
import { FakeSearchAddon, FakeTerminal } from '../../test/FakeTerminal';
import { setThemeMode } from '../../theme/mode';
import { BottomPanel } from '../panel/BottomPanel';
import { requestTerminalFocus } from './focus';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';
import { useTerminalStore } from './terminal-store';
import { terminalTheme } from './xterm-theme';

installMockServer();
installMockSocket();
afterEach(() => setThemeMode('light'));

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(): Promise<string> {
  const projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, { 'src/app.ts': 'export {};\n', 'src/deep/x.ts': '' });
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  return projectId;
}

const term = () => FakeTerminal.latest();
const shown = () => term().plain();
const type = (data: string) => act(() => term().type(data));

describe('D301 a terminal tab runs what is typed', () => {
  it('shows a prompt at the project root', async () => {
    await open();
    expect(shown()).toBe('~ $ ');
  });

  it('typing echo hi and Enter starts it in the tab’s folder, shows its output and prompts again', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open();
    type('echo hi');
    expect(shown()).toBe('~ $ echo hi');
    type('\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo hi\nhi\n~ $ '));
    expect(start).toHaveBeenCalledWith(projectId, { command: 'echo hi', cwd: '' });
    start.mockRestore();
  });

  it('what is typed while it runs goes to its stdin', async () => {
    await open();
    type('ask\r');
    await waitFor(() => expect(shown()).toContain('name? '));
    type('Ada\r');
    await waitFor(() => expect(shown()).toBe('~ $ ask\nname? Ada\nhello Ada\n~ $ '));
  });

  it('Ctrl+C stops what runs, and the tab says how it ended', async () => {
    const stop = vi.spyOn(api(), 'stopProcess');
    await open();
    type('serve\r');
    await waitFor(() => expect(shown()).toContain('listening on 3000'));
    type('\u0003');
    // Apart: a 500 ms `serve` tick can land between the echoed ^C and the stop.
    await waitFor(() => expect(shown()).toMatch(/\[stopped \(SIGKILL\)\]\n~ \$ $/));
    expect(shown()).toContain('^C');
    expect(stop).toHaveBeenCalledTimes(1);
    stop.mockRestore();
  });

  it('Ctrl+C with nothing running clears the line and asks nothing of the engine', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    await open();
    type('oops\u0003');
    await waitFor(() => expect(shown()).toBe('~ $ oops^C\n~ $ '));
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('cd moves the prompt and the next command’s folder; cd .. stops at the root; a missing folder says why', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open();
    type('cd src\r');
    await waitFor(() => expect(shown().endsWith('\nsrc $ ')).toBe(true));
    type('echo here\r');
    await waitFor(() => expect(shown().endsWith('here\nsrc $ ')).toBe(true));
    expect(start).toHaveBeenCalledWith(projectId, { command: 'echo here', cwd: 'src' });
    type('cd\r');
    await waitFor(() => expect(shown().endsWith('src $ cd\nsrc\nsrc $ ')).toBe(true));
    type('cd ../..\r');
    await waitFor(() => expect(shown().endsWith('src $ cd ../..\n~ $ ')).toBe(true));
    type('cd nope\r');
    await waitFor(() => expect(shown()).toContain('cd: nope: nope was not found.'));
    expect(shown().endsWith('~ $ ')).toBe(true);
    start.mockRestore();
  });

  it('cls clears the screen and leaves a prompt', async () => {
    await open();
    type('echo a\r');
    await waitFor(() => expect(shown()).toContain('a\n~ $ '));
    type('cls\r');
    await waitFor(() => expect(shown()).toBe('~ $ '));
  });

  it('a refusal, a process that never started and an engine shutting down say so in the tab (design §10)', async () => {
    const projectId = await open();
    for (let i = 0; i < 8; i += 1) processes.start(projectId, { command: 'serve' });
    type('echo nine\r');
    await waitFor(() =>
      expect(shown()).toContain(
        'This project already runs 8 processes. Stop one before starting another.',
      ),
    );
    expect(shown().endsWith('~ $ ')).toBe(true);

    processes.stopProject(projectId);
    type('broken\r');
    await waitFor(() => expect(shown()).toContain('Could not start: spawn /bin/sh ENOENT'));
    await waitFor(() => expect(shown()).toMatch(/\[could not start\]\n~ \$ $/));

    // 503 engine_stopping, in the engine's words (Task 6's ruling; the mock's stopAll).
    processes.stopAll();
    type('echo late\r');
    await waitFor(() => expect(shown()).toContain(MOCK_MESSAGES.engine_stopping));
    expect(shown().endsWith('~ $ ')).toBe(true);
  });

  it('Ctrl+F finds in the scrollback', async () => {
    const user = userEvent.setup();
    await open();
    act(() => {
      expect(term().press({ key: 'f', ctrlKey: true })).toBe(false);
    });
    const find = await screen.findByRole('textbox', { name: 'Find in terminal' });
    await user.type(find, 'hello{Enter}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    const search = FakeSearchAddon.instances.at(-1);
    expect(search?.calls).toEqual([
      ['next', 'hello'],
      ['previous', 'hello'],
    ]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).toBeNull();
    expect(search?.cleared).toBe(1);
  });

  it('copies with Ctrl+C only when text is selected, and lets the browser paste', async () => {
    await open();
    expect(term().press({ key: 'c', ctrlKey: true })).toBe(true);
    expect(term().press({ key: 'v', ctrlKey: true })).toBe(false);
  });
});

describe('D301 D334 the Terminal in the theme', () => {
  it('sits in a surface card, in JetBrains Mono, coloured from the theme’s palettes, light and dark', async () => {
    await open();
    expect(screen.getByTestId('terminal-card')).toHaveClass(
      'rounded-[12px]',
      'border-[var(--line)]',
      'bg-[var(--surface)]',
    );
    expect(term().options['fontFamily']).toBe("'JetBrains Mono', monospace");
    expect(term().options['theme']).toEqual(terminalTheme('light'));
    act(() => setThemeMode('dark'));
    await waitFor(() => expect(term().options['theme']).toEqual(terminalTheme('dark')));
  });

  it('reads Terminal · Problems in the panel’s pill, and Terminal shows the terminal', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    useLayoutStore.setState({ panelOpen: true, panelTab: 'problems' });
    renderWithQuery(<BottomPanel projectId={projectId} />);
    const pill = screen.getByRole('tablist', { name: 'Panel views' });
    expect(pill).toHaveClass('rounded-full', 'bg-[var(--soft)]');
    const tabs = within(pill).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Terminal', 'Problems']);
    await user.click(tabs[0] as HTMLElement);
    expect(await screen.findByTestId('terminal-screen')).toBeInTheDocument();
    expect(useLayoutStore.getState().panelTab).toBe('terminal');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('D301 a terminal tab survives the panel and the mode (design §2.3, §11)', () => {
  it('keeps a half-typed line while the panel is hidden', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    useLayoutStore.setState({ panelOpen: true, panelTab: 'terminal' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('terminal-screen');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));

    type('ech');
    await user.keyboard('{Control>}j{/Control}');
    await user.keyboard('{Control>}j{/Control}');
    await screen.findByTestId('terminal-screen');
    type('o hi\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo hi\nhi\n~ $ '));
  });

  it('scrollback survives the panel being hidden and shown, Ideate ↔ Forge, and a switch to another workflow', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    const second = db.createWorkflow(project.id, 'Second');
    useLayoutStore.setState({ panelOpen: true, panelTab: 'terminal' });
    const { router } = renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('terminal-screen');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
    type('echo kept\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo kept\nkept\n~ $ '));

    await user.keyboard('{Control>}j{/Control}');
    expect(screen.queryByTestId('terminal-screen')).toBeNull();
    await user.keyboard('{Control>}j{/Control}');
    await screen.findByTestId('terminal-screen');
    expect(shown()).toBe('~ $ echo kept\nkept\n~ $ ');

    await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}');
    await screen.findByTestId('terminal-screen');
    expect(shown()).toBe('~ $ echo kept\nkept\n~ $ ');

    // Another workflow of the project. Forge has no workflow switcher: the workspace menu is the
    // Canvas breadcrumb's (D331), and the Canvas is mocked here. Its item navigates like this,
    // keeping the mode. The store is keyed by project, so Forge still shows the tab.
    await act(() => router.navigate(`/projects/${project.id}/workflows/${second.id}/forge`));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project.id}/workflows/${second.id}/forge`,
      ),
    );
    await screen.findByTestId('terminal-screen');
    expect(shown()).toBe('~ $ echo kept\nkept\n~ $ ');
  });
});

describe('D301 the Terminal takes the focus only when asked', () => {
  it('a plain mount, and Ctrl+J hiding and showing the panel, leave the focus alone', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'Shop' });
    const workflow = db.createWorkflow(project.id, 'Main');
    useLayoutStore.setState({ panelOpen: true, panelTab: 'terminal' });
    renderApp(`/projects/${project.id}/workflows/${workflow.id}/forge`);
    await screen.findByTestId('terminal-screen');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
    expect(term().focused).toBe(0);

    await user.keyboard('{Control>}j{/Control}');
    await user.keyboard('{Control>}j{/Control}');
    await screen.findByTestId('terminal-screen');
    // A request would have focused it by the next macrotask; let one pass, then check.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(term().focused).toBe(0);
  });

  it('a request (Ctrl+`, New terminal, a script button) focuses the view it opened, once', async () => {
    const projectId = await open();
    expect(term().focused).toBe(0);
    const before = FakeTerminal.instances.length;
    act(() => {
      requestTerminalFocus();
      useTerminalStore.getState().newTab(projectId);
    });
    expect(FakeTerminal.instances.length).toBe(before + 1);
    await waitFor(() => expect(term().focused).toBe(1));

    // The request is spent: going back to the first tab mounts a view that leaves the focus alone.
    const first = useTerminalStore.getState().projects[projectId]?.tabs[0]?.id ?? '';
    act(() => useTerminalStore.getState().activate(projectId, first));
    expect(FakeTerminal.instances.length).toBe(before + 2);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(term().focused).toBe(0);
  });

  it('a click on the panel’s Terminal pill focuses it', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    useLayoutStore.setState({ panelOpen: true, panelTab: 'problems' });
    renderWithQuery(<BottomPanel projectId={projectId} />);
    await user.click(screen.getByRole('tab', { name: 'Terminal' }));
    await screen.findByTestId('terminal-screen');
    await waitFor(() => expect(term().focused).toBe(1));
  });
});

describe('D301 rewrites reset inside the write stream, and typed-ahead input waits its turn', () => {
  it('a rewrite is one write that starts with ESC c, and never calls reset()', async () => {
    const projectId = await open();
    const reset = vi.spyOn(term(), 'reset');
    const write = vi.spyOn(term(), 'write');
    act(() => {
      useTerminalStore.getState().output(projectId, 'nope', 'x');
    });
    type('echo a\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo a\na\n~ $ '));
    write.mockClear();
    type('cls\r');
    await waitFor(() => expect(shown()).toBe('~ $ '));
    const rewrites = write.mock.calls.filter(([data]) => String(data).startsWith('\u001bc'));
    expect(rewrites.length).toBeGreaterThan(0);
    expect(reset).not.toHaveBeenCalled();
  });

  it('input typed ahead, before the start has returned, reaches the process', async () => {
    await open();
    type('ask\r');
    type('Ada\r');
    await waitFor(() => expect(shown()).toContain('hello Ada'));
  });

  it('after a theme switch, the view of another project (same tab id) wears the current theme', async () => {
    const first = db.createProject({ name: 'Shop' }).id;
    const second = db.createProject({ name: 'Other' }).id;
    let pick: (id: string) => void = () => undefined;
    function Switch() {
      const [id, setId] = useState(first);
      pick = setId;
      return <Harness projectId={id} />;
    }
    useTerminalStore.getState().newTab(second);
    renderWithQuery(<Switch />);
    await screen.findByTestId('terminal-screen');
    act(() => setThemeMode('dark'));
    await waitFor(() => expect(term().options['theme']).toEqual(terminalTheme('dark')));
    act(() => pick(second));
    await waitFor(() => expect(useTerminalStore.getState().projects[second]).toBeDefined());
    await waitFor(() => expect(term().options['theme']).toEqual(terminalTheme('dark')));
    expect(FakeTerminal.instances.length).toBeGreaterThan(1);
  });
});

describe('D301 a line typed ahead with nothing attached runs, never dropped (design §10)', () => {
  const lineOf = (projectId: string) =>
    useTerminalStore.getState().projects[projectId]?.tabs[0]?.line;

  it('a pasted cd src⏎echo hi⏎ moves into src, then runs echo hi there', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open();
    type('cd src\recho hi\r');
    await waitFor(() => expect(shown()).toBe('~ $ cd src\necho hi\nsrc $ echo hi\nhi\nsrc $ '));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(projectId, { command: 'echo hi', cwd: 'src' });
    expect(lineOf(projectId)?.busy).toBe(false);
    expect(lineOf(projectId)?.history).toEqual(['cd src', 'echo hi']);
    start.mockRestore();
  });

  it('after a refused start, the next line typed ahead runs', async () => {
    const projectId = await open();
    const serving = Array.from(
      { length: 8 },
      () => processes.start(projectId, { command: 'serve' }).processId,
    );
    const original = api().startProcess.bind(api());
    const start = vi.spyOn(api(), 'startProcess').mockImplementationOnce(async (id, request) => {
      try {
        return await original(id, request);
      } finally {
        // Refused: eight already run. One of them ends, so the next start has room.
        processes.stop(id, serving[0] ?? '');
      }
    });
    type('echo nine\recho ten\r');
    await waitFor(() =>
      expect(shown()).toBe(
        `~ $ echo nine\necho ten\n${MOCK_MESSAGES.process_limit}\n~ $ echo ten\nten\n~ $ `,
      ),
    );
    expect(start).toHaveBeenLastCalledWith(projectId, { command: 'echo ten', cwd: '' });
    expect(lineOf(projectId)?.busy).toBe(false);
    start.mockRestore();
  });

  it('a line typed ahead of a command that ended on its own runs next', async () => {
    const projectId = await open();
    const original = api().startProcess.bind(api());
    const start = vi.spyOn(api(), 'startProcess').mockImplementationOnce(async (id, request) => {
      const answer = await original(id, request);
      // It ends before its start is answered: the tab attaches a process that has already ended.
      await vi.waitFor(() =>
        expect(useTerminalStore.getState().unowned[answer.processId]?.exit).toBeDefined(),
      );
      return answer;
    });
    type('echo a\recho b\r');
    await waitFor(() => expect(shown()).toBe('~ $ echo a\necho b\na\n~ $ echo b\nb\n~ $ '));
    expect(start).toHaveBeenLastCalledWith(projectId, { command: 'echo b', cwd: '' });
    expect(lineOf(projectId)?.busy).toBe(false);
    start.mockRestore();
  });
});
