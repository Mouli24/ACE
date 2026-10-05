import {
  allowedRunActions,
  RUN_ACTIONS,
  type Edge,
  type Node,
  type RunState,
} from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { useSelectionStore } from '../app/stores/selection';
import { newId } from '../lib/ulid';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { setScenario } from '../mocks/handlers-round2';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { useRunStore } from './run-store';

/**
 * The round 3 shell, wired (§5 items 2, 3, 4, 7). These are about the *wiring* — the components
 * themselves have their own tests, and this drives them where they actually live: the run bar, the
 * bottom pane's Events and Errors tabs, the approvals dock over the Canvas, the inspector.
 *
 * Everything comes from the mock engine and its scenarios, so nothing here fakes a state the engine
 * cannot produce.
 */

installMockServer();

// The desktop top bar no longer carries the halt note; the Canvas does (CanvasHaltNote, mounted by
// WorkflowPage). The stand-in Canvas mounts it so these tests still see the note where it now lives.
vi.mock('../canvas/Canvas', async () => {
  const { CanvasHaltNote } = await import('./controls/CanvasHaltNote');
  return {
    Canvas: ({ workflowId }: { workflowId: string }) => (
      <div data-testid="canvas">
        {workflowId}
        <CanvasHaltNote workflowId={workflowId} />
      </div>
    ),
  };
});

afterEach(() => {
  stopSocket();
  useRunStore.getState().reset();
});

/**
 * Input → Writer → Reviewer → Output on the mock provider, and with `loop: true` a loop edge from the
 * Reviewer back to the Writer.
 *
 * Two agents rather than one, because the scenarios that matter here need them: a run only blocks
 * something if there is an *executable* node after the failure, and a loop needs a body.
 */
function seedRunnableWorkflow(options: { loop?: boolean } = {}) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });

  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  input.config = { ...input.config, text: 'go' } as typeof input.config;
  const agent = createNode('agent', workflow.id, { x: 300, y: 0 });
  agent.name = 'Writer';
  agent.config = {
    ...agent.config,
    providerId: provider.id,
    modelId: 'mock-text',
  } as typeof agent.config;
  const reviewer = createNode('agent', workflow.id, { x: 600, y: 0 });
  reviewer.name = 'Reviewer';
  reviewer.config = {
    ...reviewer.config,
    providerId: provider.id,
    modelId: 'mock-text',
  } as typeof reviewer.config;
  const output = createNode('output', workflow.id, { x: 900, y: 0 });

  const edge = (from: Node, to: Node): Edge => ({
    id: newId(),
    workflowId: workflow.id,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  });

  const edges = [edge(input, agent), edge(agent, reviewer), edge(reviewer, output)];
  if (options.loop === true) {
    edges.push({
      id: newId(),
      workflowId: workflow.id,
      kind: 'loop',
      from: { nodeId: reviewer.id, portId: reviewer.outputs[0]!.id },
      to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
      loop: {
        maxIterations: 3,
        exitCondition: { path: 'verdict', equals: 'approved' },
        onMax: 'continue',
      },
    });
  }
  db.commitGraph(workflow.id, [input, agent, reviewer, output], edges);
  return { project, workflow, provider, input, agent, reviewer, output };
}

function openCanvas(projectId: string, workflowId: string) {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  return renderApp(`/projects/${projectId}/workflows/${workflowId}`);
}

const runBar = () => within(screen.getByTestId('run-bar'));
const startButton = () => runBar().getByRole('button', { name: 'Start' });
const action = (name: string) => screen.getByTestId(`run-action-${name}`);

/** Start a run of the given scenario and wait until the run bar has a status. */
async function startRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(startButton());
  await waitFor(() => expect(screen.getByTestId('run-status')).toBeInTheDocument());
}

