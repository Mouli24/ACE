import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import {
  db,
  installMockServer,
  installMockSocket,
  processes,
  renderWithQuery,
} from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(projectId: string) {
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  return screen.getByRole('region', { name: 'Processes' });
}

describe('D301 the Processes list', () => {
  it('lists running processes with Stop, and finished ones with how they ended, in one surface card', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    const done = processes.start(projectId, { command: 'echo a' }).processId;
    const failed = processes.start(projectId, { command: 'fail' }).processId;
    await vi.waitFor(() => expect(processes.get(projectId, failed).status).toBe('exited'));
    const serve = processes.start(projectId, { command: 'serve', label: 'dev server' }).processId;

    const list = await open(projectId);
    await within(list).findByText('dev server');
    expect(within(list).getByRole('list')).toHaveClass(
      'rounded-[12px]',
      'border-[var(--line)]',
      'bg-[var(--surface)]',
    );
    expect(within(list).getByTestId(`process-${done}`)).toHaveTextContent('exit 0');
    expect(within(list).getByTestId(`process-${failed}`)).toHaveTextContent('exit 1');

    await user.click(within(list).getByRole('button', { name: 'Stop dev server' }));
    await waitFor(() =>
      expect(within(list).getByTestId(`process-${serve}`)).toHaveTextContent('stopped'),
    );
  });

  it('says so when nothing has run', async () => {
    const projectId = db.createProject({ name: 'Shop' }).id;
    const list = await open(projectId);
    expect(await within(list).findByText('Nothing has run yet.')).toBeInTheDocument();
  });

  it('shows the latest line of a process no tab owns, and Show opens it in a tab with what it printed', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    const list = await open(projectId);
    const serve = processes.start(projectId, { command: 'serve' }).processId;

    await waitFor(() =>
      expect(within(list).getByTestId(`process-${serve}`)).toHaveTextContent('listening on 3000'),
    );
    await user.click(within(list).getByRole('button', { name: 'Show serve' }));
    expect(await screen.findByRole('tab', { name: 'serve' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('listening on 3000'));
    expect(within(list).queryByRole('button', { name: 'Show serve' })).toBeNull();
    processes.stop(projectId, serve);
  });
});
