import {
  DATA_TYPES,
  derivePorts,
  type DataType,
  type Edge,
  type GraphOp,
  type Model,
  type Node,
  type Port,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { checkConnection, type ConnectionAttempt } from './connect';

/*
 * Editing an existing data edge on the Canvas (FR-CON-001/002/004/006): changing the data type it
 * carries, and moving one of its ends. Pure plans the Canvas sends as one graph-ops batch (one undo
 * step, one `baseVersion`). Every verdict is `checkConnection`'s, judged on the graph without the
 * edge being edited, so an edge never blocks its own move.
 */

/** One row of the edge's type dropdown: the type, and whether picking it is possible right now. */
export type EdgeTypeOption =
  | { type: DataType; current: true; ok: true; ops: [] }
  | { type: DataType; current: false; ok: true; ops: GraphOp[]; note?: string }
  | { type: DataType; current: false; ok: false; reason: string };

/** The kinds whose ports follow their config's type lists — the only ones a type can be added to. */
const OUTPUT_TYPED_KINDS = new Set<Node['kind']>(['input', 'agent', 'model']);
const INPUT_TYPED_KINDS = new Set<Node['kind']>(['agent', 'model']);

const nameOf = (node: Node) => (node.name.trim() === '' ? 'This node' : `“${node.name}”`);

/** The catalog model a node runs on, when it names one the catalog lists. */
function modelOf(node: Node, models: readonly Model[]): Model | undefined {
  const config = node.config as { providerId?: string; modelId?: string };
  if (config.modelId === undefined || config.modelId === '') return undefined;
  return models.find(
    (model) =>
      model.modelId === config.modelId &&
      (config.providerId === undefined || model.providerId === config.providerId),
  );
}

/** `node` with `type` added to one of its type lists, ports re-derived as the engine would. */
function withType(node: Node, side: 'inputTypes' | 'outputTypes', type: DataType): Node {
  const config = node.config as Record<string, unknown>;
  const list = (config[side] as DataType[] | undefined) ?? [];
  const patched = { ...node, config: { ...config, [side]: [...list, type] } } as Node;
  return { ...patched, ...derivePorts(patched) };
}

type End =
  | { port: Port; node: Node; added: false }
  | { port: Port; node: Node; added: true; patch: GraphOp }
  | { reason: string };

/**
 * Whether a model can produce (`out`) or take (`in`) a data type. Code and JSON are text to a
 * model: any text model handles code, and JSON in; JSON out needs structured output
 * (`supportsJson`), which a CLI model never has (D353). Media types need the catalogue to list them.
 */
function modelHandles(model: Model, direction: 'in' | 'out', type: DataType): boolean {
  const types = direction === 'out' ? model.outputTypes : model.inputTypes;
  if (types.includes(type)) return true;
  if (!types.includes('text')) return false;
  if (type === 'code') return true;
  if (type === 'json') return direction === 'in' || model.supportsJson;
  return false;
}

/** The source's output port of `type`, or the one it would get by adding the type to its config. */
function sourceEnd(node: Node, type: DataType, models: readonly Model[]): End {
  const existing = node.outputs.find((port) => port.dataType === type);
  if (existing !== undefined) return { port: existing, node, added: false };
  if (!OUTPUT_TYPED_KINDS.has(node.kind)) {
    return {
      reason: `${nameOf(node)} has no ${type} output — a ${node.kind} node's outputs are fixed.`,
    };
  }
  const model = modelOf(node, models);
  if (model !== undefined && !modelHandles(model, 'out', type)) {
    return { reason: `${model.displayName} cannot produce ${type}.` };
  }
  const next = withType(node, 'outputTypes', type);
  const port = next.outputs.find((p) => p.dataType === type);
  if (port === undefined) return { reason: `${nameOf(node)} cannot output ${type}.` };
  const outputTypes = (next.config as { outputTypes: DataType[] }).outputTypes;
  return {
    port,
    node: next,
    added: true,
    patch: { op: 'update_node', nodeId: node.id, patch: { config: { outputTypes } } },
  };
}

/** The target's input port of `type`, or the one it would get by adding the type to its config. */
function targetEnd(node: Node, type: DataType, models: readonly Model[]): End {
  const existing = node.inputs.find((port) => port.dataType === type);
  if (existing !== undefined) return { port: existing, node, added: false };
  if (node.kind === 'input')
    return { reason: `${nameOf(node)} is an Input node and takes no input.` };
  if (!INPUT_TYPED_KINDS.has(node.kind)) {
    return {
      reason: `${nameOf(node)} has no ${type} input — a ${node.kind} node's inputs are fixed.`,
    };
  }
  const model = modelOf(node, models);
  if (model !== undefined && !modelHandles(model, 'in', type)) {
    return { reason: `${model.displayName} cannot take ${type} input.` };
  }
  const next = withType(node, 'inputTypes', type);
  const port = next.inputs.find((p) => p.dataType === type);
  if (port === undefined) return { reason: `${nameOf(node)} cannot take ${type}.` };
  const inputTypes = (next.config as { inputTypes: DataType[] }).inputTypes;
  return {
    port,
    node: next,
    added: true,
    patch: { op: 'update_node', nodeId: node.id, patch: { config: { inputTypes } } },
  };
}

/**
 * Every data type an edge could carry, each with whether it can right now (FR-CON-006): picking one
 * re-points the edge to the source's output and the target's input of that type, adding the type to
 * a node's `outputTypes`/`inputTypes` where the node's kind allows it and its model can serve it.
 * What would be refused is listed with the reason, never hidden.
 */
export function edgeTypeOptions(
  nodes: readonly Node[],
  edges: readonly Edge[],
  edgeId: string,
  models: readonly Model[],
  workflowId: string,
): EdgeTypeOption[] {
  const edge = edges.find((e) => e.id === edgeId);
  const from = nodes.find((node) => node.id === edge?.from.nodeId);
  const to = nodes.find((node) => node.id === edge?.to.nodeId);
  if (edge === undefined || edge.kind !== 'data' || from === undefined || to === undefined)
    return [];
  const currentType = from.outputs.find((port) => port.id === edge.from.portId)?.dataType;
  const others = edges.filter((e) => e.id !== edge.id);

  return DATA_TYPES.map((type): EdgeTypeOption => {
    if (type === currentType) return { type, current: true, ok: true, ops: [] };
    const source = sourceEnd(from, type, models);
    if ('reason' in source) return { type, current: false, ok: false, reason: source.reason };
    const target = targetEnd(to, type, models);
    if ('reason' in target) return { type, current: false, ok: false, reason: target.reason };
    const hypothetical = nodes.map((node) =>
      node.id === source.node.id ? source.node : node.id === target.node.id ? target.node : node,
    );
    const verdict = checkConnection(hypothetical, others, {
      source: from.id,
      sourceHandle: source.port.id,
      target: to.id,
      targetHandle: target.port.id,
    });
    if (!verdict.ok) return { type, current: false, ok: false, reason: verdict.reason };
    const added = [
      ...(source.added ? [`${type} output on ${nameOf(from)}`] : []),
      ...(target.added ? [`${type} input on ${nameOf(to)}`] : []),
    ];
    const ops: GraphOp[] = [
      ...(source.added ? [source.patch] : []),
      ...(target.added ? [target.patch] : []),
      { op: 'delete_edge', edgeId: edge.id },
      {
        op: 'add_edge',
        edge: {
          id: newId(),
          workflowId,
          kind: 'data',
          from: { nodeId: from.id, portId: source.port.id },
          to: { nodeId: to.id, portId: target.port.id },
          // D405: a debate edge stays one whatever it carries.
          ...(edge.debate === undefined ? {} : { debate: edge.debate }),
        },
      },
    ];
    return {
      type,
      current: false,
      ok: true,
      ops,
      ...(added.length === 0 ? {} : { note: `adds a ${added.join(' and a ')}` }),
    };
  });
}

/** Which end of an edge is being moved. */
export type EdgeEnd = 'source' | 'target';

/** The edges a moved end is judged against: every edge but the one being moved. */
export const withoutEdge = (edges: readonly Edge[], edgeId: string): Edge[] =>
  edges.filter((edge) => edge.id !== edgeId);

/**
 * Moving one end of a data edge (FR-CON-001): the attempt it becomes, checked on the graph without
 * the edge, and the batch that makes it — delete the old edge and add the new one (`update_edge`
 * patches only a loop config). Dropped back where it was: nothing to do.
 */
export function reconnectPlan(
  nodes: readonly Node[],
  edges: readonly Edge[],
  edgeId: string,
  attempt: ConnectionAttempt,
  workflowId: string,
): { kind: 'same' } | { kind: 'refuse'; reason: string } | { kind: 'ok'; ops: GraphOp[] } {
  const edge = edges.find((e) => e.id === edgeId);
  if (edge === undefined) return { kind: 'refuse', reason: 'That connection is gone.' };
  // A loop edge keeps its own menu (FR-CON-007): it is redrawn, never dragged to a new end.
  if (edge.kind !== 'data') return { kind: 'refuse', reason: 'A loop edge cannot be moved.' };
  if (
    attempt.sourceHandle === edge.from.portId &&
    attempt.targetHandle === edge.to.portId &&
    attempt.source === edge.from.nodeId &&
    attempt.target === edge.to.nodeId
  ) {
    return { kind: 'same' };
  }
  const verdict = checkConnection(nodes, withoutEdge(edges, edgeId), attempt);
  if (!verdict.ok) return { kind: 'refuse', reason: verdict.reason };
  return {
    kind: 'ok',
    ops: [
      { op: 'delete_edge', edgeId },
      {
        op: 'add_edge',
        edge: {
          id: newId(),
          workflowId,
          kind: 'data',
          from: { nodeId: verdict.fromNodeId, portId: verdict.source.id },
          to: { nodeId: verdict.toNodeId, portId: verdict.target.id },
          // D405: moving an end keeps the debate; the engine checks it against the new ends.
          ...(edge.debate === undefined ? {} : { debate: edge.debate }),
        },
      },
    ],
  };
}