describe('TC-CTL-006 the run controls follow allowedActions and nothing else', () => {
  /*
   * The assertion is never a second table: `allowedRunActions` is the contract's own, which is what
   * the engine wrote into `Run.allowedActions` and what the toolbar was handed. A button enabled
   * outside that set would be a 409 waiting to happen (FR-CTL-006).
   *
   * It is checked against whatever state the toolbar reports rather than a state the test expects, so
   * the rule is what is under test and not the timing of the run.
   */
  const expectTableToHold = async (): Promise<RunState> =>
    waitFor(
      () => {
        const status = screen
          .getByTestId('run-controls')
          .getAttribute('data-status') as RunState | null;
        expect(status).not.toBeNull();
        const allowed = allowedRunActions(status as RunState);
        for (const name of RUN_ACTIONS) {
          const button = action(name);
          if (allowed.includes(name)) expect(button).toBeEnabled();
          else expect(button).toBeDisabled();
        }
        return status as RunState;
      },
      // A control is a round trip, and an instrumented run is slower than the default second.
      { timeout: 5_000 },
    );

  const atStatus = async (status: RunState) => {
    await waitFor(
      () => expect(screen.getByTestId('run-controls')).toHaveAttribute('data-status', status),
      { timeout: 5_000 },
    );
    return expectTableToHold();
  };

  it('holds the table through paused, resumed and complete', async () => {
    /*
     * The `paused` scenario pauses itself at its hold and continues on a resume, so the three states
     * arrive without a manual control racing the script. The manual Pause is the next test's job, on
     * a scenario that does not pause itself.
     */
    setScenario('paused');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);

    await atStatus('PAUSED');
    expect(action('resume')).toBeEnabled();
    expect(action('pause')).toBeDisabled();

    await user.click(action('resume'));
    await atStatus('COMPLETE');
    // A finished run offers one thing: another run from the same snapshot (FR-CTL-004).
    expect(action('restart')).toBeEnabled();
    expect(action('stop')).toBeDisabled();
  });

  it('FR-CTL-001: Pause holds a run that was going, and Resume lets it finish', async () => {
    // `slow-stream` streams for a while and never pauses itself, so the pause here is only ours.
    setScenario('slow-stream');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await atStatus('RUNNING');

    await user.click(action('pause'));
    await atStatus('PAUSED');

    await user.click(action('resume'));
    await waitFor(
      () => expect(screen.getByTestId('run-controls')).not.toHaveAttribute('data-status', 'PAUSED'),
      { timeout: 5_000 },
    );
    await expectTableToHold();
  });

  it('FR-CTL-003: Stop asks first, and the halt says who stopped it in plain words', async () => {
    setScenario('slow-stream');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await waitFor(() => expect(action('stop')).toBeEnabled());

    await user.click(action('stop'));
    const confirm = await screen.findByTestId('stop-confirm');
    await user.click(within(confirm).getByTestId('stop-confirm-stop'));

    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED'),
      { timeout: 5_000 },
    );
    expect(await screen.findByTestId('halt-reason')).toHaveTextContent('stopped by you');
  });
});

describe('FR-GRD-008 a budget halt says which cap tripped', () => {
  it('shows the amount and the cap, not just "halted"', async () => {
    setScenario('budget-halt');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);

    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED'),
      { timeout: 5_000 },
    );
    const halt = await screen.findByTestId('halt-reason');
    expect(halt).toHaveTextContent(/budget exceeded/i);
    // NFR-USE-03: both numbers, so the operator knows which cap to raise and by how much.
    expect(halt).toHaveTextContent(/\$\d/);
    expect(halt).toHaveTextContent(/cap/i);
  });
});

describe('TC-ERR-002 / TC-ERR-007 the Errors tab is the one place a failure is explained', () => {
  it('names the failure and what to do next, and shows the blocked nodes apart from it', async () => {
    setScenario('blocked-downstream');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED'),
      { timeout: 5_000 },
    );

    await user.click(screen.getByRole('tab', { name: 'Errors' }));
    const tab = await screen.findByTestId('errors-tab');

    // The card carries the kind and the next step for that kind (NFR-USE-03).
    const card = await within(tab).findByTestId(/^error-card-/);
    expect(card).toHaveAttribute('data-kind', 'auth');
    expect(card).toHaveTextContent(/providers/i);
    expect(within(card).getByRole('button', { name: /retry/i })).toBeInTheDocument();

    // BLOCKED is listed as its own thing, never as a failure (FR-ERR-006, TC-ERR-007).
    const blocked = within(tab).getAllByTestId(/^blocked-note-/);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]).toHaveAttribute('data-state', 'BLOCKED');
  });

  it('TC-ERR-008: a stopped node is counted apart from failures', async () => {
    setScenario('stopped');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED'),
      { timeout: 5_000 },
    );

    await user.click(screen.getByRole('tab', { name: 'Errors' }));
    const summary = await screen.findByTestId('run-summary');
    expect(summary).toHaveAttribute('data-failed', '0');
    expect(summary).toHaveAttribute('data-stopped', '1');
  });
});

