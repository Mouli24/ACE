import type { Edge, Node } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { useSelectionStore } from '../app/stores/selection';
import { createFakeWebSocket, dropMockSockets } from '../mocks/fake-socket';
import { setScenario } from '../mocks/handlers-round2';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { useRunStore } from './run-store';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => {
  stopSocket();
  useRunStore.getState().reset();
});

/** Input → Agent → Output on the mock provider: the §1 demo graph, ready to run. */
function seedRunnableWorkflow(options: { inputText?: string } = {}) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });

  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  if (options.inputText !== undefined) {
    input.config = { ...input.config, text: options.inputText } as typeof input.config;
  }
  const agent = createNode('agent', workflow.id, { x: 300, y: 0 });
  agent.config = {
    ...agent.config,
    providerId: provider.id,
    modelId: 'mock-text',
  } as typeof agent.config;
  const output = createNode('output', workflow.id, { x: 600, y: 0 });

  const edge = (from: Node, to: Node): Edge => ({
    id: `01EDGE${from.id.slice(-10)}${to.id.slice(-10)}`.slice(0, 26).toUpperCase(),
    workflowId: workflow.id,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  });

  const edges = [edge(input, agent), edge(agent, output)];
  db.commitGraph(workflow.id, [input, agent, output], edges);
  return { project, workflow, provider, input, agent, output, edges };
}

/**
 * The run bar's own Start — exactly, not the palette's "start" anything else and not round 3's
 * Restart beside it.
 */
const startButton = () =>
  within(screen.getByTestId('run-bar')).getByRole('button', { name: 'Start' });

function openCanvas(projectId: string, workflowId: string) {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  return renderApp(`/projects/${projectId}/workflows/${workflowId}`);
}

describe('FR-EXE-001 Start runs the workflow and the top bar follows it', () => {
  it('goes from running to complete, with totals from the run’s own frames', async () => {
    setScenario('linear-complete');
    const { project, workflow } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());

    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent(/running/i));
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('run-totals')).toHaveTextContent(/\d+↓ \d+↑ \$\d/);

    // TC-EXE-011: the run is in the history, newest first.
    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    const table = await screen.findByTestId('runs-table');
    const rows = within(table).getAllByTestId(/^run-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-status', 'COMPLETE');
  });

  it('TC-NODE-010: asks for text when an Input node has none, then starts with it', async () => {
    setScenario('linear-complete');
    const { project, workflow, input } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());

    const dialog = await screen.findByTestId('run-input-dialog');
    expect(within(dialog).getByRole('button', { name: 'Start run' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(input.name), 'summarise this');
    await user.click(within(dialog).getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(db.listRuns(workflow.id)).toHaveLength(1));
    expect(db.listRuns(workflow.id)[0]?.inputs[input.id]).toEqual([
      { type: 'text', text: 'summarise this' },
    ]);
  });

  it('keeps Start disabled while a run is in flight (one active run per workflow)', async () => {
    setScenario('slow-stream');
    const { project, workflow } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    const start = startButton();
    await user.click(start);
    await waitFor(() => expect(start).toBeDisabled());
  });
});

describe('FR-EXE-003 a run refused at pre-flight shows its issues', () => {
  it('lists each issue and links the one that names a node', async () => {
    setScenario('preflight-blocked');
    const { project, workflow } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());

    const panel = await screen.findByTestId('preflight-issues');
    expect(panel).toHaveTextContent(/nothing was sent to a provider/i);
    expect(within(panel).getByText('provider_unreachable')).toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: /show node/i }).length).toBeGreaterThan(0);

    // BR-08: no frame is emitted for a blocked run, so the node states stay IDLE.
    expect(useRunStore.getState().nodeRuns()).toHaveLength(0);
    expect(db.listRuns(workflow.id)[0]?.status).toBe('BLOCKED');
  });
});

