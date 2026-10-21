import { TRACE_ENTRY_KINDS, type Run, type TraceEntry } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { getSocket, startSocket, stopSocket } from '../app/socket';
import { newId } from '../lib/ulid';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderWithQuery, server } from '../test/app';
import { TraceTab, traceQueryKey } from './TraceTab';

installMockServer();

afterEach(() => stopSocket());

function seedRun(overrides: Partial<Run> = {}) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const agent = createNode('agent', workflow.id, { x: 0, y: 0 });
  const output = createNode('output', workflow.id, { x: 200, y: 0 });
  db.commitGraph(workflow.id, [agent, output], []);
  const run: Run = {
    id: newId(),
    workflowId: workflow.id,
    projectId: project.id,
    status: 'COMPLETE',
    snapshot: { version: 1, nodes: [agent, output], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: '2026-10-01T10:00:00.000Z',
    endedAt: '2026-10-01T10:00:05.000Z',
    durationMs: 5000,
    ...overrides,
  };
  db.addRun(run);
  return { workflow, agent, output, run };
}

/** One entry of every kind, two of them on `nodeId`, in the API's (ascending `seq`) order. */
function sixKinds(nodeId: string, otherNodeId: string): TraceEntry[] {
  const at = (s: number) => `2026-10-01T10:00:0${s}.000Z`;
  return [
    { seq: 3, at: at(0), kind: 'run_event', label: 'Run started', detail: { a: 1 } },
    {
      seq: 7,
      at: at(1),
      kind: 'node_run',
      nodeId,
      label: 'Agent → COMPLETED',
      detail: { status: 'COMPLETED', marker: 'node-run-detail' },
      durationMs: 1200,
    },
    { seq: 8, at: at(1), kind: 'tool_call', nodeId, label: 'echo (ok)', detail: { t: 1 } },
    { seq: 11, at: at(2), kind: 'verdict', nodeId: otherNodeId, label: 'pii warn', detail: {} },
    { seq: 12, at: at(2), kind: 'approval', nodeId: otherNodeId, label: 'Approval', detail: {} },
    { seq: 20, at: at(3), kind: 'loop', nodeId: otherNodeId, label: 'Loop 1', detail: {} },
  ];
}

const shownSeqs = () =>
  within(screen.getByTestId('trace-timeline'))
    .getAllByTestId(/^trace-entry-/)
    .map((li) => Number(li.getAttribute('data-testid')!.replace('trace-entry-', '')));

