import {
  allowedRunActions,
  zeroUsage,
  type HaltReason,
  type NodeError,
  type NodeState,
  type Run,
} from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { newId } from '../../lib/ulid';
import { createNode } from '../../nodes/factory';
import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, queryClient, renderApp, renderWithQuery } from '../../test/app';
import { HeaderRunControls } from './HeaderRunControls';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => act(() => useRunStore.getState().reset()));

function seed() {
  const project = db.createProject({ name: 'Shop' });
  const workflow = db.createWorkflow(project.id, 'Main');
  return { project, workflow, base: `/projects/${project.id}/workflows/${workflow.id}` };
}

function mount(workflowId: string) {
  renderWithQuery(
    <MemoryRouter>
      <HeaderRunControls workflowId={workflowId} />
    </MemoryRouter>,
  );
  return within(screen.getByRole('group', { name: 'Run controls' }));
}

/** The overlay as the engine would leave it for a run of this workflow. */
function holdRun(workflowId: string, status: 'RUNNING' | 'PAUSED', allowed: string[]) {
  act(() =>
    useRunStore.setState({
      workflowId,
      runId: '01RUN000000000000000000001',
      status,
      active: true,
      allowedActions: allowed as never,
    }),
  );
}

describe('PG-1.2 run controls in the workspace header (D360)', () => {
  it.each([
    ['Ideate', ''],
    ['Forge', '/forge'],
    ['Domain', '/domain'],
  ])('sit in the header in %s: Run, Pause, Stop, Restart', async (_mode, suffix) => {
    const { base } = seed();
    renderApp(`${base}${suffix}`);
    // the workspace header comes first; Domain draws a header of its own below it
    const [header] = await screen.findAllByRole('banner');
    const group = within(await within(header!).findByRole('group', { name: 'Run controls' }));
    for (const name of ['Run', 'Pause', 'Stop', 'Restart']) {
      expect(group.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('with no run, only Run is enabled — the others wait for a run that allows them', () => {
    const { workflow } = seed();
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Run' })).toBeEnabled();
    for (const name of ['Pause', 'Stop', 'Restart']) {
      expect(group.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('enables exactly what the run’s allowedActions names (FR-CTL-006); Run waits while one is active', () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(group.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(group.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(group.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('Pause reads Resume while the run allows resuming', () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'PAUSED', ['resume', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(group.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('another workflow’s run enables nothing here', () => {
    const { workflow } = seed();
    holdRun('01OTHERWORKFLOW00000000000', 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    expect(group.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(group.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('Stop asks first (FR-CTL-003)', async () => {
    const { workflow } = seed();
    holdRun(workflow.id, 'RUNNING', ['pause', 'stop']);
    const group = mount(workflow.id);
    await userEvent.click(group.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByTestId('stop-confirm')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByTestId('stop-confirm')).toBeNull());
  });
});

describe('D388 Continue a run that was cut off', () => {
  /** A halted run of two parallel agents, recorded as the engine leaves it: one node run each. */
  function haltedRun(haltReason: HaltReason, states: [NodeState, NodeState], error?: NodeError) {
    const { project, workflow } = seed();
    const a = createNode('agent', workflow.id, { x: 0, y: 0 });
    const b = createNode('agent', workflow.id, { x: 0, y: 300 });
    db.commitGraph(workflow.id, [a, b], []);
    const run: Run = {
      id: newId(),
      workflowId: workflow.id,
      projectId: project.id,
      status: 'HALTED',
      haltReason,
      allowedActions: allowedRunActions('HALTED'),
      snapshot: { version: 1, nodes: [a, b], edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: zeroUsage(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    db.addRun(run);
    for (const [node, status] of [
      [a, states[0]],
      [b, states[1]],
    ] as const) {
      db.upsertNodeRun({
        id: newId(),
        runId: run.id,
        nodeId: node.id,
        iteration: 1,
        attempt: 1,
        status,
        ...(status === 'BLOCKED' && error !== undefined ? { error } : {}),
        inputEnvelopes: [],
        usage: zeroUsage(),
        verdicts: [],
        toolCalls: [],
      });
    }
    return { workflow, run };
  }

  it('shows Continue, with what it does, for a stopped run with nodes cut off', async () => {
    const { workflow } = haltedRun('stopped', ['COMPLETED', 'STOPPED']);
    const group = mount(workflow.id);
    const button = await group.findByRole('button', { name: 'Continue' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('title', 'Run the nodes that were cut off; keep what finished');
  });

  it('shows Continue after a crash left an agentic step BLOCKED engine_restarted', async () => {
    const { workflow } = haltedRun('crash', ['COMPLETED', 'BLOCKED'], {
      kind: 'workflow',
      code: 'engine_restarted',
      message: 'The engine restarted under this step.',
      retryable: false,
    });
    const group = mount(workflow.id);
    expect(await group.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it.each<[string, HaltReason, [NodeState, NodeState]]>([
    ['a failure halt (that is a Retry of the failed node)', 'failure', ['COMPLETED', 'FAILED']],
    ['a budget halt (it would only halt again)', 'budget_exceeded', ['COMPLETED', 'STOPPED']],
    ['a stopped run where nothing was cut off', 'stopped', ['COMPLETED', 'COMPLETED']],
  ])('never offers it for %s', async (_what, haltReason, states) => {
    const { workflow } = haltedRun(haltReason, states);
    const group = mount(workflow.id);
    // the run is read: Restart, which a HALTED run allows, is enabled once it is
    await waitFor(() => expect(group.getByRole('button', { name: 'Restart' })).toBeEnabled());
    // …and whatever it reads to decide (the node runs, for a stopped run) has been answered
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(group.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('a click continues the same run; once it runs again, Continue goes', async () => {
    const { workflow, run } = haltedRun('stopped', ['COMPLETED', 'STOPPED']);
    const group = mount(workflow.id);
    await userEvent.click(await group.findByRole('button', { name: 'Continue' }));
    // the mock engine reopened the same run and made a second attempt of the stopped node
    await waitFor(() => expect(db.getRun(run.id)?.status).not.toBe('HALTED'));
    expect(db.listNodeRuns(run.id).filter((row) => row.attempt === 2)).toHaveLength(1);
    await waitFor(() => expect(group.queryByRole('button', { name: 'Continue' })).toBeNull());
  });
});
