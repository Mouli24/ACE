import { zeroUsage, type Run } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';

import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

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
    totals: { tokensIn: 12, tokensOut: 8, costUsd: 0.000028, priceTableVersion: 'mock-v1' },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 640,
    ...overrides,
  };
  db.addRun(run);
  return { project, workflow, agent, output, run };
}

describe('FR-EXE-012 a run’s own page shows the snapshot it executed', () => {
  it('shows status, duration, totals and every node of the snapshot', async () => {
    const { run, agent } = seedRun();
    renderApp(`/runs/${run.id}`);

    const status = await screen.findByTestId('run-detail-status');
    expect(status).toHaveAttribute('data-status', 'COMPLETE');
    expect(screen.getByTestId('run-detail-totals')).toHaveTextContent('mock-v1');
    expect(screen.getByText(/version 1/)).toBeInTheDocument();

    const nodes = await screen.findByTestId('run-detail-nodes');
    // The snapshot is the record, so a node that never ran is still listed (BR-04).
    expect(within(nodes).getByTestId(`run-detail-node-${agent.id}`)).toHaveAttribute(
      'data-state',
      'IDLE',
    );
    expect(within(nodes).getAllByTestId(/^run-detail-node-/)).toHaveLength(2);
  });

  it('records a blocked run with its pre-flight issues and no node runs', async () => {
    const { run } = seedRun({
      status: 'BLOCKED',
      totals: zeroUsage(),
      preflightIssues: [
        { severity: 'error', code: 'missing_model', message: '"Agent" has no model chosen.' },
      ],
      endedAt: undefined,
      durationMs: undefined,
    });
    renderApp(`/runs/${run.id}`);

    const panel = await screen.findByTestId('run-detail-preflight');
    expect(panel).toHaveTextContent('missing_model');
    expect(panel).toHaveTextContent('has no model chosen');
    await waitFor(() =>
      expect(screen.getByTestId('run-detail-status')).toHaveAttribute('data-status', 'BLOCKED'),
    );
  });

  it('says so when the run does not exist', async () => {
    renderApp(`/runs/${newId()}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this run/i);
  });
});
