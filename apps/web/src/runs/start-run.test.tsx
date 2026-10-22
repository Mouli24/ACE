import { allowedRunActions, zeroUsage, type Run } from '@ace/contracts';
import { toast } from '@ace/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { api } from '../app/api';
import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient } from '../test/app';
import { useStartRun } from './hooks';
import { useRunStore } from './run-store';

installMockServer();

afterEach(() => {
  useRunStore.getState().reset();
  vi.restoreAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

/** A finished run of a one-node workflow, on screen in the overlay. */
function finishedRunOnScreen() {
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
  useRunStore.getState().adopt(workflow.id, run, []);
  return { workflow, run };
}

describe('[audit W-1] a start the engine refuses', () => {
  it('puts back the run that was on screen and says why', async () => {
    const { workflow, run } = finishedRunOnScreen();
    vi.spyOn(api(), 'startRun').mockRejectedValue(new Error('A run of this workflow is going.'));
    const error = vi.spyOn(toast, 'error');
    const { result } = renderHook(() => useStartRun(workflow.id), { wrapper });

    act(() => result.current.mutate({}));
    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(useRunStore.getState().runId).toBe(run.id));
    expect(useRunStore.getState().status).toBe('COMPLETE');
    expect(useRunStore.getState().active).toBe(false);
    expect(error).toHaveBeenCalledWith('Could not start the run', {
      description: 'A run of this workflow is going.',
    });
  });

  it('quiet: the caller says why, so no toast — the run still comes back', async () => {
    const { workflow, run } = finishedRunOnScreen();
    vi.spyOn(api(), 'startRun').mockRejectedValue(new Error('refused'));
    const error = vi.spyOn(toast, 'error');
    const { result } = renderHook(() => useStartRun(workflow.id, { quiet: true }), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({}).catch(() => undefined);
    });
    await waitFor(() => expect(useRunStore.getState().runId).toBe(run.id));
    expect(error).not.toHaveBeenCalled();
  });

  it('with nothing on screen before, the overlay is simply cleared', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    vi.spyOn(api(), 'startRun').mockRejectedValue(new Error('refused'));
    vi.spyOn(toast, 'error').mockImplementation(() => 0);
    const { result } = renderHook(() => useStartRun(workflow.id), { wrapper });

    act(() => result.current.mutate({}));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(useRunStore.getState().runId).toBeUndefined();
    expect(useRunStore.getState().active).toBe(false);
  });
});
