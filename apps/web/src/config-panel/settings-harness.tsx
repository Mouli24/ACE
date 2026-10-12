import { derivePorts, portId, type Edge, type LoopConfig, type Node } from '@ace/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { usePanelsStore, type SettingsTarget } from '../app/stores/panels';
import { newId } from '../lib/ulid';
import { createNode, type CanvasNodeKind } from '../nodes/factory';
import { db, queryClient } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { NodeSettingsModal } from './NodeSettingsModal';

/*
 * Test helpers for the node settings modal (D333): it is rendered on its own, under the route a
 * workflow opens at, against the mock engine `installMockServer()` wires — the way the canvas
 * mounts it, without the canvas.
 */

/** Mount the modal for `workflow` with `target` open. */
export function mountSettings(
  project: { id: string },
  workflow: { id: string },
  target: SettingsTarget,
): void {
  act(() => usePanelsStore.getState().openSettings(target));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${project.id}/workflows/${workflow.id}`]}>
        <NodeSettingsModal workflowId={workflow.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Mount the modal with `target` open and wait for its settings region. */
export async function renderSettings(
  project: { id: string },
  workflow: { id: string },
  target: SettingsTarget,
) {
  mountSettings(project, workflow, target);
  const panel = await screen.findByRole('region', { name: /node configuration/i });
  return { panel, q: within(panel), user: userEvent.setup() };
}

/** A project, a workflow with one node of `kind`, and the modal open on that node. */
export async function openNodeSettings(
  kind: CanvasNodeKind = 'agent',
  configure: (node: Node) => void = () => undefined,
) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const node = createNode(kind, workflow.id, { x: 0, y: 0 });
  configure(node);
  db.commitGraph(workflow.id, [node], []);
  const opened = await renderSettings(project, workflow, { kind: 'node', id: node.id });
  return { project, workflow, node, ...opened };
}

export const LOOP: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

/** Writer → Reviewer (json out), with a loop edge from the Reviewer back to the Writer. */
export function seedLoop() {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const writer = { ...createNode('agent', workflow.id, { x: 0, y: 0 }), name: 'Writer' } as Node;
  const base = createNode('agent', workflow.id, { x: 300, y: 0 });
  const json = {
    ...base,
    name: 'Reviewer',
    config: { ...base.config, outputTypes: ['json'] },
  } as Node;
  const reviewer = { ...json, ...derivePorts(json) } as Node;
  const data: Edge = {
    id: newId(),
    workflowId: workflow.id,
    kind: 'data',
    from: { nodeId: writer.id, portId: writer.outputs[0]!.id },
    to: { nodeId: reviewer.id, portId: portId(reviewer.id, 'in', 'text') },
  };
  const loop: Edge = {
    id: newId(),
    workflowId: workflow.id,
    kind: 'loop',
    from: { nodeId: reviewer.id, portId: portId(reviewer.id, 'out', 'json') },
    to: { nodeId: writer.id, portId: portId(writer.id, 'in', 'text') },
    loop: LOOP,
  };
  db.commitGraph(workflow.id, [writer, reviewer], [data, loop]);
  return { project, workflow, writer, reviewer, loop };
}

/** Wait until the workflow's queued graph-ops have reached the mock engine. */
export async function settled(workflowId: string): Promise<void> {
  await peekGraphSync(workflowId)?.whenIdle();
}

export const nodeInDb = (workflowId: string, id: string): Node =>
  db.nodesOf(workflowId).find((n) => n.id === id) as Node;