describe('FR-OBS-002 the Events tab is the run’s own history', () => {
  it('lists the frames that arrived, in order', async () => {
    setScenario('linear-complete');
    const { project, workflow } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 5_000 },
    );

    await user.click(screen.getByRole('tab', { name: 'Events' }));
    const tab = await screen.findByTestId('events-tab');
    const rows = within(tab).getAllByTestId(/^event-\d+$/);
    expect(rows.length).toBeGreaterThan(2);
    // `run.started` is the first thing any run does, and a completed run ends with `run.completed`.
    expect(rows[0]).toHaveAttribute('data-type', 'run.started');
    expect(rows[rows.length - 1]).toHaveAttribute('data-type', 'run.completed');
  });
});

describe('TC-GRD-008 / TC-GRD-009 an ask_user guardrail reaches a person', () => {
  it('raises a card while the node waits, and approving lets the run finish', async () => {
    setScenario('waiting-approval');
    const { project, workflow, agent } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);

    // The badge counts what the engine says is pending, not what this tab happened to see.
    const badge = await screen.findByTestId('approvals-badge', undefined, { timeout: 5_000 });
    expect(badge).toHaveAttribute('data-count', '1');

    /*
     * The dock floats over the Canvas, which this file stubs out, so the cards are reached the other
     * way the round file asks for: the top bar's badge. They are the same component either way.
     */
    await user.click(badge);
    const card = await screen.findByTestId(/^approval-card-/);
    expect(card).toHaveAttribute('data-point', 'output');
    expect(within(card).getByTestId('approval-reason')).not.toBeEmptyDOMElement();
    expect(within(card).getByTestId('approval-preview')).not.toBeEmptyDOMElement();

    // The node is WAITING for exactly as long as the question is open (Arch §19.1).
    await waitFor(() => expect(useRunStore.getState().nodeRun(agent.id)?.status).toBe('WAITING'));

    await user.click(within(card).getByRole('button', { name: /approve/i }));
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 5_000 },
    );
    expect(screen.queryByTestId('approvals-badge')).toBeNull();
  });

  it('TC-GRD-009: rejecting fails the node GUARDRAIL_VIOLATION, which is not a contract violation', async () => {
    setScenario('waiting-approval');
    const { project, workflow, agent } = seedRunnableWorkflow();
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await user.click(await screen.findByTestId('approvals-badge', undefined, { timeout: 5_000 }));
    const card = await screen.findByTestId(/^approval-card-/);
    await user.click(within(card).getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      const run = useRunStore.getState().nodeRun(agent.id);
      expect(run?.status).toBe('FAILED');
      expect(run?.failureReason).toBe('GUARDRAIL_VIOLATION');
    });
  });
});

describe('TC-PAR-006 the inspector lists every iteration of a loop', () => {
  it('shows three iterations with distinct outputs, and the verdicts recorded against one', async () => {
    setScenario('loop-3-iterations');
    const { project, workflow, agent } = seedRunnableWorkflow({ loop: true });
    const user = userEvent.setup();
    openCanvas(project.id, workflow.id);
    await screen.findByTestId('canvas');

    await startRun(user);
    await waitFor(
      () => expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'COMPLETE'),
      { timeout: 5_000 },
    );

    useSelectionStore.getState().setSelection([agent.id], []);
    await user.click(screen.getByRole('tab', { name: 'Inspector' }));

    const selector = await screen.findByTestId('iteration-selector', undefined, { timeout: 5_000 });
    expect(selector).toHaveTextContent('3 iterations');
    const options = within(selector).getAllByRole('radio');
    expect(options).toHaveLength(3);

    // Distinct outputs are what make the iterations worth listing at all.
    const previews = options.map((option) => option.textContent);
    expect(new Set(previews).size).toBe(previews.length);

    // Picking an earlier iteration shows that one's record, not the last one's.
    await user.click(options[0] as HTMLElement);
    await waitFor(() => expect(options[0]).toHaveAttribute('aria-checked', 'true'));
    const shown = within(screen.getByTestId('inspector-output')).getByText(/\w/);
    expect(previews[0]).toContain(shown.textContent?.slice(0, 20));
  });
});
