import type { Edge, GraphOp, Node, Position } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { applyNewNodeInit, createNode, type NewNodeInit } from '../nodes/factory';
import { agentsOf } from '../theme/agents';
import { checkConnection } from './connect';

/*
 * The graph edits behind the theme's canvas actions (D332, D333), as pure plans: the Canvas sends
 * each plan through the graph editor as one undo step.
 */

/**
 * D333 "Remove node": delete the node, then join every incoming data edge to every outgoing one —
 * `u.out → node → v.in` becomes `u.out → v.in` wherever that edge would be valid once the node is
 * gone (types compatible, `v.in` free once its edge from the node went, no cycle). The node's loop
 * edges go with it.
 */
export function removeReconnectingOps(
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeId: string,
  workflowId: string,
): GraphOp[] {
  if (!nodes.some((node) => node.id === nodeId)) return [];
  const incoming = edges.filter((e) => e.kind === 'data' && e.to.nodeId === nodeId);
  const outgoing = edges.filter((e) => e.kind === 'data' && e.from.nodeId === nodeId);
  const rest = nodes.filter((node) => node.id !== nodeId);
  let kept = edges.filter((e) => e.from.nodeId !== nodeId && e.to.nodeId !== nodeId);
  const added: Edge[] = [];
  for (const into of incoming) {
    for (const out of outgoing) {
      const duplicate = kept.some(
        (e) => e.from.portId === into.from.portId && e.to.portId === out.to.portId,
      );
      if (duplicate) continue;
      const verdict = checkConnection(rest, kept, {
        source: into.from.nodeId,
        sourceHandle: into.from.portId,
        target: out.to.nodeId,
        targetHandle: out.to.portId,
      });
      if (!verdict.ok) continue;
      const edge: Edge = {
        id: newId(),
        workflowId,
        kind: 'data',
        from: { ...into.from },
        to: { ...out.to },
      };
      kept = [...kept, edge];
      added.push(edge);
    }
  }
  return [
    { op: 'delete_node', nodeId },
    ...added.map((edge) => ({ op: 'add_edge' as const, edge })),
  ];
}

/** Where the theme's first stage stands when there is none yet. */
export const FIRST_STAGE_AT: Position = { x: 440, y: 150 };
export const NEW_STAGE_NAME = 'New agent';

export interface NewStagePlan {
  node: Node;
  ops: GraphOp[];
}

/**
 * The theme's "Add node" (D332, amended by D351): a new Agent named "New agent" after the last
 * stage — 320 to the right and 50 up or down, alternating — or at (440, 150) on an empty board;
 * on the provider and model the person chose in the provider-first picker (PG-1.3: never a default
 * one); linked from the last stage's first output to its first input when that edge is valid.
 */
export function planNewStage({
  nodes,
  edges,
  workflowId,
  choice,
}: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  workflowId: string;
  choice: { providerId: string; modelId: string };
}): NewStagePlan {
  const stages = agentsOf(nodes);
  const lastId = stages[stages.length - 1]?.nodeId;
  const last = nodes.find((node) => node.id === lastId);
  const k = stages.length + 1;
  const position = last
    ? { x: last.position.x + 320, y: last.position.y + (k % 2 ? 50 : -50) }
    : FIRST_STAGE_AT;

  const init: NewNodeInit = {
    name: NEW_STAGE_NAME,
    providerId: choice.providerId,
    modelId: choice.modelId,
  };
  const node = applyNewNodeInit(createNode('agent', workflowId, position), init);

  const ops: GraphOp[] = [{ op: 'add_node', node }];
  const from = last?.outputs[0];
  const to = node.inputs[0];
  if (last !== undefined && from !== undefined && to !== undefined) {
    const verdict = checkConnection([...nodes, node], edges, {
      source: last.id,
      sourceHandle: from.id,
      target: node.id,
      targetHandle: to.id,
    });
    if (verdict.ok) {
      ops.push({
        op: 'add_edge',
        edge: {
          id: newId(),
          workflowId,
          kind: 'data',
          from: { nodeId: last.id, portId: from.id },
          to: { nodeId: node.id, portId: to.id },
        },
      });
    }
  }
  return { node, ops };
}

/** Every node's position at one moment: one step of the theme's position history. */
export type PositionSnapshot = Readonly<Record<string, Position>>;

/** The theme keeps the last 31 snapshots (`history.slice(-30)` plus the new one). */
export const MOVE_HISTORY_LIMIT = 31;

export const snapshotPositions = (nodes: readonly Node[]): PositionSnapshot =>
  Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]));

/** The moves that put the nodes back where `snapshot` had them; none when nothing moved. */
export function movesBack(snapshot: PositionSnapshot, nodes: readonly Node[]): GraphOp[] {
  return nodes.flatMap((node) => {
    const was = snapshot[node.id];
    return was !== undefined && (was.x !== node.position.x || was.y !== node.position.y)
      ? [{ op: 'move_node' as const, nodeId: node.id, position: { ...was } }]
      : [];
  });
}

/**
 * The theme's undo-move: the latest snapshot that would move something, and the history left
 * once it is taken. Snapshots that match the board as it is (a press that never dragged) are
 * dropped on the way, so one click of undo always moves something when anything can move.
 */
export function takeMoveBack(
  history: readonly PositionSnapshot[],
  nodes: readonly Node[],
): { ops: GraphOp[]; rest: PositionSnapshot[] } {
  const rest = [...history];
  while (rest.length > 0) {
    const ops = movesBack(rest.pop() as PositionSnapshot, nodes);
    if (ops.length > 0) return { ops, rest };
  }
  return { ops: [], rest };
}
