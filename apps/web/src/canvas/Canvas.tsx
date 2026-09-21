import type { Edge, Node, Port } from '@ace/contracts';
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
  type EdgeMouseHandler,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport,
} from '@xyflow/react';
import { Copy, Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore } from '../app/stores/viewport';
import { newId } from '../lib/ulid';
import { nodeTypes, type AceFlowNode } from '../nodes/NodeCard';
import { edgeTypes } from '../nodes/TypedEdge';
import { createNode, type Round1NodeKind } from '../nodes/factory';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { PALETTE_DRAG_TYPE } from './Palette';
import { useCanvasApi } from './canvas-api';
import { checkConnection } from './connect';
import { duplicateNodes } from './duplicate';
import { toFlowEdges, toFlowNodes } from './to-flow';

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
        className="ace-dotted-canvas flex h-full items-center justify-center"
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
  const wrapper = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- connections */

  const tryConnect = useCallback(
    (attempt: Connection) => {
      const verdict = checkConnection(nodes, edges, attempt);
      if (!verdict.ok) {
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
    [nodes, edges, sync, workflowId],
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
    ) =>
      checkConnection(nodes, edges, {
        source: attempt.source,
        target: attempt.target,
        sourceHandle: attempt.sourceHandle ?? null,
        targetHandle: attempt.targetHandle ?? null,
      }).ok,
    [nodes, edges],
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

  const serverNodes = useMemo(
    () => toFlowNodes(nodes, edges, armedPortId, onPortKey),
    [nodes, edges, armedPortId, onPortKey],
  );
  const [flowNodes, setFlowNodes] = useState<AceFlowNode[]>(serverNodes);

  // Server truth wins, but a node mid-drag keeps its live position until the drop is saved.
  useEffect(() => {
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return serverNodes.map((node) => {
        const prev = byId.get(node.id);
        if (!prev) return { ...node, selected: selectedNodeIds.includes(node.id) };
        return {
          ...node,
          selected: prev.selected,
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

  const flowEdges = useMemo(
    () =>
      toFlowEdges(edges, nodes).map((e) => ({ ...e, selected: selectedEdgeIds.includes(e.id) })),
    [edges, nodes, selectedEdgeIds],
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
      const center = flow.screenToFlowPosition({
        x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
        y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
      });
      const jitter = nodes.length * 12;
      return addNodeAt(kind, { x: center.x - 90 + jitter, y: center.y - 40 + jitter });
    },
    [addNodeAt, flow, nodes.length],
  );

  const duplicateSelection = useCallback(() => {
    const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (selected.length === 0) return;
    const copies = duplicateNodes(selected);
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

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => setViewport(workflowId, viewport),
    [setViewport, workflowId],
  );

  return (
    <div
      ref={wrapper}
      className="relative h-full w-full"
      data-testid="canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow<AceFlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onConnect={tryConnect}
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
        onlyRenderVisibleElements
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
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
      {edgeMenu && (
        <div
          role="menu"
          className="absolute z-20 rounded-md border border-border bg-panel p-1 shadow-md"
          style={{ left: edgeMenu.x, top: edgeMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-sm px-3 py-1.5 text-left text-sm text-danger hover:bg-border/60"
            onClick={() => {
              sync.enqueue([{ op: 'delete_edge', edgeId: edgeMenu.edgeId }]);
              setEdgeMenu(undefined);
            }}
          >
            Delete connection
          </button>
        </div>
      )}
    </div>
  );
}
