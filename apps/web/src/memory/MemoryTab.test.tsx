import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { seedMemory } from '../mocks/seeds-round5';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => stopSocket());

/** An agent (memory on unless told otherwise) and an input, then the Memory tab on `focus`. */
async function openMemory(options: { enabled?: boolean; focus?: 'agent' | 'input' } = {}) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const agent = createNode('agent', workflow.id, { x: 300, y: 0 });
  agent.name = 'Greeter';
  agent.config = {
    ...agent.config,
    memory: { enabled: options.enabled ?? true },
  } as typeof agent.config;
  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  db.commitGraph(workflow.id, [input, agent], []);

  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  const user = userEvent.setup();
  renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
  await screen.findByTestId('canvas');
  const focus = options.focus === 'input' ? input : agent;
  act(() => useSelectionStore.getState().setSelection([focus.id], []));
  // the sheet over the Canvas holds this tab; it is closed until the top bar opens it
  // the workspace menu's "Workflow panel" opens the sheet (D331)
  act(() => usePanelsStore.getState().openSheet());
  await user.click(screen.getByRole('tab', { name: 'Memory' }));
  return { agent, input, user };
}

describe('TC-MEM-002 Memory tab: view, delete one, clear all, live updates', () => {
  it('lists key, value, created and last used for the focused agent', async () => {
    const { agent } = await openMemory();
    expect(await screen.findByTestId('memory-empty')).toHaveTextContent(/nothing remembered yet/i);

    // a run (or anything) saving facts announces memory.updated; the tab follows without reload
    act(() => {
      seedMemory(db, agent.id, [
        { key: 'user_name', value: 'Ada' },
        { key: 'city', value: 'Lyon' },
      ]);
    });
    const row = await screen.findByTestId('memory-entry-user_name');
    expect(within(row).getByTestId('memory-value')).toHaveTextContent('Ada');
    expect(within(row).getByTestId('memory-last-used')).toHaveTextContent('—');
    expect(screen.getByTestId('memory-entry-city')).toBeInTheDocument();
    const headers = within(screen.getByTestId('memory-table'))
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers.slice(0, 4)).toEqual(['Key', 'Value', 'Created', 'Last used']);
  });

  it('delete one asks first; cancel keeps it, confirm removes only that entry', async () => {
    const { agent, user } = await openMemory();
    act(() => {
      seedMemory(db, agent.id, [
        { key: 'user_name', value: 'Ada' },
        { key: 'city', value: 'Lyon' },
      ]);
    });
    await user.click(await screen.findByTestId('memory-delete-user_name'));
    const dialog = await screen.findByTestId('memory-confirm');
    expect(dialog).toHaveTextContent('Delete “user_name”?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(db.memoryOf(agent.id)).toHaveLength(2);

    await user.click(screen.getByTestId('memory-delete-user_name'));
    await user.click(await screen.findByTestId('memory-confirm-delete'));
    await waitFor(() =>
      expect(screen.queryByTestId('memory-entry-user_name')).not.toBeInTheDocument(),
    );
    expect(db.memoryOf(agent.id).map((entry) => entry.key)).toEqual(['city']);
    expect(screen.getByTestId('memory-entry-city')).toBeInTheDocument();
  });

  it('clear all asks first, then empties the engine and the table', async () => {
    const { agent, user } = await openMemory();
    act(() => {
      seedMemory(db, agent.id, [
        { key: 'user_name', value: 'Ada' },
        { key: 'city', value: 'Lyon' },
      ]);
    });
    await user.click(await screen.findByTestId('memory-clear-all'));
    const dialog = await screen.findByTestId('memory-confirm');
    expect(dialog).toHaveTextContent('Clear all memory?');
    expect(dialog).toHaveTextContent('forgets all 2 remembered facts');
    await user.click(within(dialog).getByTestId('memory-confirm-delete'));
    expect(await screen.findByTestId('memory-empty')).toBeInTheDocument();
    expect(db.memoryOf(agent.id)).toEqual([]);
  });

  it('a memory.updated for another node leaves this list alone', async () => {
    const { agent, input } = await openMemory();
    act(() => seedMemory(db, agent.id, [{ key: 'user_name', value: 'Ada' }]));
    await screen.findByTestId('memory-entry-user_name');
    act(() => seedMemory(db, input.id, [{ key: 'other', value: 'x' }]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('memory-entry-other')).not.toBeInTheDocument();
  });
});

describe('FR-MEM-004 Memory tab explains when there is nothing to show', () => {
  it('a non-agent node says memory belongs to agents', async () => {
    await openMemory({ focus: 'input' });
    expect(await screen.findByTestId('memory-tab-not-agent')).toHaveTextContent(
      /memory is kept by agent nodes/i,
    );
  });

  it('an agent with memory off says so, and still shows what it kept', async () => {
    const { agent } = await openMemory({ enabled: false });
    expect(await screen.findByTestId('memory-disabled')).toHaveTextContent(/memory is off/i);
    act(() => seedMemory(db, agent.id, [{ key: 'user_name', value: 'Ada' }]));
    expect(await screen.findByTestId('memory-entry-user_name')).toBeInTheDocument();
  });
});
