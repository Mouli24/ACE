import { derivePorts, type Edge, type Node } from '@ace/contracts';

import { newId } from '../../lib/ulid';
import { DUPLICATE_OFFSET } from '../duplicate';
import { freeSlotNear } from '../placement';

/** Marks clipboard text as ACE nodes, so a paste never mistakes arbitrary JSON for a graph. */
export const CLIPBOARD_MARKER = 'ace/nodes@1';

export interface ClipboardPayload {
  marker: typeof CLIPBOARD_MARKER;
  sourceWorkflowId: string;
  nodes: Node[];
  /** Only edges whose two ends were both copied. */
  edges: Edge[];
}

let memory: ClipboardPayload | undefined;

/** The selected nodes and the edges between them, deep-copied (FR-CAN-013). */
export function copyNodes(
  sourceWorkflowId: string,
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeIds: readonly string[],
): ClipboardPayload | undefined {
  const ids = new Set(nodeIds);
  const picked = nodes.filter((n) => ids.has(n.id));
  if (picked.length === 0) return undefined;
  return {
    marker: CLIPBOARD_MARKER,
    sourceWorkflowId,
    nodes: structuredClone(picked),
    edges: structuredClone(edges.filter((e) => ids.has(e.from.nodeId) && ids.has(e.to.nodeId))),
  };
}

/** Keep `payload` for the next paste — in memory, and best-effort on the system clipboard. */
export function writeClipboard(payload: ClipboardPayload): void {
  memory = payload;
  try {
    void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => undefined);
  } catch {
    // no clipboard permission (or no clipboard): the in-memory copy is enough within this tab
  }
}

export function readClipboard(): ClipboardPayload | undefined {
  return memory;
}

/** Tests only. */
export function clearClipboard(): void {
  memory = undefined;
}

/** Parse clipboard text written by `writeClipboard` (another tab of ACE); anything else is ignored. */
export function parseClipboard(text: string): ClipboardPayload | undefined {
  try {
    const value = JSON.parse(text) as Partial<ClipboardPayload> | null;
    if (
      value &&
      value.marker === CLIPBOARD_MARKER &&
      Array.isArray(value.nodes) &&
      Array.isArray(value.edges) &&
      typeof value.sourceWorkflowId === 'string'
    ) {
      return value as ClipboardPayload;
    }
  } catch {
    // not JSON: not ours
  }
  return undefined;
}

/** A port id is `<nodeId>:<direction>:<name>` (contracts `portId`); swap the node part. */
function remapPort(portId: string, oldNodeId: string, newNodeId: string): string {
  return portId.startsWith(`${oldNodeId}:`)
    ? `${newNodeId}${portId.slice(oldNodeId.length)}`
    : portId;
}

/**
 * The nodes and edges a paste adds to `workflowId` (FR-CAN-013): new ids for everything, the same
 * kind, name and config, each node in a free slot near where it was copied from (so a paste into the
 * same workflow never hides the original), and the copied edges rewired to the new ids.
 */
export function pasteNodes(
  payload: ClipboardPayload,
  workflowId: string,
  existing: readonly Node[],
): { nodes: Node[]; edges: Edge[] } {
  const placed: Array<{ position: Node['position'] }> = [...existing];
  const idMap = new Map<string, string>();
  const nodes = payload.nodes.map((node) => {
    const id = newId();
    idMap.set(node.id, id);
    const position = freeSlotNear(placed, {
      x: node.position.x + DUPLICATE_OFFSET,
      y: node.position.y + DUPLICATE_OFFSET,
    });
    const copy = { ...structuredClone(node), id, workflowId, position } as Node;
    const withPorts = { ...copy, ...derivePorts(copy) } as Node;
    placed.push(withPorts);
    return withPorts;
  });

  const edges = payload.edges.flatMap((edge): Edge[] => {
    const from = idMap.get(edge.from.nodeId);
    const to = idMap.get(edge.to.nodeId);
    if (!from || !to) return [];
    return [
      {
        ...structuredClone(edge),
        id: newId(),
        workflowId,
        from: { nodeId: from, portId: remapPort(edge.from.portId, edge.from.nodeId, from) },
        to: { nodeId: to, portId: remapPort(edge.to.portId, edge.to.nodeId, to) },
      },
    ];
  });
  return { nodes, edges };
}
