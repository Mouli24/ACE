import {
  derivePorts,
  type Edge,
  type GraphOp,
  type Node,
  type WorkflowGraphResponse,
} from '@ace/contracts';

/**
 * Apply §2.6 graph operations to a graph the same way the engine does, so the optimistic cache
 * (FR-WF-004) shows what the engine will answer. Pure: returns a new graph, never mutates.
 * The engine owns `version` (BR-01); it is copied through unchanged.
 */
export function applyOps(
  graph: WorkflowGraphResponse,
  ops: readonly GraphOp[],
): WorkflowGraphResponse {
  let nodes: Node[] = graph.nodes;
  let edges: Edge[] = graph.edges;

  for (const op of ops) {
    switch (op.op) {
      case 'add_node':
        nodes = [...nodes, op.node];
        break;

      case 'update_node':
        nodes = nodes.map((node) => {
          if (node.id !== op.nodeId) return node;
          const patched = {
            ...node,
            name: op.patch.name ?? node.name,
            config: op.patch.config ? { ...node.config, ...op.patch.config } : node.config,
          } as Node;
          return { ...patched, ...derivePorts(patched) };
        });
        break;

      case 'move_node':
        nodes = nodes.map((node) =>
          node.id === op.nodeId ? { ...node, position: op.position } : node,
        );
        break;

      case 'delete_node':
        nodes = nodes.filter((node) => node.id !== op.nodeId);
        edges = edges.filter((e) => e.from.nodeId !== op.nodeId && e.to.nodeId !== op.nodeId);
        break;

      case 'add_edge':
        edges = [...edges, op.edge];
        break;

      case 'update_edge':
        edges = edges.map((e) => {
          if (e.id !== op.edgeId) return e;
          const next = { ...e, ...(op.patch.loop ? { loop: op.patch.loop } : {}) };
          // D405: `debate: null` turns the debate off; absent leaves it as it is.
          if (op.patch.debate === undefined) return next;
          const { debate: _was, ...plain } = next;
          return op.patch.debate === null ? plain : { ...plain, debate: op.patch.debate };
        });
        break;

      case 'delete_edge':
        edges = edges.filter((e) => e.id !== op.edgeId);
        break;
    }
  }

  return { workflow: graph.workflow, nodes, edges };
}
