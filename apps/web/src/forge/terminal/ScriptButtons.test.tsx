import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import {
  db,
  installMockServer,
  installMockSocket,
  queryClient,
  renderWithQuery,
} from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { processKeys } from './hooks';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

describe('D301 script buttons run the project’s own scripts', () => {
  it('runs a script in a new tab named after it, as <pm> run <name>', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    db.seedFiles(projectId, {
      'package.json': JSON.stringify({
        packageManager: 'pnpm@9.15.9',
        scripts: { hello: 'echo hi from a script', dev: 'serve' },
      }),
    });
    renderWithQuery(<Harness projectId={projectId} />);
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));

    const scripts = await screen.findByRole('group', { name: 'Scripts' });
    const buttons = within(scripts).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName('hello');
    expect(buttons[1]).toHaveAccessibleName('dev');
    // the kit's secondary pill (D328)
    expect(buttons[0]).toHaveClass('rounded-full', 'bg-[var(--soft)]');

    await user.click(within(scripts).getByRole('button', { name: 'hello' }));
    expect(await screen.findByRole('tab', { name: 'hello' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(FakeTerminal.latest().plain()).toBe(
        '~ $ pnpm run hello\n\n> hello\n> echo hi from a script\n\nhi from a script\n~ $ ',
      ),
    );
    expect(FakeTerminal.latest().focused).toBe(1);
  });

  it('shows no script buttons when package.json has no scripts', async () => {
    const projectId = db.createProject({ name: 'Shop' }).id;
    renderWithQuery(<Harness projectId={projectId} />);
    await screen.findByTestId('terminal-screen');
    // The scripts have arrived (none): only now does "no group" mean something.
    await waitFor(() =>
      expect(queryClient.getQueryState(processKeys.scripts(projectId))?.status).toBe('success'),
    );
    expect(screen.queryByRole('group', { name: 'Scripts' })).toBeNull();
  });
});
