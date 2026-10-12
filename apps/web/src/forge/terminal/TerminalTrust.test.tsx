import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, queryClient } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

const PACKAGE = JSON.stringify({ scripts: { hello: 'echo hi from a script' } });

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(trust: 'on' | 'scripts' | 'off'): Promise<string> {
  const project = db.createProject({ name: 'Shop' });
  db.updateProject(project.id, { terminal: trust });
  db.seedFiles(project.id, { 'package.json': PACKAGE });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Harness projectId={project.id} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  return project.id;
}

const scriptButton = async (name: string) =>
  within(await screen.findByRole('group', { name: 'Scripts' })).findByRole('button', { name });

describe('D301 the Terminal follows the project’s trust level', () => {
  it('off: says so in a help line with a link to the project, and neither typing, New terminal nor a script does anything', async () => {
    const start = vi.spyOn(api(), 'startProcess');
    const projectId = await open('off');

    const notice = await screen.findByTestId('terminal-trust-notice');
    expect(notice).toHaveTextContent('The terminal is off for this project.');
    expect(notice).toHaveClass('text-[11px]', 'text-[var(--muted)]');
    expect(within(notice).getByRole('link')).toHaveAttribute('href', `/projects/${projectId}`);
    await waitFor(() => expect(FakeTerminal.latest().options['disableStdin']).toBe(true));

    act(() => FakeTerminal.latest().type('echo hi\r'));
    expect(FakeTerminal.latest().plain()).toBe('~ $ ');
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(await scriptButton('hello')).toBeDisabled();
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('scripts: says so; a typed command prints the refusal in the tab, and a script still runs', async () => {
    const user = userEvent.setup();
    await open('scripts');
    expect(await screen.findByTestId('terminal-trust-notice')).toHaveTextContent(
      'This project runs only its own package.json scripts here.',
    );

    act(() => FakeTerminal.latest().type('echo hi\r'));
    await waitFor(() =>
      expect(FakeTerminal.latest().plain()).toContain(
        "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
      ),
    );
    expect(FakeTerminal.latest().plain().endsWith('~ $ ')).toBe(true);

    const hello = await scriptButton('hello');
    expect(hello).toBeEnabled();
    await user.click(hello);
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('hi from a script'));
  });

  it('on: no notice, and typing runs', async () => {
    await open('on');
    expect(screen.queryByTestId('terminal-trust-notice')).toBeNull();
    act(() => FakeTerminal.latest().type('echo hi\r'));
    await waitFor(() => expect(FakeTerminal.latest().plain()).toBe('~ $ echo hi\nhi\n~ $ '));
  });
});
