import {
  derivePorts,
  isConnectionAllowed,
  validateLoopConfig,
  nodeConfigPatchSchema,
  portId,
  type Edge,
  type GraphOp,
  type Node,
  type ValidationIssue,
  type Workflow,
} from '@ace/contracts';

import { wouldCloseCycle } from '../lib/cycle';
import { newId } from '../lib/ulid';

/**
 * The graph rules the real engine enforces on `POST /workflows/:id/graph-ops` (§2.6) and
 * `POST /workflows/:id/validate` (§2.5), mirrored for the mock so the UI is exercised against the
 * same refusals it will meet in round 1 cross-testing.
 */

export type ApplyResult =
  | { ok: true; nodes: Node[]; edges: Edge[] }
  | { ok: false; status: 400 | 501; code: string; message: string; issues: ValidationIssue[] };

const issue = (
  code: string,
  message: string,
  ref: { nodeId?: string; edgeId?: string } = {},
): ValidationIssue => ({ severity: 'error', code, message, ...ref });

const fail = (issues: ValidationIssue[]): ApplyResult => ({
  ok: false,
  status: 400,
  code: 'validation_failed',
  message: issues[0]?.message ?? 'Invalid graph operation.',
  issues,
});

export function applyOpsWithRules(
  workflowId: string,
  nodes: readonly Node[],
  edges: readonly Edge[],
  ops: readonly GraphOp[],
): ApplyResult {
  let nextNodes = [...nodes];
  let nextEdges = [...edges];

  for (const op of ops) {
    switch (op.op) {
      case 'add_node': {
        if (op.node.workflowId !== workflowId) {
          return fail([issue('validation_failed', 'Node belongs to another workflow.')]);
        }
        if (nextNodes.some((n) => n.id === op.node.id)) {
          return fail([issue('validation_failed', `Node ${op.node.id} already exists.`)]);
        }
        nextNodes.push({ ...op.node, ...derivePorts(op.node) } as Node);
        break;
      }

      case 'update_node': {
        const index = nextNodes.findIndex((n) => n.id === op.nodeId);
        const current = nextNodes[index];
        if (!current) return fail([issue('validation_failed', `Unknown node ${op.nodeId}.`)]);
        let config = current.config;
        if (op.patch.config) {
          const parsed = nodeConfigPatchSchema(current.kind).safeParse(op.patch.config);
          if (!parsed.success) {
            const first = parsed.error.issues[0];
            const path = first?.path.join('.') ?? '';
            return fail([
              issue(
                path.startsWith('execution') ? 'invalid_execution_setting' : 'validation_failed',
                `${path}: ${first?.message ?? 'invalid'}`,
                { nodeId: current.id },
              ),
            ]);
          }
          config = { ...current.config, ...parsed.data };
        }
        const patched = { ...current, name: op.patch.name ?? current.name, config } as Node;
        nextNodes[index] = { ...patched, ...derivePorts(patched) } as Node;
        break;
      }

      case 'move_node': {
        const index = nextNodes.findIndex((n) => n.id === op.nodeId);
        const current = nextNodes[index];
        if (!current) return fail([issue('validation_failed', `Unknown node ${op.nodeId}.`)]);
        nextNodes[index] = { ...current, position: op.position } as Node;
        break;
      }

      case 'delete_node': {
        if (!nextNodes.some((n) => n.id === op.nodeId)) {
          return fail([issue('validation_failed', `Unknown node ${op.nodeId}.`)]);
        }
        nextNodes = nextNodes.filter((n) => n.id !== op.nodeId);
        nextEdges = nextEdges.filter(
          (e) => e.from.nodeId !== op.nodeId && e.to.nodeId !== op.nodeId,
        );
        break;
      }

      case 'add_edge': {
        const edge = op.edge;
        if (nextEdges.some((e) => e.id === edge.id)) {
          return fail([issue('validation_failed', `Edge ${edge.id} already exists.`)]);
        }
        /*
         * A loop edge is the graph's one legal cycle from round 3 (FR-CON-007, BR-05), so it is
         * judged by the contract's own `validateLoopConfig` rather than by the data-edge rules: the
         * port compatibility and the cycle check below would both refuse it on principle. Its
         * refusal code is the issue code, which is what puts "maxIterations must be 1..50" in front
         * of the operator with a 400 (TC-CON-007).
         */
        if (edge.kind === 'loop') {
          const check = validateLoopConfig(edge, { nodes: nextNodes, edges: nextEdges });
          if (!check.ok) return fail([issue(check.code, check.reason, { edgeId: edge.id })]);
          nextEdges.push(edge);
          break;
        }
        const from = nextNodes.find((n) => n.id === edge.from.nodeId);
        const to = nextNodes.find((n) => n.id === edge.to.nodeId);
        const source = from?.outputs.find((p) => p.id === edge.from.portId);
        const target = to?.inputs.find((p) => p.id === edge.to.portId);
        if (!source || !target) {
          return fail([
            issue('validation_failed', 'Edge refers to an unknown node or port.', {
              edgeId: edge.id,
            }),
          ]);
        }
        const into = nextEdges.filter((e) => e.to.portId === target.id).length;
        const check = isConnectionAllowed(source, target, into);
        if (!check.ok) return fail([issue(check.code, check.reason, { edgeId: edge.id })]);
        if (wouldCloseCycle(nextEdges, edge.from.nodeId, edge.to.nodeId)) {
          return fail([
            issue('cycle', 'This edge would close a cycle; use a loop edge (round 3) instead.', {
              edgeId: edge.id,
            }),
          ]);
        }
        nextEdges.push(edge);
        break;
      }

      case 'update_edge': {
        const index = nextEdges.findIndex((e) => e.id === op.edgeId);
        const current = nextEdges[index];
        if (!current) return fail([issue('validation_failed', `Unknown edge ${op.edgeId}.`)]);
        const patched = { ...current, ...(op.patch.loop ? { loop: op.patch.loop } : {}) };
        // The same rule as on the way in: an out-of-range edit is refused, not stored (TC-CON-007).
        if (patched.kind === 'loop') {
          const check = validateLoopConfig(patched, {
            nodes: nextNodes,
            edges: nextEdges.filter((e) => e.id !== patched.id),
          });
          if (!check.ok) return fail([issue(check.code, check.reason, { edgeId: patched.id })]);
        }
        nextEdges[index] = patched;
        break;
      }

      case 'delete_edge': {
        if (!nextEdges.some((e) => e.id === op.edgeId)) {
          return fail([issue('validation_failed', `Unknown edge ${op.edgeId}.`)]);
        }
        nextEdges = nextEdges.filter((e) => e.id !== op.edgeId);
        break;
      }
    }
  }

  return { ok: true, nodes: nextNodes, edges: nextEdges };
}

