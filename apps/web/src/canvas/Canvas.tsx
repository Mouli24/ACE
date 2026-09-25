import type { Edge, LoopConfig, Node, Port } from '@ace/contracts';
import { Button, toast, tokens } from '@ace/ui';
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
import { Copy, Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore } from '../app/stores/viewport';
import { loopEdgeType } from '../edges/loop/LoopEdge';
import { MakeLoopEdgeDialog, type LoopEdgeCandidate } from '../edges/loop/MakeLoopEdgeDialog';
import { canBeLoopEdge } from '../edges/loop/can-be-loop-edge';
import { newId } from '../lib/ulid';
import { useProviders } from '../providers/hooks';
import { nodeTypes, type AceFlowNode } from '../nodes/NodeCard';
import { edgeTypes } from '../nodes/TypedEdge';
import { createNode, type Round1NodeKind } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { PALETTE_DRAG_TYPE } from './Palette';
import { useCanvasApi } from './canvas-api';
import { checkConnection, type ConnectionAttempt } from './connect';
import { duplicateNodes } from './duplicate';
import { freeSlotNear } from './placement';
import { toFlowEdges, toFlowNodes } from './to-flow';

/** Both edge renderers: the typed data edge, and round 3's loop edge (FR-CON-007). */
const aceEdgeTypes = { ...edgeTypes, ...loopEdgeType };

export interface CanvasProps {
  workflowId: string;
}

/** The Canvas (FR-CAN-001..007, 010): loading gate outside, React Flow inside. */
export function Canvas({ workflowId }: CanvasProps) {
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
      <CanvasInner workflowId={workflowId} nodes={graph.data.nodes} edges={graph.data.edges} />
    </ReactFlowProvider>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function CanvasInner({
  workflowId,
  nodes,
  edges,
}: {
  workflowId: string;
  nodes: Node[];
  edges: Edge[];
}) {
  const sync = useGraphSync(workflowId);
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
      sync.enqueue([
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
      ]);
      return true;
    },
    [nodes, edges, sync, workflowId, loopOffer],
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
    [armedPortId, nodes, tryConnect],
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
        sync.enqueue(
          moves.map((m) => ({
            op: 'move_node' as const,
            nodeId: m.id,
            position: { x: Math.round(m.position.x), y: Math.round(m.position.y) },
          })),
        );
      }
    },
    [sync],
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

  const onNodesDelete = useCallback(
    (deleted: AceFlowNode[]) => {
      sync.enqueue(deleted.map((n) => ({ op: 'delete_node' as const, nodeId: n.id })));
    },
    [sync],
  );

  const onEdgesDelete = useCallback(
    (deleted: Array<{ id: string }>) => {
      sync.enqueue(deleted.map((e) => ({ op: 'delete_edge' as const, edgeId: e.id })));
    },
    [sync],
  );

  const addNodeAt = useCallback(
    (kind: Round1NodeKind, position: { x: number; y: number }) => {
      const node = createNode(kind, workflowId, {
        x: Math.round(position.x),
        y: Math.round(position.y),
      });
      sync.enqueue([{ op: 'add_node', node }]);
      setSelection([node.id], []);
      return node;
    },
    [sync, workflowId, setSelection],
  );

  const addNodeAtCenter = useCallback(
    (kind: Round1NodeKind) => {
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
      const node = addNodeAt(kind, slot);

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
    [addNodeAt, flow, nodes],
  );

  const duplicateSelection = useCallback(() => {
    const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (selected.length === 0) return;
    const copies = duplicateNodes(selected, nodes);
    sync.enqueue(copies.map((node) => ({ op: 'add_node' as const, node })));
    setSelection(
      copies.map((n) => n.id),
      [],
    );
  }, [nodes, selectedNodeIds, sync, setSelection]);

  const fitView = useCallback(() => void flow.fitView({ padding: 0.2, duration: 200 }), [flow]);

  // Expose to the palette and the config panel (they live in other panes).
  const register = useCanvasApi((s) => s.register);
  useEffect(
    () => register({ addNode: addNodeAtCenter, fitView, duplicateSelection }),
    [register, addNodeAtCenter, fitView, duplicateSelection],
  );

  /* ---------------------------------------------------------------- drop from palette */

  const onDragOver = useCallback((event: DragEvent) => {
    if (event.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      const kind = event.dataTransfer.getData(PALETTE_DRAG_TYPE) as Round1NodeKind | '';
      if (!kind) return;
      event.preventDefault();
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNodeAt(kind, position);
    },
    [flow, addNodeAt],
  );

  /* ---------------------------------------------------------------- keyboard: F fits (FR-CAN-007) */

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (event.key === 'f' || event.key === 'F') {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        fitView();
      }
      if (event.key === 'Escape') {
        setArmedPortId(undefined);
        setEdgeMenu(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView]);

  /* ---------------------------------------------------------------- edge context menu (FR-CON-004) */

  const onEdgeContextMenu: EdgeMouseHandler = useCallback((event, edge) => {
    event.preventDefault();
    const bounds = wrapper.current?.getBoundingClientRect();
    setEdgeMenu({
      edgeId: edge.id,
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
    });
  }, []);

  /** The one graph-op a confirmed loop edge needs: `add_edge` with `kind: 'loop'` (§2.6). */
  const createLoopEdge = useCallback(
    (candidate: LoopEdgeCandidate, loop: LoopConfig) => {
      sync.enqueue([
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
      ]);
      setLoopCandidate(undefined);
    },
    [sync, workflowId],
  );

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => setViewport(workflowId, viewport),
    [setViewport, workflowId],
  );

  return (
    <div
      ref={wrapper}
      className="absolute inset-0"
      data-testid="canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow<AceFlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={aceEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onConnect={tryConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneClick={() => setEdgeMenu(undefined)}
        onMoveEnd={onMoveEnd}
        defaultViewport={savedViewport ?? { x: 0, y: 0, zoom: 1 }}
        fitView={!savedViewport && nodes.length > 0}
        fitViewOptions={{ padding: 0.2 }}
        deleteKeyCode={['Delete', 'Backspace']}
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
          <Button
            variant="secondary"
            size="sm"
            onClick={fitView}
            title="Fit to view (F)"
            aria-label="Fit to view"
          >
            <Maximize2 className="h-3.5 w-3.5" /> Fit
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={duplicateSelection}
            disabled={selectedNodeIds.length === 0}
            title="Duplicate selected nodes"
            aria-label="Duplicate selected nodes"
          >
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </Button>
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
          className="absolute z-20 rounded-md border border-border bg-panel p-1 shadow-md"
          style={{ left: edgeMenu.x, top: edgeMenu.y }}
        >
          <EdgeMenuItems
            edge={edges.find((edge) => edge.id === edgeMenu.edgeId)}
            nodes={nodes}
            edges={edges}
            onMakeLoop={(candidate) => {
              setEdgeMenu(undefined);
              setLoopCandidate(candidate);
            }}
            onEditLoop={(edgeId) => {
              setEdgeMenu(undefined);
              setSelection([], [edgeId]);
            }}
            onDelete={() => {
              sync.enqueue([{ op: 'delete_edge', edgeId: edgeMenu.edgeId }]);
              setEdgeMenu(undefined);
            }}
          />
        </div>
      )}
    </div>
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
  onMakeLoop,
  onEditLoop,
  onDelete,
}: {
  edge: Edge | undefined;
  nodes: Node[];
  edges: Edge[];
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
      ) : (
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
      <button
        type="button"
        role="menuitem"
        className={`${itemClass} text-danger`}
        onClick={onDelete}
      >
        Delete connection
      </button>
    </>
  );
}
