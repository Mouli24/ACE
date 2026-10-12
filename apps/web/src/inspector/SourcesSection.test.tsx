import { derivePorts, type Edge, type Node, type NodeRun } from '@ace/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { startSocket, stopSocket } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { setScenario } from '../mocks/handlers-round2';
import { RARE_TERM } from '../mocks/knowledge-fixtures';
import { seedKnowledgeBase } from '../mocks/seeds-round5';
import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { SourcesSection, chunkHref } from './SourcesSection';

installMockServer();

/*
 * The desktop header no longer carries the run bar (D330): a run is started and controlled from the
 * canvas "…" menu, which lives in the real Canvas. With the Canvas stood in for, the stand-in mounts
 * `RunBar` — the same controls, hooks and store the compact header uses — so the wiring is still
 * driven end to end.
 */
vi.mock('../canvas/Canvas', async () => {
  const { RunBar } = await import('../runs/RunBar');
  return {
    Canvas: ({ workflowId }: { workflowId: string }) => (
      <>
        <div data-testid="canvas">{workflowId}</div>
        <RunBar workflowId={workflowId} />
      </>
    ),
  };
});

afterEach(() => {
  stopSocket();
  useRunStore.getState().reset();
});

const edge = (
  workflowId: string,
  from: Node,
  fromPort: string,
  to: Node,
  toPort: string,
): Edge => ({
  id: db.nextId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: `${from.id}:out:${fromPort}` },
  to: { nodeId: to.id, portId: `${to.id}:in:${toPort}` },
});

/**
 * Input → (Retrieval →) Agent → Output over a seeded knowledge base, run on the mock engine, then the
 * inspector opened on the node that retrieved: the agent itself, or the Retrieval node.
 */
async function runAndInspect(shape: 'attached' | 'retrieval-node') {
  setScenario('linear-complete');
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const kb = seedKnowledgeBase(db, project.id);

  const input = createNode('input', workflow.id, { x: 0, y: 0 });
  input.config = { ...input.config, text: `What is ${RARE_TERM}?` } as typeof input.config;
  const agent = createNode('agent', workflow.id, { x: 600, y: 0 });
  agent.config = {
    ...agent.config,
    providerId: provider.id,
    modelId: 'mock-cite',
    inputTypes: shape === 'attached' ? ['text'] : ['json'],
    knowledgeBaseIds: shape === 'attached' ? [kb.knowledgeBaseId] : [],
  } as typeof agent.config;
  const output = createNode('output', workflow.id, { x: 900, y: 0 });

  let nodes: Node[];
  let edges: Edge[];
  let inspected: Node;
  // ports follow the config (derivePorts); rebuild the agent's from its input types
  const agentFinal = { ...agent, ...derivePorts(agent) } as Node;
  if (shape === 'attached') {
    nodes = [input, agentFinal, output];
    edges = [
      edge(workflow.id, input, 'text', agentFinal, 'text'),
      edge(workflow.id, agentFinal, 'text', output, 'text'),
    ];
    inspected = agentFinal;
  } else {
    const retrieval = createNode('retrieval', workflow.id, { x: 300, y: 0 });
    retrieval.config = { k: 3, mode: 'hybrid', knowledgeBaseId: kb.knowledgeBaseId };
    nodes = [input, retrieval, agentFinal, output];
    edges = [
      edge(workflow.id, input, 'text', retrieval, 'query'),
      edge(workflow.id, retrieval, 'out', agentFinal, 'json'),
      edge(workflow.id, agentFinal, 'text', output, 'text'),
    ];
    inspected = retrieval;
  }
  db.commitGraph(workflow.id, nodes, edges);

  const user = userEvent.setup();
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
  await screen.findByTestId('canvas');
  await user.click(
    within(screen.getByTestId('run-bar')).getByRole('button', { name: 'Start run' }),
  );
  await waitFor(
    () => expect(useRunStore.getState().nodeRun(agentFinal.id)?.status).toBe('COMPLETED'),
    {
      timeout: 8_000,
    },
  );
  act(() => useSelectionStore.getState().setSelection([inspected.id], []));
  // the sheet over the Canvas holds this tab; it is closed until the top bar opens it
  // the workspace menu's "Workflow panel" opens the sheet (D331)
  act(() => usePanelsStore.getState().openSheet());
  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  const inspector = await screen.findByTestId('inspector');
  const recorded = () =>
    db
      .listNodeRuns(useRunStore.getState().runId!)
      .find((run) => run.nodeId === inspected.id) as NodeRun;
  return { inspector, kb, recorded };
}

