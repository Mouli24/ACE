import type { Edge, GraphOp, LoopConfig, Node, Port } from '@ace/contracts';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  toast,
  tokens,
} from '@ace/ui';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport,
} from '@xyflow/react';
import { Copy, LayoutGrid, Maximize2, Redo2, Undo2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore } from '../app/stores/viewport';
import { loopEdgeType } from '../edges/loop/LoopEdge';
import { MakeLoopEdgeDialog, type LoopEdgeCandidate } from '../edges/loop/MakeLoopEdgeDialog';
import { canBeLoopEdge } from '../edges/loop/can-be-loop-edge';
import { newId } from '../lib/ulid';
import { useProviders } from '../providers/hooks';
import { nodeTypes, type AceFlowNode } from '../nodes/NodeCard';
import { edgeTypes } from '../nodes/TypedEdge';
import {
  NODE_KIND_LABEL,
  CANVAS_NODE_KINDS,
  applyNewNodeInit,
  createNode,
  type CanvasNodeKind,
  type NewNodeInit,
} from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { PALETTE_DRAG_TYPE, PALETTE_INIT_TYPE } from './drag';
import { useCanvasApi } from './canvas-api';
import { checkConnection, type ConnectionAttempt } from './connect';
import { DUPLICATE_OFFSET, duplicateNodes } from './duplicate';
import {
  copyNodes,
  parseClipboard,
  pasteNodes,
  readClipboard,
  writeClipboard,
  type ClipboardPayload,
} from './interactions/clipboard';
import { useGraphEditor, useHistoryDepth } from './interactions/use-graph-editor';
import { autoLayout } from './layout/auto-layout';
import { freeSlotNear } from './placement';
import { toFlowEdges, toFlowNodes } from './to-flow';

/** Both edge renderers: the typed data edge, and round 3's loop edge (FR-CON-007). */
const aceEdgeTypes = { ...edgeTypes, ...loopEdgeType };

export interface CanvasProps {
  workflowId: string;
  /**
   * FR-MOB-003: look, do not touch. Pan, zoom, select and inspect still work; adding, dragging,
   * connecting, deleting, pasting, undo/redo, auto-arrange and every editing menu item are off.
   */
  readOnly?: boolean;
}

/** Right-click target (FR-CAN-011): a node, or the empty Canvas at a flow position. */
type MenuTarget =
  { kind: 'node'; nodeId: string } | { kind: 'pane'; position: { x: number; y: number } };

