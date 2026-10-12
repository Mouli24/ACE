import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import { dropMockSockets } from '../../mocks/fake-socket';
import { db, installMockServer, installMockSocket, processes, queryClient } from '../../test/app';
import { processKeys } from './hooks';
import { busyLine } from './line-discipline';
import { reattach, useProcessEvents } from './process-events';
import { LOST_NOTE, scrollbackOf, useTerminalStore } from './terminal-store';

installMockServer();
installMockSocket();

function Harness({ projectId }: { projectId: string }) {
  useProcessEvents(projectId);
  return null;
}

const mount = (projectId: string) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Harness projectId={projectId} />
    </QueryClientProvider>,
  );

const store = () => useTerminalStore.getState();

const shown = (projectId: string): string => {
  const tab = store().projects[projectId]?.tabs[0];
  return tab === undefined ? '' : scrollbackOf(tab);
};

/** A tab attached to a process, as a start from the tab would leave it. */
function attachedTab(projectId: string, processId: string): string {
  const tabId = store().newTab(projectId);
  const tab = store().projects[projectId]?.tabs[0];
  if (tab !== undefined) store().setLine(projectId, tabId, busyLine(tab.line));
  store().attach(projectId, tabId, processId);
  return tabId;
}

/**
 * The socket is open. Its `onopen` reports `open` and re-sends every subscription in one
 * synchronous step, so by the time this sees `open` the project scope is subscribed.
 */
const socketOpen = () =>
  vi.waitFor(() => expect(getSocket()?.status).toBe('open'), { timeout: 5_000 });

describe('D301 process frames reach the tab that owns the process', () => {
  it('folds the output and the end into the owning tab', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    const { processId } = processes.start(projectId, { command: 'echo hello' });
    attachedTab(projectId, processId);
    await vi.waitFor(() => expect(shown(projectId)).toBe('~ $ hello\n~ $ '));
  });

  it('keeps the output of a process no tab owns, for the Processes list', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    const { processId } = processes.start(projectId, { command: 'serve' });
    await vi.waitFor(() =>
      expect(store().unowned[processId]?.output).toContain('listening on 3000'),
    );
    processes.stop(projectId, processId);
  });

  it("a re-attach replaces the tab's output with the engine's copy, once", async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    // It prints while nobody watches: as in Ideate, or with the socket down.
    const { processId } = processes.start(projectId, { command: 'serve' });
    await vi.waitFor(() =>
      expect(processes.get(projectId, processId).output).toContain('listening on 3000'),
    );
    attachedTab(projectId, processId);
    expect(shown(projectId)).toBe('~ $ ');

    mount(projectId);
    await vi.waitFor(() =>
      expect(shown(projectId).startsWith('~ $ listening on 3000\n')).toBe(true),
    );

    // The engine went away and came back: hello re-attaches again, and nothing doubles.
    const before = store().projects[projectId]?.tabs[0]?.epoch ?? 0;
    act(() => dropMockSockets());
    await vi.waitFor(() => expect(getSocket()?.status).toBe('reconnecting'));
    await socketOpen();
    await vi.waitFor(() =>
      expect(store().projects[projectId]?.tabs[0]?.epoch).toBeGreaterThan(before),
    );
    expect(shown(projectId).match(/listening on 3000/g)).toHaveLength(1);
    processes.stop(projectId, processId);
  });

  it('a process that ended while nobody looked ends the tab’s run on re-attach', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    const { processId } = processes.start(projectId, { command: 'echo hello' });
    await vi.waitFor(() => expect(processes.get(projectId, processId).status).toBe('exited'));
    attachedTab(projectId, processId);

    mount(projectId);
    await vi.waitFor(() => expect(shown(projectId)).toBe('~ $ hello\n~ $ '));
    expect(store().projects[projectId]?.tabs[0]?.processId).toBeUndefined();
  });

  it('two overlapping re-attaches of a finished process leave nothing stale behind', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    const { processId } = processes.start(projectId, { command: 'echo hello' });
    await vi.waitFor(() => expect(processes.get(projectId, processId).status).toBe('exited'));
    attachedTab(projectId, processId);

    // On entering Forge and on hello, both at once: the second finds no owner and does nothing.
    await Promise.all([reattach(projectId, queryClient), reattach(projectId, queryClient)]);

    expect(shown(projectId)).toBe('~ $ hello\n~ $ ');
    expect(store().unowned[processId]).toBeUndefined();
  });

  it("a process the engine no longer knows ends the tab's run with a note", async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    attachedTab(projectId, '01J9ZZZZZZZZZZZZZZZZZZZZZZ');

    mount(projectId);
    await vi.waitFor(() => expect(shown(projectId)).toBe(`~ $ \r\n${LOST_NOTE}~ $ `));
    expect(store().projects[projectId]?.tabs[0]?.processId).toBeUndefined();
  });

  it('a re-attach of one process redraws only its own tab', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    const one = processes.start(projectId, { command: 'serve' }).processId;
    const two = processes.start(projectId, { command: 'serve' }).processId;
    attachedTab(projectId, one);
    attachedTab(projectId, two);
    const epochs = () => store().projects[projectId]?.tabs.map((tab) => tab.epoch) ?? [];
    const [first, second] = epochs();
    await reattach(projectId, queryClient, two);
    expect(epochs()).toEqual([first, (second ?? 0) + 1]);
    processes.stopProject(projectId);
  });

  it('refreshes the scripts when package.json changes on disk', async () => {
    const projectId = db.createProject({ name: 'P' }).id;
    mount(projectId);
    await socketOpen();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => db.writeFileExternally(projectId, 'package.json', '{"scripts":{"dev":"serve"}}'));
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: processKeys.scripts(projectId) }),
    );
    invalidate.mockRestore();
  });
});