describe('TC-RAG-006 Sources listed for an agent with a knowledge base attached', () => {
  it('lists chunk id, score, source and text exactly as the node run recorded them', async () => {
    const { inspector, kb, recorded } = await runAndInspect('attached');
    const section = await within(inspector).findByTestId('inspector-sources');
    const nodeRun = recorded();
    expect(nodeRun.sources?.length).toBeGreaterThan(0);

    const items = within(section).getAllByTestId(/^source-01/);
    expect(items.map((item) => item.dataset.chunkId)).toEqual(
      nodeRun.sources!.map((s) => s.chunkId),
    );
    const first = nodeRun.sources![0]!;
    const row = within(section).getByTestId(`source-${first.chunkId}`);
    expect(within(row).getByTestId('source-chunk-id')).toHaveTextContent(first.chunkId);
    expect(within(row).getByTestId('source-score')).toHaveTextContent(first.score.toFixed(2));
    expect(within(row).getByTestId('source-chip')).toHaveTextContent(first.source);
    // the text the context builder retrieved (envelope.context.retrieved)
    const retrieved = nodeRun.inputEnvelopes[0]!.context.retrieved!.find(
      (chunk) => chunk.chunkId === first.chunkId,
    )!;
    expect(within(row).getByTestId('source-text')).toHaveTextContent(retrieved.text.slice(0, 30));
    // and it opens the document at that chunk, in the base it belongs to
    await waitFor(() =>
      expect(within(row).getByTestId('source-link')).toHaveAttribute(
        'href',
        `/knowledge/${kb.knowledgeBaseId}?doc=${first.documentId}&chunk=${first.chunkId}`,
      ),
    );
  });
});

describe('TC-RAG-007 Sources listed for a Retrieval node', () => {
  it('lists the hits it output, with the hit text', async () => {
    const { inspector, recorded } = await runAndInspect('retrieval-node');
    const section = await within(inspector).findByTestId('inspector-sources');
    const nodeRun = recorded();
    const output = nodeRun.output![0]!;
    if (output.type !== 'json') throw new Error('retrieval output is json');
    const hits = (output.value as { hits: { chunkId: string; text: string; score: number }[] })
      .hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    const items = within(section).getAllByTestId(/^source-01/);
    expect(items.map((item) => item.dataset.chunkId)).toEqual(hits.map((hit) => hit.chunkId));
    const row = within(section).getByTestId(`source-${hits[0]!.chunkId}`);
    expect(within(row).getByTestId('source-text')).toHaveTextContent(hits[0]!.text.slice(0, 30));
    expect(within(row).getByTestId('source-score')).toHaveTextContent(hits[0]!.score.toFixed(2));
  });
});

describe('FR-RAG-007 Sources section details', () => {
  const base: NodeRun = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
    nodeId: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
    iteration: 1,
    attempt: 1,
    status: 'COMPLETED',
    inputEnvelopes: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    verdicts: [],
    toolCalls: [],
  } as unknown as NodeRun;
  const source = (n: number, score: number) => ({
    chunkId: `01ARZ3NDEKTSV4RRFFQ69G5FC${n}`,
    documentId: '01ARZ3NDEKTSV4RRFFQ69G5FD1',
    score,
    source: `doc.md#part ${n}`,
  });
  const show = (nodeRun: NodeRun) =>
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesSection nodeRun={nodeRun} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('renders nothing for a node run that retrieved nothing', () => {
    const { container } = show(base);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists dropped chunks collapsed under "Dropped to fit budget", source only without text', async () => {
    show({ ...base, sources: [source(1, 0.9)], droppedSources: [source(2, 0.2), source(3, 0.1)] });
    const dropped = screen.getByTestId('dropped-sources');
    expect(dropped).not.toHaveAttribute('open');
    expect(within(dropped).getByText('Dropped to fit budget (2)')).toBeInTheDocument();
    await userEvent.setup().click(within(dropped).getByText('Dropped to fit budget (2)'));
    expect(dropped).toHaveAttribute('open');
    const row = within(dropped).getByTestId(`dropped-source-${source(2, 0).chunkId}`);
    expect(within(row).getByTestId('source-chip')).toHaveTextContent('doc.md#part 2');
    expect(within(row).queryByTestId('source-text')).not.toBeInTheDocument();
    // with no base known, no link is invented
    expect(within(row).queryByTestId('source-link')).not.toBeInTheDocument();
  });

  it('builds the chunk link from base, document and chunk', () => {
    expect(chunkHref('KB1', source(1, 0.5))).toBe(
      `/knowledge/KB1?doc=01ARZ3NDEKTSV4RRFFQ69G5FD1&chunk=01ARZ3NDEKTSV4RRFFQ69G5FC1`,
    );
  });
});
