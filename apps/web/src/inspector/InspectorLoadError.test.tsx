import { allowedRunActions, zeroUsage, type Run } from '@ace/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../app/api';
import { useSelectionStore } from '../app/stores/selection';
import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient } from '../test/app';
import { Inspector } from './Inspector';

installMockServer();

afterEach(() => vi.restoreAllMocks());

describe('[audit W-11] the Inspector when the run’s records cannot be read', () => {
  it('says the read failed and offers Retry — never "has not run yet"', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const node = createNode('agent', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [node], []);
    const run: Run = {
      id: newId(),
      workflowId: workflow.id,
      projectId: project.id,
      status: 'COMPLETE',
      allowedActions: allowedRunActions('COMPLETE'),
      snapshot: { version: 1, nodes: [node], edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: zeroUsage(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    db.addRun(run);
    const read = vi
      .spyOn(api(), 'listNodeRuns')
      .mockRejectedValueOnce(new Error('The engine is not answering.'));
    act(() => useSelectionStore.getState().setSelection([node.id], []));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[`/projects/${project.id}/workflows/${workflow.id}?run=${run.id}`]}
        >
          <Inspector workflowId={workflow.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const alert = await screen.findByTestId('inspector-load-error');
    expect(alert).toHaveTextContent('The engine is not answering.');
    expect(screen.queryByText('This node has not run yet.')).toBeNull();

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('inspector-load-error')).toBeNull());
    expect(read).toHaveBeenCalledTimes(2);
    // read again, the run has no record for this node: now that is what it says
    expect(await screen.findByText('This node has not run yet.')).toBeInTheDocument();
  });
});
