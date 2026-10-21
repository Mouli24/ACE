import { allowedRunActions, zeroUsage, type Node, type Run } from '@ace/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient } from '../test/app';
import { nodeChangedSinceRun } from './node-changed';
import { NodeErrorCard } from './NodeRunAttachments';
import { useRunStore } from './run-store';

installMockServer();

afterEach(() => useRunStore.getState().reset());

/** An agent that failed on a 503 in a HALTED run, with the run's snapshot holding `ran`. */
function failedRun(ran: Node, now: Node) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  ran.workflowId = workflow.id;
  now.workflowId = workflow.id;
  db.commitGraph(workflow.id, [now], []);
  const run: Run = {
    id: newId(),
    workflowId: workflow.id,
    projectId: project.id,
    status: 'HALTED',
    haltReason: 'failure',
    allowedActions: allowedRunActions('HALTED'),
    snapshot: { version: 1, nodes: [ran], edges: [] },
    inputs: { [ran.id]: [{ type: 'text', text: 'the question' }] },
    preflightIssues: [],
    totals: zeroUsage(),
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  db.addRun(run);
  useRunStore.getState().adopt(workflow.id, run, [
    {
      id: newId(),
      nodeId: ran.id,
      iteration: 1,
      attempt: 4,
      status: 'FAILED',
      failureReason: 'RUN_FAILED',
      error: { kind: 'provider', code: 'http_503', message: 'Unavailable', retryable: true },
      usage: zeroUsage(),
    },
  ]);
  return { workflow, run };
}

function agentWith(modelId: string): Node {
  const node = createNode('agent', 'W', { x: 0, y: 0 });
  node.config = { ...node.config, modelId } as typeof node.config;
  return node;
}

describe('[audit L-13] a failed node edited since its run started', () => {
  it('compares settings, not key order, position or name', () => {
    const ran = agentWith('mock-503');
    const same: Node = {
      ...ran,
      name: 'Renamed',
      position: { x: 9, y: 9 },
      config: Object.fromEntries(Object.entries(ran.config).reverse()) as Node['config'],
    };
    expect(nodeChangedSinceRun(same, [ran])).toBe(false);
    expect(nodeChangedSinceRun({ ...ran, config: agentWith('mock-text').config }, [ran])).toBe(
      true,
    );
    expect(nodeChangedSinceRun(ran, [])).toBe(false);
  });

  it('says Retry uses the run’s settings and offers a new run with the changes', async () => {
    const ran = agentWith('mock-503');
    const now: Node = { ...ran, config: { ...ran.config, modelId: 'mock-text' } as Node['config'] };
    const { workflow, run } = failedRun(ran, now);
    render(
      <QueryClientProvider client={queryClient}>
        <NodeErrorCard node={now} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId(`error-node-changed-${now.id}`)).toHaveTextContent(
      "This node changed since the run started — Retry uses the run's settings.",
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByTestId(`error-next-step-${now.id}`)).not.toHaveTextContent(
      /^Retry, or add a fallback/,
    );

    await userEvent.click(screen.getByRole('button', { name: /run again with changes/i }));
    await waitFor(() => expect(db.listRuns(workflow.id)).toHaveLength(2));
    const fresh = db.listRuns(workflow.id).find((each) => each.id !== run.id);
    expect(fresh?.inputs).toEqual(run.inputs);
  });

  it('says nothing more when the node is as the run left it', async () => {
    const ran = agentWith('mock-503');
    failedRun(ran, ran);
    render(
      <QueryClientProvider client={queryClient}>
        <NodeErrorCard node={ran} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId(`error-card-${ran.id}`)).toBeInTheDocument();
    // the run's record is read before the comparison can be made
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByTestId(`error-node-changed-${ran.id}`)).toBeNull();
    expect(screen.queryByRole('button', { name: /run again with changes/i })).toBeNull();
  });
});