const MOD = typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** The Canvas (FR-CAN-001..013): loading gate outside, React Flow inside. */
export function Canvas({ workflowId, readOnly = false }: CanvasProps) {
  const graph = useWorkflowGraph(workflowId);

  // FR-CAN-010: nodes and edges arrive in one response; nothing is drawn before both are here.
  if (!graph.data) {
    return (
      <div
        className="ace-dotted-canvas absolute inset-0 flex items-center justify-center"
        data-testid="canvas-loading"
        role="status"
        aria-live="polite"
      >
        <span className="rounded-chip border border-border bg-panel px-3 py-1 font-machine text-xs text-fg-muted">
          loading workflow…
        </span>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <CanvasInner
        workflowId={workflowId}
        nodes={graph.data.nodes}
        edges={graph.data.edges}
        readOnly={readOnly}
      />
    </ReactFlowProvider>
  );
}

/**
 * The optional name/model a New node drag carries. The data comes from any drag source, so only
 * string fields of a plain object are kept; anything else (or unreadable JSON) is ignored and the
 * kind still drops with its defaults.
 */
function readDropInit(event: DragEvent): NewNodeInit | undefined {
  const raw = event.dataTransfer.getData(PALETTE_INIT_TYPE);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  const init: NewNodeInit = {};
  if (typeof fields['name'] === 'string') init.name = fields['name'];
  if (typeof fields['providerId'] === 'string') init.providerId = fields['providerId'];
  if (typeof fields['modelId'] === 'string') init.modelId = fields['modelId'];
  return Object.keys(init).length > 0 ? init : undefined;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function CanvasInner({
  workflowId,
  nodes,
  edges,
  readOnly,
}: {
  workflowId: string;
  nodes: Node[];
  edges: Edge[];
  readOnly: boolean;
}) {
  const sync = useGraphSync(workflowId);
  /** Every user edit goes through here: one undo step, then autosave (FR-CAN-009, BR-01). */
  const editor = useGraphEditor(workflowId, sync);
  const { canUndo, canRedo } = useHistoryDepth(workflowId);
  const [menuTarget, setMenuTarget] = useState<MenuTarget>();
  const flow = useReactFlow<AceFlowNode>();
  const setSelection = useSelectionStore((s) => s.setSelection);
  const selectedNodeIds = useSelectionStore((s) => s.nodeIds);
  const selectedEdgeIds = useSelectionStore((s) => s.edgeIds);
  const savedViewport = useViewportStore((s) => s.viewports[workflowId]);
  const setViewport = useViewportStore((s) => s.setViewport);
  const [armedPortId, setArmedPortId] = useState<string>();
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number }>();
  /** A drawn arrow that closes a cycle and could legally be the loop edge (FR-CON-007). */
  const [loopCandidate, setLoopCandidate] = useState<LoopEdgeCandidate>();
  const wrapper = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- connections */

  /*
   * Whether a drawn arrow that a data edge may not be could be the loop edge instead (FR-CON-003 and
   * FR-CON-007 are the same drop seen twice).
   *
   * This is where the offer belongs: an *existing* data edge can never qualify — its target being
   * upstream of its source would already be the cycle the graph forbids — so the arrow has to be
   * caught as it is drawn. The contract decides; where it refuses, its reason is the second half of
   * what the operator is told, after the cycle itself.
   */
  const loopOffer = useCallback(
    (attempt: ConnectionAttempt): { candidate?: LoopEdgeCandidate; reason?: string } => {
      if (attempt.source === null || attempt.target === null) return {};
      const check = canBeLoopEdge(
        {
          id: newId(),
          from: { nodeId: attempt.source, portId: attempt.sourceHandle ?? '' },
          to: { nodeId: attempt.target, portId: attempt.targetHandle ?? '' },
        },
        nodes,
        edges,
      );
      if (!check.ok) return { reason: check.reason };
      return {
        candidate: {
          from: { nodeId: attempt.source, portId: attempt.sourceHandle ?? '' },
          to: { nodeId: attempt.target, portId: attempt.targetHandle ?? '' },
          fromNodeName: nodes.find((n) => n.id === attempt.source)?.name ?? 'this node',
          toNodeName: nodes.find((n) => n.id === attempt.target)?.name ?? 'that node',
        },
      };
    },
    [nodes, edges],
  );

  const tryConnect = useCallback(
    (attempt: Connection) => {
      if (readOnly) return false;
      const verdict = checkConnection(nodes, edges, attempt);
      if (!verdict.ok) {
        if (verdict.code === 'cycle') {
          const offer = loopOffer(attempt);
          if (offer.candidate !== undefined) {
            setLoopCandidate(offer.candidate);
            return false;
          }
          // Why it is refused *and* why it cannot be the loop edge either (NFR-USE-03).
          toast.error('Connection refused', {
            description: `${verdict.reason}${offer.reason === undefined ? '' : ` ${offer.reason}`}`,
          });
          return false;
        }
        toast.error('Connection refused', { description: verdict.reason });
        return false;
      }
      editor.edit(
        [
          {
            op: 'add_edge',
            edge: {
              id: newId(),
              workflowId,
              kind: 'data',
              from: { nodeId: verdict.fromNodeId, portId: verdict.source.id },
              to: { nodeId: verdict.toNodeId, portId: verdict.target.id },
            },
          },
        ],
        'Connect',
      );
      return true;
    },
    [nodes, edges, editor, workflowId, loopOffer, readOnly],
  );

  const isValidConnection = useCallback(
    (
      attempt:
        | Connection
        | {
            source: string;
            target: string;
            sourceHandle?: string | null;
            targetHandle?: string | null;
          },
    ) => {
      const normalised = {
        source: attempt.source,
        target: attempt.target,
        sourceHandle: attempt.sourceHandle ?? null,
        targetHandle: attempt.targetHandle ?? null,
      };
      if (checkConnection(nodes, edges, normalised).ok) return true;
      /*
       * A cycle that could be the loop edge is *valid to drop* — React Flow calls `onConnect` only
       * for a connection this accepts, and `tryConnect` is where the offer is made. Without this the
       * loop editor was unreachable: the drop was refused before anything could offer it (FR-CON-007).
       */
      return loopOffer(normalised).candidate !== undefined;
    },
    [nodes, edges, loopOffer],
  );

  /**
   * React Flow never calls onConnect for a drop `isValidConnection` refused, so the reason is
   * shown here instead (FR-CON-002/003/005: refused *with* a message).
   */
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.fromHandle || !state.toHandle) return;
      const attempt = {
        source:
          state.fromHandle.type === 'source'
            ? (state.fromNode?.id ?? null)
            : (state.toNode?.id ?? null),
        sourceHandle:
          (state.fromHandle.type === 'source' ? state.fromHandle.id : state.toHandle.id) ?? null,
        target:
          state.fromHandle.type === 'source'
            ? (state.toNode?.id ?? null)
            : (state.fromNode?.id ?? null),
        targetHandle:
          (state.fromHandle.type === 'source' ? state.toHandle.id : state.fromHandle.id) ?? null,
      };
      const verdict = checkConnection(nodes, edges, attempt);
      if (verdict.ok) return;
      const offer = verdict.code === 'cycle' ? loopOffer(attempt) : {};
      toast.error('Connection refused', {
        description: `${verdict.reason}${offer.reason === undefined ? '' : ` ${offer.reason}`}`,
      });
    },
    [nodes, edges, loopOffer],
  );

  /** Keyboard connect (NFR-USE-02): Enter on an output arms it, Enter on an input completes. */
  const onPortKey = useCallback(
    (port: Port, direction: 'in' | 'out', nodeId: string) => {
      if (readOnly) return;
      if (direction === 'out') {
        setArmedPortId((current) => (current === port.id ? undefined : port.id));
        toast.message(`Output “${port.name}” armed`, {
          description: 'Tab to an input port and press Enter to connect.',
        });
        return;
      }
      if (!armedPortId) return;
      const source = nodes.find((n) => n.outputs.some((p) => p.id === armedPortId));
      if (source) {
        tryConnect({
          source: source.id,
          sourceHandle: armedPortId,
          target: nodeId,
          targetHandle: port.id,
        });
      }
      setArmedPortId(undefined);
    },
    [armedPortId, nodes, tryConnect, readOnly],
  );

  /* ---------------------------------------------------------------- nodes */

  // Providers decide the accent colour and the "provider missing" badge (FR-NODE-010, FR-PRV-005).
  const providers = useProviders();
  const serverNodes = useMemo(
    () =>
      toFlowNodes(nodes, edges, armedPortId, onPortKey, providers.data ?? [], providers.isSuccess),
    [nodes, edges, armedPortId, onPortKey, providers.data, providers.isSuccess],
  );
  const [flowNodes, setFlowNodes] = useState<AceFlowNode[]>(serverNodes);

  // Server truth wins, but a node mid-drag keeps its live position until the drop is saved.
  useEffect(() => {
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return serverNodes.map((node) => {
        const prev = byId.get(node.id);
        const selected = selectedNodeIds.includes(node.id);
        if (!prev) return { ...node, selected };
        return {
          ...node,
          selected,
          measured: prev.measured,
          ...(prev.dragging ? { position: prev.position, dragging: true } : {}),
        };
      });
    });
  }, [serverNodes, selectedNodeIds]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AceFlowNode>[]) => {
      setFlowNodes((current) => applyNodeChanges(changes, current));
      const moves = changes.flatMap((c) =>
        c.type === 'position' && c.dragging === false && c.position
          ? [{ id: c.id, position: c.position }]
          : [],
      );
      if (moves.length > 0) {
        editor.edit(
          moves.map((m) => ({
            op: 'move_node' as const,
            nodeId: m.id,
            position: { x: Math.round(m.position.x), y: Math.round(m.position.y) },
          })),
          moves.length === 1 ? 'Move node' : `Move ${moves.length} nodes`,
        );
      }
    },
    [editor],
  );

  /**
   * Which nodes React Flow currently knows, as a string rather than the node array: `flowNodes` is
   * replaced on every drag pointer move, and depending on it rebuilt all 400 edge objects per frame
   * (NFR-PERF-01). Membership is what the edge filter below needs, and that only changes when a
   * node is added or removed.
   */
  const mountedIds = useMemo(
    () =>
      flowNodes
        .map((node) => node.id)
        .sort()
        .join(','),
    [flowNodes],
  );

  /*
   * The loop badge's numbers (FR-PAR-005). `revision` is what moves when a frame lands, and a loop
   * iteration is a handful of frames per run — so reading it here costs one extra edge rebuild per
   * iteration, not one per token.
   */
  const runRevision = useRunStore((store) => store.revision);
  const runIsLive = useRunStore(
    (store) => store.workflowId === workflowId && store.status === 'RUNNING',
  );

  const flowEdges = useMemo(() => {
    // React Flow drops an edge whose endpoints it does not know yet and does not retry, so an
    // edge is handed over only once both its nodes are mounted; this memo re-runs when they are.
    const mounted = new Set(mountedIds === '' ? [] : mountedIds.split(','));
    const connectable = edges.filter(
      (edge) => mounted.has(edge.from.nodeId) && mounted.has(edge.to.nodeId),
    );
    const store = useRunStore.getState();
    // The iteration a loop edge shows is the one its *target* is on: that is the node the loop
    // sends work back to, and the node whose re-runs are being counted.
    const live = (edge: Edge) => {
      const iteration = store.workflowId === workflowId ? store.iterations(edge.to.nodeId) : 0;
      return iteration > 0 ? { iteration, running: runIsLive } : { running: runIsLive };
    };
    return toFlowEdges(connectable, nodes, live).map((e) => ({
      ...e,
      selected: selectedEdgeIds.includes(e.id),
    }));
  }, [edges, nodes, mountedIds, selectedEdgeIds, workflowId, runRevision, runIsLive]);

  // Edges are fully derived from the query cache, so the only change to honour is selection.
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const selects = changes.filter((c) => c.type === 'select');
      if (selects.length === 0) return;
      const { nodeIds, edgeIds } = useSelectionStore.getState();
      const next = new Set(edgeIds);
      for (const change of selects) {
        if (change.type !== 'select') continue;
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      setSelection(nodeIds, [...next]);
    },
    [setSelection],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: OnSelectionChangeParams) => {
      setSelection(
        selNodes.map((n) => n.id),
        selEdges.map((e) => e.id),
      );
    },
    [setSelection],
  );

  /**
   * One deletion = one batch = one undo step (FR-CAN-009). Edges attached to a deleted node go with
   * it (the engine drops them), so only the other selected edges need their own `delete_edge`.
   */
  const deleteElements = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]) => {
      if (readOnly) return;
      const gone = new Set(nodeIds);
      const ops: GraphOp[] = [
        ...edgeIds
          .filter((id) => {
            const edge = edges.find((e) => e.id === id);
            return edge !== undefined && !gone.has(edge.from.nodeId) && !gone.has(edge.to.nodeId);
          })
          .map((edgeId) => ({ op: 'delete_edge' as const, edgeId })),
        ...nodeIds
          .filter((id) => nodes.some((n) => n.id === id))
          .map((nodeId) => ({ op: 'delete_node' as const, nodeId })),
      ];
      if (ops.length === 0) return;
      const label =
        nodeIds.length === 0
          ? edgeIds.length === 1
            ? 'Delete connection'
            : 'Delete connections'
          : nodeIds.length === 1
            ? 'Delete node'
            : `Delete ${nodeIds.length} nodes`;
      editor.edit(ops, label);
    },
    [editor, nodes, edges, readOnly],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: AceFlowNode[]; edges: Array<{ id: string }> }) =>
      deleteElements(
        gone.map((n) => n.id),
        cut.map((e) => e.id),
      ),
    [deleteElements],
  );

  const addNodeAt = useCallback(
    (kind: CanvasNodeKind, position: { x: number; y: number }, init?: NewNodeInit) => {
      if (readOnly) return undefined;
      const node = applyNewNodeInit(
        createNode(kind, workflowId, {
          x: Math.round(position.x),
          y: Math.round(position.y),
        }),
        init,
      );
      editor.edit([{ op: 'add_node', node }], 'Add node');
      setSelection([node.id], []);
      return node;
    },
    [editor, workflowId, setSelection, readOnly],
  );

  const addNodeAtCenter = useCallback(
    (kind: CanvasNodeKind, init?: NewNodeInit) => {
      if (readOnly) return undefined;
      const bounds = wrapper.current?.getBoundingClientRect();
      const left = bounds?.left ?? 0;
      const top = bounds?.top ?? 0;
      const width = bounds?.width ?? 800;
      const height = bounds?.height ?? 600;
      const topLeft = flow.screenToFlowPosition({ x: left, y: top });
      const bottomRight = flow.screenToFlowPosition({ x: left + width, y: top + height });
      const center = flow.screenToFlowPosition({ x: left + width / 2, y: top + height / 2 });
      const visible = {
        x: topLeft.x,
        y: topLeft.y,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
      };

      // the first free spot: never on top of another card, whose ports would become unreachable
      const slot = freeSlotNear(nodes, { x: center.x - 90, y: center.y - 40 }, visible);
      const node = addNodeAt(kind, slot, init);

      // when the view was too crowded to hold it, bring the new node into sight
      const inView =
        slot.x >= visible.x &&
        slot.y >= visible.y &&
        slot.x <= visible.x + visible.width &&
        slot.y <= visible.y + visible.height;
      if (!inView) {
        requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 200 }));
      }
      return node;
    },
    [addNodeAt, flow, nodes, readOnly],
  );

  /** The nodes an action applies to: the selection, or the right-clicked node when outside it. */
  const targetIds = useCallback(
    (nodeId?: string) =>
      nodeId === undefined || selectedNodeIds.includes(nodeId) ? selectedNodeIds : [nodeId],
    [selectedNodeIds],
  );

  const duplicateNodesById = useCallback(
    (ids: readonly string[]) => {
      if (readOnly) return;
      const selected = nodes.filter((n) => ids.includes(n.id));
      if (selected.length === 0) return;
      const copies = duplicateNodes(selected, nodes);
      editor.edit(
        copies.map((node) => ({ op: 'add_node' as const, node })),
        copies.length === 1 ? 'Duplicate node' : `Duplicate ${copies.length} nodes`,
      );
      setSelection(
        copies.map((n) => n.id),
        [],
      );
    },
    [nodes, editor, setSelection, readOnly],
  );

  const duplicateSelection = useCallback(
    () => duplicateNodesById(selectedNodeIds),
    [duplicateNodesById, selectedNodeIds],
  );

  const fitView = useCallback(() => void flow.fitView({ padding: 0.2, duration: 200 }), [flow]);

  /** FR-CAN-012 Ctrl+A: every node selected (edges stay as they are: deleting all nodes takes them). */
  const selectAll = useCallback(
    () =>
      setSelection(
        nodes.map((n) => n.id),
        [],
      ),
    [nodes, setSelection],
  );

  /** FR-CAN-013: the nodes and the edges between them, kept for a paste here or in another workflow. */
  const copySelection = useCallback(
    (ids: readonly string[] = selectedNodeIds) => {
      const payload = copyNodes(workflowId, nodes, edges, ids);
      if (!payload) return false;
      writeClipboard(payload);
      toast.message(
        payload.nodes.length === 1 ? 'Copied 1 node' : `Copied ${payload.nodes.length} nodes`,
      );
      return true;
    },
    [workflowId, nodes, edges, selectedNodeIds],
  );

  /**
   * Paste with new ids, the same config, and the copied edges rewired (FR-CAN-013), as one undo
   * step. `at` (from the empty-Canvas menu) moves the group so it starts where the user clicked.
   */
  const pastePayload = useCallback(
    (payload: ClipboardPayload, at?: { x: number; y: number }) => {
      if (readOnly || payload.nodes.length === 0) return;
      let source = payload;
      if (at) {
        const minX = Math.min(...payload.nodes.map((n) => n.position.x));
        const minY = Math.min(...payload.nodes.map((n) => n.position.y));
        const dx = at.x - minX - DUPLICATE_OFFSET;
        const dy = at.y - minY - DUPLICATE_OFFSET;
        source = {
          ...payload,
          nodes: payload.nodes.map((n) => ({
            ...n,
            position: { x: n.position.x + dx, y: n.position.y + dy },
          })),
        };
      }
      const pasted = pasteNodes(source, workflowId, nodes);
      editor.edit(
        [
          ...pasted.nodes.map((node) => ({ op: 'add_node' as const, node })),
          ...pasted.edges.map((edge) => ({ op: 'add_edge' as const, edge })),
        ],
        pasted.nodes.length === 1 ? 'Paste node' : `Paste ${pasted.nodes.length} nodes`,
      );
      setSelection(
        pasted.nodes.map((n) => n.id),
        [],
      );
    },
    [readOnly, workflowId, nodes, editor, setSelection],
  );

  const paste = useCallback(
    (at?: { x: number; y: number }) => {
      if (readOnly) return;
      const held = readClipboard();
      if (held) {
        pastePayload(held, at);
        return;
      }
      // another tab of ACE may have put nodes on the system clipboard (best effort, may be denied)
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          const parsed = parseClipboard(text);
          if (parsed) pastePayload(parsed, at);
        })
        .catch(() => undefined);
    },
    [readOnly, pastePayload],
  );

  /**
   * FR-CAN-008 / ADR-010: lay the graph out left to right in one batch of `move_node` ops — one
   * undo step — using the sizes React Flow measured. Free dragging is untouched.
   */
  const autoArrange = useCallback(() => {
    if (readOnly || nodes.length === 0) return;
    const measured = new Map(flow.getNodes().map((n) => [n.id, n.measured]));
    const laid = autoLayout(
      nodes.map((n) => {
        const size = measured.get(n.id);
        return {
          id: n.id,
          position: n.position,
          ...(size?.width ? { width: size.width } : {}),
          ...(size?.height ? { height: size.height } : {}),
        };
      }),
      edges,
    );
    const ops: GraphOp[] = nodes.flatMap((n) => {
      const next = laid.get(n.id);
      return next && (next.x !== n.position.x || next.y !== n.position.y)
        ? [{ op: 'move_node' as const, nodeId: n.id, position: next }]
        : [];
    });
    if (ops.length > 0) editor.edit(ops, 'Auto-arrange');
    requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 200 }));
  }, [readOnly, nodes, edges, flow, editor]);

  const undo = useCallback(() => {
    if (!readOnly) editor.undo();
  }, [editor, readOnly]);
  const redo = useCallback(() => {
    if (!readOnly) editor.redo();
  }, [editor, readOnly]);

  // Expose to the palette, the config panel and the top bar (they live in other panes).
  const register = useCanvasApi((s) => s.register);
  useEffect(
    () =>
      register({
        addNode: addNodeAtCenter,
        deleteNodes: (ids) => deleteElements(ids, []),
        fitView,
        duplicateSelection,
        autoArrange,
        undo,
        redo,
        readOnly,
      }),
    [
      register,
      addNodeAtCenter,
      deleteElements,
      fitView,
      duplicateSelection,
      autoArrange,
      undo,
      redo,
      readOnly,
    ],
  );

  /* ---------------------------------------------------------------- drop from palette */

  const onNodeDoubleClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      if (readOnly) return;
      setSelection([node.id], []);
      usePanelsStore.getState().openSheet('configure');
    },
    [readOnly, setSelection],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (readOnly) return;
      if (event.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    },
    [readOnly],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (readOnly) return;
      const kind = event.dataTransfer.getData(PALETTE_DRAG_TYPE) as CanvasNodeKind | '';
      if (!kind) return;
      event.preventDefault();
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNodeAt(kind, position, readDropInit(event));
    },
    [flow, addNodeAt, readOnly],
  );

  /* ------------------------------------------------- keyboard (FR-CAN-007, FR-CAN-012, FR-CAN-013) */

  useEffect(() => {
    /** Copy, paste and select-all keep their browser meaning outside the Canvas (e.g. a log line). */
    const onCanvas = (target: EventTarget | null) =>
      target === null ||
      target === document.body ||
      target === document.documentElement ||
      (target instanceof globalThis.Node && wrapper.current?.contains(target) === true);

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;

      if (key === 'f' && !mod && !event.altKey) {
        event.preventDefault();
        fitView();
        return;
      }
      if (event.key === 'Escape') {
        setArmedPortId(undefined);
        setEdgeMenu(undefined);
        return;
      }
      if (!mod || event.altKey) return;

      if (key === 'a' && onCanvas(event.target)) {
        event.preventDefault();
        selectAll();
        return;
      }
      if (key === 'c' && onCanvas(event.target)) {
        // text the user highlighted on purpose copies as text
        if ((window.getSelection()?.toString() ?? '') !== '') return;
        if (copySelection()) event.preventDefault();
        return;
      }
      if (readOnly) return;
      if (key === 'v' && onCanvas(event.target)) {
        event.preventDefault();
        paste();
        return;
      }
      if (key === 'd') {
        event.preventDefault(); // never the browser's bookmark dialog
        duplicateSelection();
        return;
      }
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        editor.undo();
        return;
      }
      if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        editor.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView, selectAll, copySelection, paste, duplicateSelection, editor, readOnly]);

  /* ---------------------------------------------------------------- edge context menu (FR-CON-004) */

  const onEdgeContextMenu: EdgeMouseHandler = useCallback(
    (event, edge) => {
      event.preventDefault();
      setMenuTarget(undefined);
      // read-only: a data edge has nothing to offer but editing, so no menu at all
      if (readOnly && edges.find((e) => e.id === edge.id)?.kind !== 'loop') return;
      const bounds = wrapper.current?.getBoundingClientRect();
      setEdgeMenu({
        edgeId: edge.id,
        x: event.clientX - (bounds?.left ?? 0),
        y: event.clientY - (bounds?.top ?? 0),
      });
    },
    [readOnly, edges],
  );

  /* ------------------------------------------------- node and empty-Canvas menus (FR-CAN-011) */

  /**
   * Decide what was right-clicked before the menu opens. An edge already called `preventDefault`
   * (its own inline menu), and the toolbar, minimap and zoom controls get no menu at all.
   */
  const onCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const nodeEl = target?.closest('.react-flow__node');
      const nodeId = nodeEl?.getAttribute('data-id') ?? undefined;
      if (nodeId !== undefined) {
        setEdgeMenu(undefined);
        setMenuTarget({ kind: 'node', nodeId });
        if (!selectedNodeIds.includes(nodeId)) setSelection([nodeId], []);
        return;
      }
      if (target?.closest('.react-flow__nodesselection') && selectedNodeIds[0] !== undefined) {
        setEdgeMenu(undefined);
        setMenuTarget({ kind: 'node', nodeId: selectedNodeIds[0] });
        return;
      }
      if (target?.closest('.react-flow__pane')) {
        setEdgeMenu(undefined);
        setMenuTarget({
          kind: 'pane',
          position: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        });
        return;
      }
      event.preventDefault();
    },
    [flow, selectedNodeIds, setSelection],
  );

  /** The one graph-op a confirmed loop edge needs: `add_edge` with `kind: 'loop'` (§2.6). */
  const createLoopEdge = useCallback(
    (candidate: LoopEdgeCandidate, loop: LoopConfig) => {
      editor.edit(
        [
          // One batch is one transaction (§2.6): a conversion never leaves both edges on the graph.
          ...(candidate.replacesEdgeId === undefined
            ? []
            : [{ op: 'delete_edge' as const, edgeId: candidate.replacesEdgeId }]),
          {
            op: 'add_edge',
            edge: {
              id: newId(),
              workflowId,
              kind: 'loop',
              from: candidate.from,
              to: candidate.to,
              loop,
            },
          },
        ],
        'Make loop edge',
      );
      setLoopCandidate(undefined);
    },
    [editor, workflowId],
  );

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => setViewport(workflowId, viewport),
    [setViewport, workflowId],
  );

  const menuNodeIds = menuTarget?.kind === 'node' ? targetIds(menuTarget.nodeId) : [];

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setMenuTarget(undefined);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          ref={wrapper}
          className="absolute inset-0"
          data-testid="canvas"
          data-readonly={readOnly ? 'true' : undefined}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onContextMenu={onCanvasContextMenu}
        >
          <ReactFlow<AceFlowNode>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={aceEdgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={onSelectionChange}
            onDelete={onDelete}
            onConnect={tryConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={() => setEdgeMenu(undefined)}
            onNodeDoubleClick={onNodeDoubleClick}
            onMoveEnd={onMoveEnd}
            defaultViewport={savedViewport ?? { x: 0, y: 0, zoom: 1 }}
            fitView={!savedViewport && nodes.length > 0}
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
            selectionKeyCode="Shift"
            panOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            // Culling leaves off-screen nodes unmeasured, so `fitView` cannot bring them back and a
            // node added outside the view becomes unreachable. Rendering all 200 fixture nodes costs
            // less than the noise in TC-NFR-001, so the trade is not worth it.
            onlyRenderVisibleElements={false}
            minZoom={0.1}
            maxZoom={2.5}
            className="ace-dotted-canvas"
            style={{ background: tokens.color.canvas }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={tokens.canvas.dotGap}
              size={tokens.canvas.dotSize}
              color={tokens.color.canvasDot}
            />
            <MiniMap
              pannable
              zoomable
              nodeColor={tokens.color.card}
              nodeStrokeColor={tokens.color.border}
              maskColor="rgba(13, 17, 23, 0.7)"
              style={{ background: tokens.color.panel }}
            />
            <Controls showInteractive={false} />
            <Panel position="top-right" className="flex gap-1">
              {!readOnly && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={undo}
                    disabled={!canUndo}
                    title={`Undo (${MOD}Z)`}
                    aria-label="Undo"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={redo}
                    disabled={!canRedo}
                    title={`Redo (${MOD}Y)`}
                    aria-label="Redo"
                  >
                    <Redo2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={autoArrange}
                    disabled={nodes.length === 0}
                    title="Auto-arrange left to right"
                    aria-label="Auto-arrange"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" /> Auto-arrange
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={fitView}
                title="Fit to view (F)"
                aria-label="Fit to view"
              >
                <Maximize2 className="h-3.5 w-3.5" /> Fit
              </Button>
              {!readOnly && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={duplicateSelection}
                  disabled={selectedNodeIds.length === 0}
                  title={`Duplicate selected nodes (${MOD}D)`}
                  aria-label="Duplicate selected nodes"
                >
                  <Copy className="h-3.5 w-3.5" /> Duplicate
                </Button>
              )}
            </Panel>
          </ReactFlow>
          {loopCandidate && (
            <MakeLoopEdgeDialog
              candidate={loopCandidate}
              onCancel={() => setLoopCandidate(undefined)}
              onCreate={(loop) => createLoopEdge(loopCandidate, loop)}
            />
          )}

          {edgeMenu && (
            <div
              role="menu"
              aria-label="Connection actions"
              className="absolute z-20 rounded-md border border-border bg-panel p-1 shadow-md"
              style={{ left: edgeMenu.x, top: edgeMenu.y }}
            >
              <EdgeMenuItems
                edge={edges.find((edge) => edge.id === edgeMenu.edgeId)}
                nodes={nodes}
                edges={edges}
                readOnly={readOnly}
                onMakeLoop={(candidate) => {
                  setEdgeMenu(undefined);
                  setLoopCandidate(candidate);
                }}
                onEditLoop={(edgeId) => {
                  setEdgeMenu(undefined);
                  setSelection([], [edgeId]);
                }}
                onDelete={() => {
                  deleteElements([], [edgeMenu.edgeId]);
                  setEdgeMenu(undefined);
                }}
              />
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      {menuTarget?.kind === 'node' && (
        <ContextMenuContent aria-label="Node actions" data-testid="node-context-menu">
          {!readOnly && (
            <ContextMenuItem onSelect={() => duplicateNodesById(menuNodeIds)}>
              Duplicate <ContextMenuShortcut>{MOD}D</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => copySelection(menuNodeIds)}>
            Copy <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setSelection([menuTarget.nodeId], [])}>
            {readOnly ? 'Inspect' : 'Configure'}
          </ContextMenuItem>
          {!readOnly && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem destructive onSelect={() => deleteElements(menuNodeIds, [])}>
                Delete <ContextMenuShortcut>Del</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      )}

      {menuTarget?.kind === 'pane' && (
        <ContextMenuContent aria-label="Canvas actions" data-testid="pane-context-menu">
          {!readOnly && (
            <>
              <ContextMenuItem
                disabled={readClipboard() === undefined}
                onSelect={() => paste(menuTarget.position)}
              >
                Paste <ContextMenuShortcut>{MOD}V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-fg-muted">
                Add node ▸
              </div>
              {CANVAS_NODE_KINDS.map((kind) => (
                <ContextMenuItem
                  key={kind}
                  className="pl-4"
                  onSelect={() => addNodeAt(kind, freeSlotNear(nodes, menuTarget.position))}
                >
                  Add {NODE_KIND_LABEL[kind]}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem disabled={nodes.length === 0} onSelect={selectAll}>
            Select all <ContextMenuShortcut>{MOD}A</ContextMenuShortcut>
          </ContextMenuItem>
          {!readOnly && (
            <ContextMenuItem disabled={nodes.length === 0} onSelect={autoArrange}>
              Auto-arrange
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={fitView}>
            Fit view <ContextMenuShortcut>F</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

/**
 * What the edge context menu offers (round 3 §5 item 8).
 *
 * "Make loop edge" asks the contract, never a rule of its own, and when the contract refuses it says
 * why rather than hiding: the usual answer for an existing data edge is that its target is not
 * upstream of its source, which is exactly what the operator needs to hear. A loop edge already on
 * the graph offers its settings instead — they live in the config panel, on the edge's selection.
 */
function EdgeMenuItems({
  edge,
  nodes,
  edges,
  readOnly = false,
  onMakeLoop,
  onEditLoop,
  onDelete,
}: {
  edge: Edge | undefined;
  nodes: Node[];
  edges: Edge[];
  /** FR-MOB-003: only the loop settings (a look, not an edit) are offered. */
  readOnly?: boolean;
  onMakeLoop: (candidate: LoopEdgeCandidate) => void;
  onEditLoop: (edgeId: string) => void;
  onDelete: () => void;
}) {
  const itemClass =
    'block w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-border/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

  // A loop edge's target being upstream of its source is judged on the graph *without* this edge:
  // converting it removes it, so it must not count as part of the path it is being checked against.
  const check =
    edge === undefined || edge.kind === 'loop'
      ? undefined
      : canBeLoopEdge(
          edge,
          nodes,
          edges.filter((other) => other.id !== edge.id),
        );

  return (
    <>
      {edge?.kind === 'loop' ? (
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => onEditLoop(edge.id)}
        >
          Loop settings
        </button>
      ) : readOnly ? null : (
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          disabled={check === undefined || !check.ok}
          title={check === undefined || check.ok ? undefined : check.reason}
          onClick={() => {
            if (edge === undefined) return;
            onMakeLoop({
              from: edge.from,
              to: edge.to,
              fromNodeName: nodes.find((node) => node.id === edge.from.nodeId)?.name ?? 'this node',
              toNodeName: nodes.find((node) => node.id === edge.to.nodeId)?.name ?? 'that node',
              replacesEdgeId: edge.id,
            });
          }}
        >
          Make loop edge
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          role="menuitem"
          className={`${itemClass} text-danger`}
          onClick={onDelete}
        >
          Delete connection
        </button>
      )}
    </>
  );
}
