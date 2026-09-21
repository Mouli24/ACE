import { describe, expect, it } from 'vitest';

import {
  GRAPH_OPS_MAX,
  GRAPH_OPS_MIN,
  GraphOpSchema,
  GraphOpsRequestSchema,
  GraphOpsResponseSchema,
  nodeConfigPatchSchema,
} from '../graph-ops.js';
import { EDGE_ID, NODE_A, NODE_B, WORKFLOW_ID } from './fixtures.js';

const outputNode = {
  id: NODE_B,
  workflowId: WORKFLOW_ID,
  kind: 'output' as const,
  name: 'Output',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [],
  config: {},
};

const dataEdge = {
  id: EDGE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'data' as const,
  from: { nodeId: NODE_A, portId: NODE_A + ':out:text' },
  to: { nodeId: NODE_B, portId: NODE_B + ':in:text' },
};

const moveOp = { op: 'move_node', nodeId: NODE_A, position: { x: 1, y: 2 } };

describe('FR-WF-004 GraphOp variants', () => {
  it.each([
    ['add_node', { op: 'add_node', node: outputNode }],
    ['update_node', { op: 'update_node', nodeId: NODE_A, patch: { name: 'Renamed' } }],
    ['move_node', moveOp],
    ['delete_node', { op: 'delete_node', nodeId: NODE_A }],
    ['add_edge', { op: 'add_edge', edge: dataEdge }],
    [
      'update_edge',
      {
        op: 'update_edge',
        edgeId: EDGE_ID,
        patch: {
          loop: {
            maxIterations: 3,
            exitCondition: { path: '$.done', equals: true },
            onMax: 'fail',
          },
        },
      },
    ],
    ['delete_edge', { op: 'delete_edge', edgeId: EDGE_ID }],
  ])('parses the %s op', (_label, op) => {
    expect(GraphOpSchema.safeParse(op).success).toBe(true);
  });

  it('declares exactly the seven ops of §2.6', () => {
    expect(GraphOpSchema.options).toHaveLength(7);
  });

  it('rejects an op name §2.6 does not define', () => {
    expect(GraphOpSchema.safeParse({ op: 'rename_node', nodeId: NODE_A }).success).toBe(false);
  });

  it('rejects an add_node whose node is malformed', () => {
    expect(
      GraphOpSchema.safeParse({ op: 'add_node', node: { ...outputNode, id: 'node-1' } }).success,
    ).toBe(false);
  });

  it('accepts an empty update_node patch', () => {
    expect(
      GraphOpSchema.safeParse({ op: 'update_node', nodeId: NODE_A, patch: {} }).success,
    ).toBe(true);
  });
});

describe('FR-WF-004 GraphOpsRequest bounds', () => {
  const request = (count: number) => ({
    baseVersion: 0,
    ops: Array.from({ length: count }, () => moveOp),
  });

  it('applies 1..200 ops in one transaction', () => {
    expect(GRAPH_OPS_MIN).toBe(1);
    expect(GRAPH_OPS_MAX).toBe(200);
  });

  it.each([1, 2, 199, 200])('accepts a batch of %i ops', (count) => {
    expect(GraphOpsRequestSchema.safeParse(request(count)).success).toBe(true);
  });

  it.each([0, 201, 500])('rejects a batch of %i ops', (count) => {
    expect(GraphOpsRequestSchema.safeParse(request(count)).success).toBe(false);
  });

  it.each([
    ['a negative baseVersion', -1],
    ['a fractional baseVersion', 1.5],
  ])('rejects %s', (_label, baseVersion) => {
    expect(GraphOpsRequestSchema.safeParse({ ...request(1), baseVersion }).success).toBe(false);
  });

  it('accepts baseVersion 0', () => {
    expect(GraphOpsRequestSchema.safeParse(request(1)).success).toBe(true);
  });
});

describe('FR-WF-005 GraphOpsResponse', () => {
  it('carries the new version with the whole graph', () => {
    const response = { version: 1, nodes: [outputNode], edges: [dataEdge] };

    expect(GraphOpsResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a response without a version', () => {
    expect(GraphOpsResponseSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false);
  });
});

describe('FR-NODE-007 update_node config patch is validated per kind', () => {
  it('accepts a patch that touches one agent field only', () => {
    expect(nodeConfigPatchSchema('agent').safeParse({ instructions: 'Rewrite' }).success).toBe(true);
  });

  it('rejects an out-of-range execution setting inside an agent patch', () => {
    expect(
      nodeConfigPatchSchema('agent').safeParse({ execution: { temperature: 5 } }).success,
    ).toBe(false);
  });

  it('rejects a merge mode §2.4 does not define', () => {
    expect(nodeConfigPatchSchema('merge').safeParse({ mode: 'both' }).success).toBe(false);
    expect(nodeConfigPatchSchema('merge').safeParse({ mode: 'any' }).success).toBe(true);
  });

  it('rejects a retrieval k above 20 inside a patch', () => {
    expect(nodeConfigPatchSchema('retrieval').safeParse({ k: 21 }).success).toBe(false);
    expect(nodeConfigPatchSchema('retrieval').safeParse({ k: 3 }).success).toBe(true);
  });

  it('keeps the patched field instead of stripping it at request level', () => {
    // A strict union member would match any fully-optional patch and delete the key, so an
    // `execution` patch would arrive at the engine as `{}` and silently do nothing.
    const parsed = GraphOpSchema.parse({
      op: 'update_node',
      nodeId: NODE_A,
      patch: { config: { execution: { temperature: 5 } } },
    });

    expect(parsed).toMatchObject({
      patch: { config: { execution: { temperature: 5 } } },
    });
  });

  it('accepts an empty patch for every kind', () => {
    for (const kind of [
      'input',
      'output',
      'agent',
      'model',
      'merge',
      'transform',
      'retrieval',
      'guardrail',
      'custom',
    ] as const) {
      expect(nodeConfigPatchSchema(kind).safeParse({}).success).toBe(true);
    }
  });
});
