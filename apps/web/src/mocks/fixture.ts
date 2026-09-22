import { derivePorts, portId, type DataType, type Edge, type Node } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import type { MockDb } from './db';

export const PERF_FIXTURE = {
  nodes: 200,
  edges: 400,
  projectName: 'Perf fixture',
  workflowName: '200 nodes',
};

const ROWS = 10;
const COLS = 20;
const TYPES: DataType[] = ['text', 'code', 'json'];

/**
 * A 200-node / 400-edge graph for the frame-time test (NFR-PERF-01): a 20 × 10 grid of agents
 * with three typed inputs each, wired column to column (never backwards, so no cycles; one edge
 * per single input, so no occupied ports). Idempotent so reloads land on the same workflow.
 */
export function seedPerfFixture(db: MockDb): { projectId: string; workflowId: string } {
  const existing = db.listProjects().find((p) => p.name === PERF_FIXTURE.projectName);
  if (existing) {
    const workflow = db
      .listWorkflows(existing.id)
      .find((w) => w.name === PERF_FIXTURE.workflowName);
    if (workflow) return { projectId: existing.id, workflowId: workflow.id };
  }

  const project = existing ?? db.createProject({ name: PERF_FIXTURE.projectName });
  const workflow = db.createWorkflow(project.id, PERF_FIXTURE.workflowName);

  const grid: Node[][] = [];
  const nodes: Node[] = [];
  for (let c = 0; c < COLS; c += 1) {
    const column: Node[] = [];
    for (let r = 0; r < ROWS; r += 1) {
      const base = createNode('agent', workflow.id, { x: c * 280, y: r * 170 });
      const agent = {
        ...base,
        name: `Agent ${c + 1}-${r + 1}`,
        config: { ...base.config, inputTypes: TYPES, outputTypes: TYPES },
      } as Node;
      const withPorts = { ...agent, ...derivePorts(agent) } as Node;
      column.push(withPorts);
      nodes.push(withPorts);
    }
    grid.push(column);
  }

  const edges: Edge[] = [];
  outer: for (let c = 1; c < COLS; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      for (let t = 0; t < TYPES.length; t += 1) {
        const type = TYPES[t] as DataType;
        const from = (grid[c - 1] as Node[])[(r + t) % ROWS] as Node;
        const to = (grid[c] as Node[])[r] as Node;
        edges.push({
          id: newId(),
          workflowId: workflow.id,
          kind: 'data',
          from: { nodeId: from.id, portId: portId(from.id, 'out', type) },
          to: { nodeId: to.id, portId: portId(to.id, 'in', type) },
        });
        if (edges.length === PERF_FIXTURE.edges) break outer;
      }
    }
  }

  db.commitGraph(workflow.id, nodes, edges, { silent: true });
  return { projectId: project.id, workflowId: workflow.id };
}
