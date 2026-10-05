import type { Edge, Node } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { startSocket, stopSocket } from '../app/socket';
import { useSelectionStore } from '../app/stores/selection';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { setScenario } from '../mocks/handlers-round2';
import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, queryClient, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => {
  stopSocket();
  useRunStore.getState().reset();
});

/** Pre-flight refuses a model that cannot serve the node's types, so the node follows the model. */
function seed(modelId = 'mock-text', outputTypes: Array<'text' | 'json'> = ['text']) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });

  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  input.config = { ...input.config, text: 'summarise the report' } as typeof input.config;
  const agent = createNode('agent', workflow.id, { x: 300, y: 0 });
  agent.config = {
    ...agent.config,
    providerId: provider.id,
    modelId,
    outputTypes,
  } as typeof agent.config;
  const output = createNode('output', workflow.id, { x: 600, y: 0 });

  const edge = (from: Node, to: Node): Edge => ({
    id: `01EDGE${from.id.slice(-10)}${to.id.slice(-10)}`.slice(0, 26).toUpperCase(),
    workflowId: workflow.id,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  });
  db.commitGraph(workflow.id, [input, agent, output], [edge(input, agent), edge(agent, output)]);
  return { project, workflow, provider, agent };
}

/** Run the workflow, then open the inspector on the agent node. */
async function runAndInspect(
  scenario: Parameters<typeof setScenario>[0],
  modelId?: string,
  outputTypes?: Array<'text' | 'json'>,
) {
  setScenario(scenario);
  const seeded = seed(modelId, outputTypes);
  const user = userEvent.setup();
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  renderApp(`/projects/${seeded.project.id}/workflows/${seeded.workflow.id}`);
  await screen.findByTestId('canvas');

  // 'Start run' exactly: round 3 put Restart in the same bar.
  await user.click(
    within(screen.getByTestId('run-bar')).getByRole('button', { name: 'Start run' }),
  );
  await waitFor(() => expect(useRunStore.getState().nodeRun(seeded.agent.id)).toBeDefined(), {
    timeout: 5_000,
  });

  act(() => useSelectionStore.getState().setSelection([seeded.agent.id], []));
  // the sheet over the Canvas holds this tab; it is closed until the top bar opens it
  await user.click(screen.getByTestId('sheet-toggle'));
  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  return { ...seeded, user, inspector: await screen.findByTestId('inspector') };
}

describe('TC-EXE-009 the inspector shows what the node run recorded', () => {
  it('lists the envelope, the output, the model and the cost', async () => {
    const { inspector } = await runAndInspect('linear-complete');

    const facts = await within(inspector).findByTestId('inspector-facts');
    await waitFor(() => expect(facts).toHaveTextContent('mock-text'));
    expect(facts).toHaveTextContent(/tokens in/);
    expect(facts).toHaveTextContent(/cost/);
    expect(facts).toHaveTextContent('mock-v1');

    // BR-02/BR-13: the envelope says what came in, on what budget, and how trusted it was.
    const trust = await within(inspector).findByTestId('envelope-trust');
    expect(trust).toHaveTextContent(/trusted|untrusted/);
    expect(within(inspector).getByText(/budget \d+ tokens/)).toBeInTheDocument();
    expect(await within(inspector).findByTestId('inspector-output')).not.toBeEmptyDOMElement();
  });

  it('shows the error, its kind and the failure reason when a node failed', async () => {
    const { inspector } = await runAndInspect('contract-violation', 'mock-bad-json', ['json']);

    const error = await within(inspector).findByTestId('inspector-error');
    expect(error).toHaveTextContent('agent');
    expect(error).toHaveTextContent('contract_violation');
    // BR-03: a contract violation is its own failure reason, never RUN_FAILED.
    expect(await within(inspector).findByTestId('inspector-failure-reason')).toHaveTextContent(
      'CONTRACT_VIOLATION',
    );
  });
});

describe('TC-PRM-004/005 the prompt is recorded and can be read back', () => {
  it('shows the prompt version and the exact text, with no key in it', async () => {
    const { inspector, user } = await runAndInspect('linear-complete');

    const version = await within(inspector).findByTestId('prompt-version');
    expect(version).toHaveTextContent(/version \S+/);

    await user.click(within(inspector).getByRole('button', { name: 'View prompt' }));
    const text = await screen.findByTestId('prompt-text');

    // §2.8 assembly order, and the untrusted labelling of BR-13.
    expect(text).toHaveTextContent(/summarise the report/);
    expect(text.textContent).toMatch(/UNTRUSTED/);
    expect(text.textContent).not.toMatch(/sk-[a-z0-9-]{6,}/i);
  });
});

describe('D-076 the inspector download card shows the file hash (FR-MM-006)', () => {
  it('fetches the artifact row and passes its sha256 to the card', async () => {
    const { inspector, agent } = await runAndInspect('media-outputs', 'mock-media', ['text']);
    await waitFor(() => expect(useRunStore.getState().nodeState(agent.id)).toBe('COMPLETED'), {
      timeout: 5_000,
    });
    const file = useRunStore
      .getState()
      .nodeRun(agent.id)
      ?.output?.find((part) => part.type === 'file');
    expect(file?.type).toBe('file');
    const hash = db.getArtifact((file as { artifactId: string }).artifactId)!.hash;
    const shown = await within(inspector).findByTestId('file-hash');
    expect(shown).toHaveAttribute('title', hash);
  });
});

describe('D-091 a run that finished before the page loaded can still be inspected (FR-EXE-010)', () => {
  it('falls back to the newest recorded run when the overlay has none', async () => {
    const { inspector, agent } = await runAndInspect('linear-complete');
    await waitFor(() => expect(useRunStore.getState().nodeState(agent.id)).toBe('COMPLETED'), {
      timeout: 5_000,
    });

    // a reload: the overlay adopts only live runs, so a finished one leaves it empty
    act(() => useRunStore.getState().reset());

    expect(await within(inspector).findByTestId('inspector-output')).not.toBeEmptyDOMElement();
    expect(within(inspector).queryByText('Start a run to inspect it.')).not.toBeInTheDocument();
  });
});