describe('TC-EXE-013 a socket drop mid-run leaves the overlay identical', () => {
  it('reconnects, resumes after the last seq and folds the same view', async () => {
    setScenario('linear-complete');
    const { project, workflow } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());
    await waitFor(() => expect(useRunStore.getState().nodeRuns().length).toBeGreaterThan(0));

    // Cut the connection the way an engine restart would.
    dropMockSockets();

    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 8_000 },
    );

    /*
     * §7.1's row asks for the overlay to end *identical to* `GET /runs/:id/node-runs`, which is
     * stronger than "no duplicates and everything COMPLETED" — that would also pass if the fold had
     * quietly lost a node, or ended a node in a state the engine never recorded (Arhant's review of
     * PR #11, comment 3). So the comparison is against the records themselves.
     */
    const view = useRunStore.getState();
    const runId = view.runId as string;
    const recorded = db.listNodeRuns(runId);

    expect(recorded.length).toBeGreaterThan(0);
    expect(view.nodeRuns()).toHaveLength(recorded.length);
    for (const nodeRun of recorded) {
      expect(view.nodeState(nodeRun.nodeId), `state of ${nodeRun.nodeId}`).toBe(nodeRun.status);
    }
    // One node run per node: a replayed frame must not have folded into a second view.
    expect(new Set(view.nodeRuns().map((run) => run.nodeId)).size).toBe(view.nodeRuns().length);
  });
});

describe('FR-RTR-006 a fallback is visible in the run', () => {
  it('records the fallback model on the node run', async () => {
    setScenario('fallback-used');
    const { project, workflow, agent } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());
    await waitFor(
      () => expect(useRunStore.getState().nodeRun(agent.id)?.modelUsed?.viaFallback).toBe(true),
      { timeout: 5_000 },
    );
    expect(useRunStore.getState().nodeRun(agent.id)?.modelUsed?.modelId).toBe('mock-text-fallback');
  });
});

describe('TC-EXE-014 an envelope delivery marks the edge it travelled', () => {
  it('records a transfer with the engine’s summary', async () => {
    setScenario('linear-complete');
    const { project, workflow, edges } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await user.click(startButton());

    // The Agent → Output edge: an Input node produces no envelope of its own, so the first edge
    // carries nothing until the agent has answered.
    const agentEdge = edges[1]!;
    await waitFor(() => expect(useRunStore.getState().lastTransfer(agentEdge.id)).toBeDefined(), {
      timeout: 5_000,
    });
    const transfer = useRunStore.getState().lastTransfer(agentEdge.id);
    expect(transfer?.summary.length).toBeLessThanOrEqual(120);
    expect(transfer?.fromNodeId).toBe(agentEdge.from.nodeId);
  });
});

describe('FR-EXE-010/012 a pane left open during the run catches up when it ends', () => {
  it('fills the inspector that was already open, and moves the history row off RUNNING', async () => {
    setScenario('slow-stream');
    const { project, workflow, agent } = seedRunnableWorkflow({ inputText: 'go' });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    // Open both panes *before* starting, which is the case the earlier code never refetched for:
    // the queries mounted while the run had nothing recorded yet and nothing invalidated them.
    act(() => useSelectionStore.getState().setSelection([agent.id], []));
    await user.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(await screen.findByText(/start a run to inspect it/i)).toBeInTheDocument();

    await user.click(startButton());

    const inspector = await screen.findByTestId('inspector');
    await waitFor(
      () => expect(within(inspector).getByTestId('inspector-facts')).toBeInTheDocument(),
      { timeout: 15_000 },
    );
    expect(within(inspector).getByTestId('inspector-facts')).toHaveTextContent('mock-text');

    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    const row = await screen.findByTestId(/^run-row-/);
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'COMPLETE'), {
      timeout: 15_000,
    });
    // FR-EXE-012 asks for the duration in the history, which only exists once the run has ended.
    expect(row).not.toHaveTextContent(/RUNNING/);
  });
});