describe('TC-OBS-001 trace view', () => {
  it('renders every entry in the API order, with each kind and an expandable detail', async () => {
    const { run, agent, output } = seedRun();
    const entries = sixKinds(agent.id, output.id);
    server.use(http.get('*/api/v1/runs/:id/trace', () => HttpResponse.json(entries)));
    const user = userEvent.setup();
    renderWithQuery(<TraceTab runId={run.id} />);

    await screen.findByTestId('trace-timeline');
    expect(screen.getByTestId('trace-tab')).toHaveAttribute('data-scope', 'run');
    expect(screen.getByRole('heading', { name: 'Trace' })).toBeInTheDocument();
    expect(shownSeqs()).toEqual(entries.map((e) => e.seq));
    const kinds = screen.getAllByTestId(/^trace-entry-/).map((li) => li.getAttribute('data-kind'));
    expect(kinds).toEqual(entries.map((e) => e.kind));
    expect(new Set(kinds)).toEqual(new Set(TRACE_ENTRY_KINDS));
    expect(screen.getByTestId('trace-count')).toHaveTextContent('6 entries');
    expect(screen.getByTestId('trace-duration')).toHaveTextContent('took 1.2 s');

    const row = screen.getByTestId('trace-entry-7');
    expect(row).not.toHaveTextContent('node-run-detail');
    await user.click(within(row).getByRole('button', { name: /Agent → COMPLETED/ }));
    expect(row).toHaveTextContent('node-run-detail');
  });

  it('keeps the engine order even when it is not the order of `at`', async () => {
    const { run, agent, output } = seedRun();
    const entries = sixKinds(agent.id, output.id)
      .reverse()
      .map((e, i) => ({ ...e, seq: i + 1 }));
    server.use(http.get('*/api/v1/runs/:id/trace', () => HttpResponse.json(entries)));
    renderWithQuery(<TraceTab runId={run.id} />);
    await screen.findByTestId('trace-timeline');
    const texts = screen.getAllByTestId(/^trace-entry-/).map((li) => li.textContent ?? '');
    expect(texts).toHaveLength(entries.length);
    entries.forEach((entry, i) => expect(texts[i]).toContain(entry.label));
  });

  it('narrows to the focused node, and shows the whole run on request', async () => {
    const { run, agent, output } = seedRun();
    const entries = sixKinds(agent.id, output.id);
    server.use(http.get('*/api/v1/runs/:id/trace', () => HttpResponse.json(entries)));
    const user = userEvent.setup();
    renderWithQuery(<TraceTab runId={run.id} nodeId={agent.id} />);

    await screen.findByTestId('trace-timeline');
    expect(screen.getByTestId('trace-tab')).toHaveAttribute('data-scope', 'node');
    expect(shownSeqs()).toEqual([7, 8]);
    expect(screen.getByTestId('trace-count')).toHaveTextContent('2 of 6 entries');

    const toggle = screen.getByTestId('trace-scope-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(shownSeqs()).toEqual(entries.map((e) => e.seq));
    await user.click(screen.getByRole('button', { name: 'Show this node only' }));
    expect(shownSeqs()).toEqual([7, 8]);
  });

  it('reads the mock engine’s trace, which folds the event log in seq order', async () => {
    const { run, workflow } = seedRun();
    db.emit({ type: 'run.started', scope: 'workflow', workflowId: workflow.id, payload: { run } });
    db.emit({
      type: 'usage.updated',
      scope: 'workflow',
      workflowId: workflow.id,
      payload: { runId: run.id, totals: { tokensIn: 1, tokensOut: 2, costUsd: 0 } },
    });
    // the run's own events; the graph commit's `workflow.updated` is not a run event
    const logged = db.events
      .filter((e) => e.type === 'run.started' || e.type === 'usage.updated')
      .map((e) => e.seq);
    expect(logged).toHaveLength(2);
    renderWithQuery(<TraceTab runId={run.id} />);
    await screen.findByTestId('trace-timeline');
    expect(shownSeqs()).toEqual(logged);
    expect(screen.getByText('Run started')).toBeInTheDocument();
    expect(screen.getByText('Usage updated')).toBeInTheDocument();
  });

  it('refetches a live run’s trace when one of its frames arrives', async () => {
    const { run, workflow } = seedRun({ status: 'RUNNING', endedAt: undefined });
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    getSocket()!.subscribe({ scope: 'workflow', id: workflow.id });
    renderWithQuery(<TraceTab runId={run.id} />);
    expect(await screen.findByTestId('trace-empty')).toBeInTheDocument();
    expect(await screen.findByTestId('trace-live')).toBeInTheDocument();

    act(() => {
      db.emit({
        type: 'usage.updated',
        scope: 'workflow',
        workflowId: workflow.id,
        payload: { runId: run.id, totals: { tokensIn: 1, tokensOut: 2, costUsd: 0 } },
      });
    });
    await waitFor(() => expect(screen.getByText('Usage updated')).toBeInTheDocument(), {
      timeout: 1_500,
    });
  });

  it('[audit W-20] polls a live run’s trace only while the socket is not open', async () => {
    const { run, workflow } = seedRun({ status: 'RUNNING', endedAt: undefined });
    const pollOf = () =>
      queryClient.getQueryCache().find({ queryKey: traceQueryKey(run.id) })?.observers[0]?.options
        .refetchInterval;
    const { unmount } = renderWithQuery(<TraceTab runId={run.id} />);
    expect(await screen.findByTestId('trace-live')).toBeInTheDocument();
    // no socket: the poll is the only way the trace moves
    expect(pollOf()).toBe(2_000);
    unmount();

    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    getSocket()!.subscribe({ scope: 'workflow', id: workflow.id });
    await waitFor(() => expect(getSocket()?.status).toBe('open'));
    renderWithQuery(<TraceTab runId={run.id} />);
    expect(await screen.findByTestId('trace-live')).toBeInTheDocument();
    await waitFor(() => expect(pollOf()).toBe(false));
  });

  it('says so when the trace cannot be loaded', async () => {
    renderWithQuery(<TraceTab runId={newId()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load the trace/i);
  });
});
