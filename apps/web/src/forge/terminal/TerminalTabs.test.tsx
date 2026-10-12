import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { db, installMockServer, installMockSocket, renderWithQuery } from '../../test/app';
import { FakeTerminal } from '../../test/FakeTerminal';
import { useProcessEvents } from './process-events';
import { TerminalPanel } from './TerminalPanel';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return <TerminalPanel projectId={projectId} />;
}

async function open(): Promise<string> {
  const projectId = db.createProject({ name: 'Shop' }).id;
  renderWithQuery(<Harness projectId={projectId} />);
  await screen.findByTestId('terminal-screen');
  await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
  return projectId;
}

const tabs = () => within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab');

describe('D301 several terminal tabs', () => {
  it('New terminal opens another tab at its prompt, shows it and focuses it', async () => {
    const user = userEvent.setup();
    await open();
    expect(FakeTerminal.latest().focused).toBe(0);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(FakeTerminal.latest().plain()).toBe('~ $ ');
    await waitFor(() => expect(FakeTerminal.latest().focused).toBe(1));
    await user.click(tabs()[0] as HTMLElement);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(FakeTerminal.latest().focused).toBe(1));
  });

  it('is drawn as the editor’s tab strip: the active tab on the surface with the orange top edge', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    const [first, second] = tabs();
    expect(second?.parentElement).toHaveClass(
      'bg-[var(--surface)]',
      'shadow-[inset_0_2px_0_#ef6b3f]',
    );
    expect(first?.parentElement).toHaveClass('text-[var(--muted)]');
    expect(first?.parentElement).not.toHaveClass('shadow-[inset_0_2px_0_#ef6b3f]');
  });

  it('renames a tab by double-clicking its name', async () => {
    const user = userEvent.setup();
    await open();
    await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
    const input = screen.getByRole('textbox', { name: 'Rename Terminal 1' });
    await user.clear(input);
    await user.type(input, 'api{Enter}');
    expect(screen.getByRole('tab', { name: 'api' })).toBeInTheDocument();
  });

  it('closes an idle tab at once, and the neighbour shows', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Terminal 1']);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('closing a tab whose process runs asks "Stop <label>?"; Cancel keeps it, Stop and close stops it', async () => {
    const user = userEvent.setup();
    const stop = vi.spyOn(api(), 'stopProcess');
    await open();
    act(() => FakeTerminal.latest().type('serve\r'));
    await waitFor(() => expect(FakeTerminal.latest().plain()).toContain('listening on 3000'));

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    const asked = await screen.findByRole('dialog', { name: 'Stop Terminal 1?' });
    await user.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    const again = await screen.findByRole('dialog', { name: 'Stop Terminal 1?' });
    await user.click(within(again).getByRole('button', { name: 'Stop and close' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No terminal open.')).toBeInTheDocument();
    stop.mockRestore();
  });
});