/** `POST /workflows/:id/validate` (FR-WF-006), round 1 codes from §2.5. */
export function validateGraph(nodes: readonly Node[], edges: readonly Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!nodes.some((n) => n.kind === 'input')) {
    issues.push(issue('no_input_node', 'The workflow has no Input node.'));
  }
  if (!nodes.some((n) => n.kind === 'output')) {
    issues.push(issue('no_output_node', 'The workflow has no Output node.'));
  }

  for (const node of nodes) {
    if (node.kind === 'agent' || node.kind === 'model' || node.kind === 'transform') {
      for (const port of node.inputs) {
        if (!edges.some((e) => e.to.portId === port.id)) {
          issues.push(
            issue(
              'unconnected_required_input',
              `"${node.name}" input "${port.name}" is not connected.`,
              {
                nodeId: node.id,
              },
            ),
          );
        }
      }
    }
    if (node.kind === 'output' && !edges.some((e) => e.to.nodeId === node.id)) {
      issues.push(
        issue('unconnected_required_input', `Output "${node.name}" receives nothing.`, {
          nodeId: node.id,
        }),
      );
    }
    if ((node.kind === 'agent' || node.kind === 'model') && !node.config.modelId) {
      issues.push({
        severity: 'warning',
        code: 'missing_model',
        message: `"${node.name}" has no model (providers arrive in round 2).`,
        nodeId: node.id,
      });
    }
  }

  return issues;
}

/** Copy a graph into another workflow with fresh node, edge and port ids (duplicate, import). */
export function cloneGraph(
  target: Workflow,
  nodes: readonly Node[],
  edges: readonly Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const idMap = new Map<string, string>();
  for (const node of nodes) idMap.set(node.id, newId());

  const remapPort = (oldPortId: string, oldNodeId: string): string => {
    const newNodeId = idMap.get(oldNodeId) ?? oldNodeId;
    const [, direction, name] = oldPortId.split(':');
    return portId(newNodeId, direction === 'in' ? 'in' : 'out', name ?? '');
  };

  const newNodes = nodes.map((node) => {
    const id = idMap.get(node.id) ?? node.id;
    const base = { ...node, id, workflowId: target.id } as Node;
    return { ...base, ...derivePorts(base) } as Node;
  });

  const newEdges = edges.map((edge) => ({
    ...edge,
    id: newId(),
    workflowId: target.id,
    from: {
      nodeId: idMap.get(edge.from.nodeId) ?? edge.from.nodeId,
      portId: remapPort(edge.from.portId, edge.from.nodeId),
    },
    to: {
      nodeId: idMap.get(edge.to.nodeId) ?? edge.to.nodeId,
      portId: remapPort(edge.to.portId, edge.to.nodeId),
    },
  }));

  return { nodes: newNodes, edges: newEdges };
}
