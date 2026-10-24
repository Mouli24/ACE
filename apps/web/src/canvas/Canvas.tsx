import type {
  DebateConfig,
  DebateRole,
  Edge,
  GraphOp,
  LoopConfig,
  Node,
  Port,
} from '@ace/contracts';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  MENU_CONTENT_CLASS,
  cn,
  toast,
} from '@ace/ui';
import {
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useConnection,
  useReactFlow,
  useStore,
  useStoreApi,
  useViewport,
  type Connection,
  type EdgeChange,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type NodeChange,
  type OnSelectionChangeParams,
  type ReactFlowState,
  type Viewport,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Link, useInRouterContext, useParams, useSearchParams } from 'react-router-dom';

import { WorkspaceMenu } from '../app/layout/WorkspaceMenu';
import { usePanelsStore } from '../app/stores/panels';
import { useFollowNode } from '../app/follow-node';
import { useSelectionStore } from '../app/stores/selection';
import { useViewportStore } from '../app/stores/viewport';
import { useResolvedTheme } from '../app/theme';
import { debateMenuFor, type DebateMenu } from '../edges/debate';
import { loopEdgeType } from '../edges/loop/LoopEdge';
import { MakeLoopEdgeDialog, type LoopEdgeCandidate } from '../edges/loop/MakeLoopEdgeDialog';
import { canBeLoopEdge } from '../edges/loop/can-be-loop-edge';
import { newId } from '../lib/ulid';
import { cardSize } from '../nodes/anchors';
import {
  NodeActionsContext,
  NodeEstimateContext,
  PortConnectContext,
  type NodeCardActions,
} from '../nodes/card-context';
import { CanvasDarkContext, nodeTypes, type AceFlowNode } from '../nodes/NodeCard';
import { edgeTypes } from '../nodes/TypedEdge';
import {
  NODE_KIND_LABEL,
  PALETTE_NODE_KINDS,
  applyNewNodeInit,
  createNode,
  NEW_NODE_NAME,
  uniqueNodeName,
  type CanvasNodeKind,
  type NewNodeInit,
} from '../nodes/factory';
import { useProject } from '../projects/hooks';
import { ProviderPickerHost } from '../providers/ProviderModelPicker';
import { useModels, useProviders } from '../providers/hooks';
import { requestProviderChoice } from '../providers/provider-picker-store';
import { useNodeEstimates } from '../runs/estimate';
import { useRun, useStartRun } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { useGraphSync, useWorkflowGraph } from '../workflows/hooks';
import { useCanvasApi } from './canvas-api';
import { CanvasMinimap, rectOf } from './CanvasMinimap';
import { CanvasToolbar } from './CanvasToolbar';
import { checkConnection, type ConnectionAttempt } from './connect';
import { ConnectToDialog } from './ConnectToDialog';
import { PALETTE_DRAG_TYPE, PALETTE_INIT_TYPE } from './drag';
import { DUPLICATE_OFFSET, duplicateNodes } from './duplicate';
import { lacksUsableProvider, needsProviderChoice, withProviderChoice } from './provider-first';
import {
  edgeTypeOptions,
  reconnectPlan,
  withoutEdge,
  type EdgeEnd,
  type EdgeTypeOption,
} from './edge-edit';
import {
  EdgeLayer,
  OrderEdgeLayer,
  PortDotLayer,
  type EdgeEditApi,
  type EdgeReconnectDrag,
  type OrderEditApi,
  type OrderLink,
} from './EdgeLayer';
import { RunAfterDialog } from './RunAfterDialog';
import { RunOrderPanel } from './RunOrderPanel';
import { addRunAfter, type RunOrderEdit } from './run-order';
import {
  MOVE_HISTORY_LIMIT,
  movesBack,
  planNewStage,
  removeReconnectingOps,
  snapshotPositions,
  takeMoveBack,
  type PositionSnapshot,
} from './graph-plans';
import {
  copyNodes,
  parseClipboard,
  pasteNodes,
  readClipboard,
  writeClipboard,
  type ClipboardPayload,
} from './interactions/clipboard';
import {
  dropOnCard,
  isCardBody,
  isClick,
  portConnectStates,
  portLabel,
  type CheckConnection,
  type ConnectChoice,
  type ConnectFrom,
  type PortConnectState,
} from './interactions/ports';
import { useHistoryStore } from './interactions/history';
import { useGraphEditor, useHistoryDepth } from './interactions/use-graph-editor';
import { autoLayout } from './layout/auto-layout';
import { freeSlotNear } from './placement';
import { GHOST_EDGE_CLASS, runSnapshotOverlay } from './run-snapshot';
import { toFlowEdges, toFlowNodes } from './to-flow';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  bounds,
  centreOn,
  fitView,
  wheelView,
  zoomAt,
} from './viewport';

/** Both edge renderers: the typed data edge, and round 3's loop edge (FR-CON-007). */
const aceEdgeTypes = { ...edgeTypes, ...loopEdgeType };

/** D406: what Add node offers — an Agent, or one of the preset debaters. */
const ADD_NODE_CHOICES: ReadonlyArray<{ label: string; hint: string; preset?: DebateRole }> = [
  { label: 'Agent', hint: 'A node you give a goal and a model.' },
  {
    label: 'Defender',
    hint: 'Writes the answer in a debate, and keeps it right.',
    preset: 'defender',
  },
  { label: 'Attacker', hint: 'Finds what is wrong with the answer.', preset: 'attacker' },
  { label: 'Judge', hint: 'Decides the debate and writes the final answer.', preset: 'judge' },
];

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
  // PG-4.3: one estimate per graph version, handed to every card.
  const estimates = useNodeEstimates(workflowId);

  // FR-CAN-010: nodes and edges arrive in one response; nothing is drawn before both are here.
  if (!graph.data) {
    return (
      <div
        className="ace-dotted-canvas absolute inset-0 flex items-center justify-center"
        data-testid="canvas-loading"
        role="status"
        aria-live="polite"
      >
        <span className="text-[13px] text-[var(--muted)]">Loading workflow…</span>
      </div>
    );
  }

  return (
    // [audit W-17] one React Flow store per workflow: the viewport, measured nodes and selection of
    // the workflow just left never carry into the next one opened in the same Canvas
    <ReactFlowProvider key={workflowId}>
      <NodeEstimateContext.Provider value={estimates}>
        <CanvasInner
          workflowId={workflowId}
          nodes={graph.data.nodes}
          edges={graph.data.edges}
          readOnly={readOnly}
        />
      </NodeEstimateContext.Provider>
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

/**
 * A press or click on the card itself — not on a port, not on the card's own buttons and menus
 * (D360), not on what hangs under the card (D350).
 */
const onCard = isCardBody;

/**
 * D303: a node's lens in Domain, opened from the board — on the selected run, which goes along as
 * `?run=` (PG-3.4).
 */
function useOpenInDomain(workflowId: string): (nodeId: string) => void {
  const projectId = useWorkflowGraph(workflowId).data?.workflow.projectId;
  const follow = useFollowNode({ projectId, workflowId });
  return useCallback((nodeId: string) => follow(nodeId, 'domain'), [follow]);
}

function OpenInDomainItem({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const open = useOpenInDomain(workflowId);
  return <ContextMenuItem onSelect={() => open(nodeId)}>Open in Domain</ContextMenuItem>;
}

/**
 * PG-1.2 (D360): what the cards' Settings and More buttons do. In a routed workspace More also
 * opens the node in Domain (D303); a bare Canvas (its tests) has no router, so it offers that
 * nowhere — as the right-click menu does.
 */
function CardActionsProvider({
  value,
  routed,
  workflowId,
  children,
}: {
  value: NodeCardActions;
  routed: boolean;
  workflowId: string;
  children: ReactNode;
}) {
  if (!routed)
    return <NodeActionsContext.Provider value={value}>{children}</NodeActionsContext.Provider>;
  return (
    <RoutedCardActions value={value} workflowId={workflowId}>
      {children}
    </RoutedCardActions>
  );
}

function RoutedCardActions({
  value,
  workflowId,
  children,
}: {
  value: NodeCardActions;
  workflowId: string;
  children: ReactNode;
}) {
  const openInDomain = useOpenInDomain(workflowId);
  const routedValue = useMemo<NodeCardActions>(
    () => ({ ...value, openInDomain }),
    [value, openInDomain],
  );
  return <NodeActionsContext.Provider value={routedValue}>{children}</NodeActionsContext.Provider>;
}

/**
 * PG-3.4: the node `?node=` names, selected and centred — on arriving in Ideate, and when the URL
 * names a node that is not the one selected (a link, Back). A node the person just clicked is
 * already selected when its id reaches the URL, so the view does not jump under them. Waits on
 * React Flow's store until the node and the canvas are measured.
 */
function FollowNodeFromUrl({
  focus,
  subscribe,
}: {
  focus(nodeId: string): boolean;
  subscribe(listener: () => void): () => void;
}) {
  const [search] = useSearchParams();
  const wanted = search.get('node');
  /** The node last centred; the one still to centre; whether the first URL has been read. */
  const done = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const arrived = useRef(false);
  useEffect(() => {
    const arriving = !arrived.current;
    arrived.current = true;
    if (wanted === null) {
      done.current = null;
      pending.current = null;
      return;
    }
    if (done.current === wanted) return;
    if (pending.current !== wanted) {
      if (!arriving && useSelectionStore.getState().focusedNodeId === wanted) {
        done.current = wanted;
        return;
      }
      pending.current = wanted;
    }
    const attempt = (): void => {
      if (done.current === wanted || !focus(wanted)) return;
      done.current = wanted;
      pending.current = null;
    };
    attempt();
    if (done.current === wanted) return;
    const unsubscribe = subscribe(() => {
      attempt();
      if (done.current === wanted) unsubscribe();
    });
    return unsubscribe;
  }, [wanted, focus, subscribe]);
  return null;
}

/**
 * PG-1.1 (D350): while a line is drawn and it is over a port it may not end on, that port's reason,
 * as a tooltip beside the pointer. Its own component: it follows every pointer move, and nothing
 * else on the Canvas should.
 */
function ConnectRefusalTooltip({
  states,
}: {
  states: ReadonlyMap<string, PortConnectState> | undefined;
}) {
  const connection = useConnection();
  const flow = useReactFlow();
  if (!connection.inProgress || connection.toHandle === null || states === undefined) return null;
  const state = connection.toHandle.id ? states.get(connection.toHandle.id) : undefined;
  if (state?.look !== 'incompatible') return null;
  const at = flow.flowToScreenPosition(connection.to);
  return (
    <div
      role="tooltip"
      data-testid="connect-refusal"
      className="pointer-events-none fixed z-[60] max-w-[260px] rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[6px] text-[12px] leading-[1.4] text-[var(--ink)] shadow-[0_10px_26px_-14px_rgba(40,25,15,0.45)]"
      style={{ left: at.x + 14, top: at.y + 14 }}
    >
      {state.reason}
    </div>
  );
}

/** A line dropped on a card that more than one input fits: where to offer the choice. */
interface DropChooser {
  x: number;
  y: number;
  choices: ConnectChoice[];
}

/**
 * The theme's two background layers (D332): the radial glows, and the dot grid that scales with
 * the zoom (`max(6, 16·z)` px) and moves with the pan. Its own component so a pan re-renders the
 * grid and nothing else.
 */
function CanvasBackdrop() {
  const { x, y, zoom } = useViewport();
  const grid = Math.max(6, 16 * zoom);
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 520px at 12% 0%,var(--glow),transparent 70%),radial-gradient(700px 500px at 100% 100%,var(--glow),transparent 70%)',
        }}
      />
      <div
        aria-hidden
        data-testid="canvas-grid"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(var(--dot) 1px,transparent 1.3px)',
          backgroundSize: `${grid}px ${grid}px`,
          backgroundPosition: `${x}px ${y}px`,
        }}
      />
    </>
  );
}

/**
 * The theme's breadcrumb (D331): HOME → Home, the project's name, and the workspace menu "…".
 * Only in a routed workspace; a bare Canvas (its tests) has no project around it.
 */
function CanvasBreadcrumb({ workflowId }: { workflowId: string }) {
  const params = useParams();
  const graphProjectId = useWorkflowGraph(workflowId).data?.workflow.projectId;
  const projectId = params['projectId'] ?? graphProjectId ?? '';
  const project = useProject(projectId === '' ? undefined : projectId);
  return (
    <nav
      aria-label="Breadcrumb"
      className="absolute left-[18px] top-[14px] z-[5] flex items-center gap-[8px] font-machine text-[10px] tracking-[0.08em]"
    >
      <Link
        to="/projects"
        className="flex h-[24px] items-center rounded-full px-[10px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
      >
        HOME
      </Link>
      <span className="text-[var(--muted)]">/</span>
      <span
        data-testid="project-name"
        className="flex h-[24px] items-center whitespace-nowrap rounded-full border border-[var(--ink)] px-[10px] font-medium uppercase"
      >
        {project.data?.name ?? '—'}
      </span>
      <WorkspaceMenu projectId={projectId} workflowId={workflowId} />
    </nav>
  );
}

const selectPaneDragging = (state: ReactFlowState) => state.paneDragging;
/** Below this zoom a card's 22px buttons draw under 10px: hidden (and not painted, TC-NFR-001). */
export const CARD_BUTTONS_MIN_ZOOM = 0.45;
const selectFar = (state: ReactFlowState) => state.transform[2] < CARD_BUTTONS_MIN_ZOOM;
const selectConnectFrom = (state: ReactFlowState): string =>
  state.connection.inProgress
    ? [
        state.connection.fromNode.id,
        state.connection.fromHandle.id ?? '',
        state.connection.fromHandle.type,
      ].join('\u0000')
    : '';

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
  const [menuTarget, setMenuTarget] = useState<MenuTarget>();
  /** A bare Canvas (its tests) has no router; Domain's entry and the breadcrumb need one. */
  const inRouter = useInRouterContext();
  const flow = useReactFlow<AceFlowNode>();
  const rf = useStoreApi<AceFlowNode>();
  const setSelection = useSelectionStore((s) => s.setSelection);
  const selectedNodeIds = useSelectionStore((s) => s.nodeIds);
  const selectedEdgeIds = useSelectionStore((s) => s.edgeIds);
  const savedViewport = useViewportStore((s) => s.viewports[workflowId]);
  const setViewport = useViewportStore((s) => s.setViewport);
  const [armedPortId, setArmedPortId] = useState<string>();
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number }>();
  /** A drawn arrow that closes a cycle and could legally be the loop edge (FR-CON-007). */
  const [loopCandidate, setLoopCandidate] = useState<LoopEdgeCandidate>();
  /** The theme's toolbar tools (D332): lock stops dragging, the hand pans from anywhere. */
  const [locked, setLocked] = useState(false);
  const [hand, setHand] = useState(false);
  /** The theme's position history, for the toolbar's undo-move. */
  const [moveHistory, setMoveHistory] = useState<PositionSnapshot[]>([]);
  const dark = useResolvedTheme() === 'dark';
  const paneDragging = useStore(selectPaneDragging);
  /** D360: zoomed far out, the cards' buttons would be specks; they hide until the view comes closer. */
  const far = useStore(selectFar);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => setMoveHistory([]), [workflowId]);

  /* ---------------------------------------------------------------- the viewport (D332) */

  /** The canvas's size, as React Flow measured its container (the theme's `cw`, `ch`). */
  const canvasSize = useCallback(() => {
    const { width, height } = rf.getState();
    return { cw: width, ch: height };
  }, [rf]);

  /** The theme's `fit()`: every node's rect, padded 80, zoom 0.25–1.4. */
  const fitAll = useCallback(() => {
    const box = bounds(flow.getNodes().map(rectOf));
    const { cw, ch } = canvasSize();
    if (box === undefined || cw <= 0 || ch <= 0) return;
    void flow.setViewport(fitView(box, cw, ch));
  }, [flow, canvasSize]);

  /** The toolbar's + / − / %: the theme's `zoomAt` about the canvas centre. */
  const zoomBy = useCallback(
    (factor: (zoom: number) => number) => {
      const view = flow.getViewport();
      const { cw, ch } = canvasSize();
      void flow.setViewport(zoomAt(view, factor(view.zoom), cw / 2, ch / 2));
    },
    [flow, canvasSize],
  );

  /**
   * Fit on first load, when this workflow has no saved view and has nodes (D332). The fit is made
   * on React Flow's pan-zoom as it is once the canvas is measured; should React Flow create that
   * pan-zoom anew while mounting (StrictMode does), the new one starts from the default view, so
   * it is fitted again.
   */
  const fitOnLoad = useRef(savedViewport === undefined && nodes.length > 0);
  const fittedOn = useRef<unknown>(null);
  useEffect(() => {
    const attempt = () => {
      if (!fitOnLoad.current) return;
      const { width, height, panZoom } = rf.getState();
      if (panZoom === null || panZoom === fittedOn.current || width <= 0 || height <= 0) return;
      const box = bounds(flow.getNodes().map(rectOf));
      if (box === undefined) return;
      fittedOn.current = panZoom;
      void flow.setViewport(fitView(box, width, height));
    };
    attempt();
    return rf.subscribe(attempt);
  }, [rf, flow]);

  /**
   * PG-3.4: select a node and centre the view on it — a node followed here from Domain or Forge.
   * `false` while it cannot be done yet (the node or the canvas not measured), so it is retried.
   * Done once, it stands in for the first-load fit.
   */
  const focusNode = useCallback(
    (nodeId: string): boolean => {
      const target = flow.getInternalNode(nodeId);
      const { width, height, panZoom } = rf.getState();
      // measured: React Flow has mounted the card, and settled its first selection and view
      if (target?.measured?.width === undefined || panZoom === null || width <= 0 || height <= 0) {
        return false;
      }
      fitOnLoad.current = false;
      setSelection([nodeId], []);
      const { x, y } = target.internals.positionAbsolute;
      const w = target.measured.width ?? 0;
      const h = target.measured.height ?? 0;
      void flow.setViewport(centreOn(flow.getViewport(), x + w / 2, y + h / 2, width, height));
      return true;
    },
    [flow, rf, setSelection],
  );

  /*
   * The theme's wheel (D332): Ctrl/⌘ + wheel zooms at the cursor by `exp(−deltaY·0.01)`, a plain
   * wheel pans. Not over the settings modal or any dialog, nor over what scrolls on its own.
   */
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-cfg],[role="dialog"],.nowheel')) return;
      event.preventDefault();
      const r = el.getBoundingClientRect();
      void flow.setViewport(
        wheelView(flow.getViewport(), event, event.clientX - r.left, event.clientY - r.top),
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [flow]);

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
    (attempt: ConnectionAttempt) => {
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
   * The one rule the Canvas shows while a line is drawn (D350): what `isValidConnection` accepts,
   * and — where it refuses — the reason the drop would be refused with, the loop edge's own reason
   * added when the refusal is a cycle.
   */
  const checkForUi = useCallback<CheckConnection>(
    (attempt) => {
      const verdict = checkConnection(nodes, edges, attempt);
      if (verdict.ok) return { ok: true };
      if (verdict.code !== 'cycle') return { ok: false, reason: verdict.reason };
      const offer = loopOffer(attempt);
      if (offer.candidate !== undefined) return { ok: true };
      return {
        ok: false,
        reason: `${verdict.reason}${offer.reason === undefined ? '' : ` ${offer.reason}`}`,
      };
    },
    [nodes, edges, loopOffer],
  );

  /** A line dropped on a card that more than one input fits (D350): the small chooser. */
  const [dropChooser, setDropChooser] = useState<DropChooser>();
  /** The node whose ⋯ → "Connect to…" is open (D350). */
  const [connectFromNodeId, setConnectFromNodeId] = useState<string>();
  /** D373: the Run order panel, the node a "Run after…" is picking for, the selected link. */
  const [runOrderOpen, setRunOrderOpen] = useState(false);
  const [runAfterNodeId, setRunAfterNodeId] = useState<string>();
  const [selectedOrderId, setSelectedOrderId] = useState<string>();

  /**
   * D350: a line dropped anywhere on a card connects to the card's first compatible input; when
   * more than one fits, a chooser asks which; when none does, the refusal says why.
   */
  const dropLineOnCard = useCallback(
    (from: ConnectFrom, cardNodeId: string, at: { x: number; y: number }) => {
      if (readOnly || cardNodeId === from.nodeId) return;
      const outcome = dropOnCard(nodes, from, cardNodeId, checkForUi);
      if (outcome.kind === 'connect') {
        tryConnect(outcome.choice.attempt);
        return;
      }
      if (outcome.kind === 'refuse') {
        toast.error('Connection refused', { description: outcome.reason });
        return;
      }
      const bounds = wrapper.current?.getBoundingClientRect();
      setDropChooser({
        x: at.x - (bounds?.left ?? 0),
        y: at.y - (bounds?.top ?? 0),
        choices: outcome.choices,
      });
    },
    [readOnly, nodes, checkForUi, tryConnect],
  );

  /**
   * React Flow never calls onConnect for a drop `isValidConnection` refused, so the reason is
   * shown here instead (FR-CON-002/003/005: refused *with* a message). A drop that reached no port
   * it could end on but landed on a card connects to that card (D350).
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (!state.fromHandle || !state.fromNode) return;
      const sameSide = state.toHandle !== null && state.toHandle.type === state.fromHandle.type;
      if (state.toHandle === null || sameSide) {
        const point =
          'changedTouches' in event
            ? { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 }
            : { x: event.clientX, y: event.clientY };
        const under =
          typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(point.x, point.y)
            : null;
        const cardNodeId = under
          ?.closest('[data-node-card]')
          ?.closest('.react-flow__node')
          ?.getAttribute('data-id');
        if (cardNodeId) {
          dropLineOnCard(
            {
              nodeId: state.fromNode.id,
              portId: state.fromHandle.id ?? '',
              type: state.fromHandle.type,
            },
            cardNodeId,
            point,
          );
        }
        return;
      }
      if (state.isValid !== false) return;
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
    [nodes, edges, loopOffer, dropLineOnCard],
  );

  /**
   * D350: where a line is being drawn from, as one string so the Canvas re-renders when a drag
   * starts or ends, never on a pointer move.
   */
  const connectKey = useStore(selectConnectFrom);
  const connectStates = useMemo(() => {
    if (connectKey === '') return undefined;
    const [nodeId = '', portId = '', type] = connectKey.split('\u0000');
    return portConnectStates(
      nodes,
      { nodeId, portId, type: type === 'target' ? 'target' : 'source' },
      checkForUi,
    );
  }, [connectKey, nodes, checkForUi]);

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

  // Providers give the stage cards their look and sub line, and the "provider missing" note
  // (FR-NODE-010, FR-PRV-005); the model catalogue gives "Add node" its model.
  const providers = useProviders();
  /*
   * PG-4.4: while this workflow's run is live, the cards are drawn from what it executes — its
   * snapshot (BR-04) — over the graph being edited: a node removed since is a ghost, a node edited
   * since says so, and the edges the run still walks stay drawn.
   */
  const liveRunId = useRunStore((store) =>
    store.workflowId === workflowId && store.active ? store.runId : undefined,
  );
  const liveRun = useRun(liveRunId);
  const liveSnapshot =
    liveRunId !== undefined && liveRun.data?.id === liveRunId ? liveRun.data.snapshot : undefined;
  const drawn = useMemo(
    () => runSnapshotOverlay(nodes, edges, liveSnapshot),
    [nodes, edges, liveSnapshot],
  );
  const serverNodes = useMemo(
    () =>
      toFlowNodes(
        drawn.nodes,
        drawn.edges,
        armedPortId,
        onPortKey,
        providers.data ?? [],
        providers.isSuccess,
      ).map((node): AceFlowNode => {
        const sinceRun = drawn.sinceRun.get(node.id);
        if (sinceRun === undefined) return node;
        const ghost = sinceRun === 'removed';
        return {
          ...node,
          data: { ...node.data, sinceRun },
          // A ghost is drawn, never edited: the graph no longer has it to move, wire or delete.
          ...(ghost ? { draggable: false, connectable: false, deletable: false } : {}),
        };
      }),
    [drawn, armedPortId, onPortKey, providers.data, providers.isSuccess],
  );
  // Mounted with the selection it arrives with (PG-3.4: a node followed here from Domain or
  // Forge), so its card is drawn selected from the first frame.
  const [flowNodes, setFlowNodes] = useState<AceFlowNode[]>(() =>
    serverNodes.map((node) => ({ ...node, selected: selectedNodeIds.includes(node.id) })),
  );

  /**
   * Nodes to select once they are on the Canvas: what Add node, a drop, Duplicate and Paste just
   * added. Selected in the same tick they are added, they lose the selection: React Flow does not
   * have them yet, so its selection echo is "nothing selected", and that overwrites the store.
   */
  const selectOnArrival = useRef<string[] | undefined>(undefined);
  const selectWhenAdded = useCallback((ids: string[]) => {
    selectOnArrival.current = ids;
  }, []);

  // Server truth wins, but a node mid-drag keeps its live position until the drop is saved.
  useEffect(() => {
    let selection = selectedNodeIds;
    const arriving = selectOnArrival.current;
    if (arriving && arriving.every((id) => serverNodes.some((node) => node.id === id))) {
      selectOnArrival.current = undefined;
      selection = arriving;
      setSelection(arriving, []);
    }
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return serverNodes.map((node) => {
        const prev = byId.get(node.id);
        const selected = selection.includes(node.id);
        if (!prev) return { ...node, selected };
        return {
          ...node,
          selected,
          measured: prev.measured,
          ...(prev.dragging ? { position: prev.position, dragging: true } : {}),
        };
      });
    });
  }, [serverNodes, selectedNodeIds, setSelection]);

  /** Locked (D332): a press on a card is a click, never the start of a pan either. */
  const shownNodes = useMemo(
    () =>
      locked && !hand ? flowNodes.map((node) => ({ ...node, className: 'nopan' })) : flowNodes,
    [flowNodes, locked, hand],
  );

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
   * The loop chip's numbers (FR-PAR-005). [audit W-4] `edgeRevision` moves only on the frames that
   * change an edge (`node.state`, `loop.iteration`, `edge.transfer`) — a handful per run — so the
   * whole Canvas no longer re-renders on every streamed token, as it did keyed on `revision`.
   */
  const runRevision = useRunStore((store) => store.edgeRevision);
  // PG-4.2: a paused run, or one held on a WAITING node, is still live — not idle.
  const runIsLive = useRunStore(
    (store) =>
      store.workflowId === workflowId &&
      (store.status === 'RUNNING' ||
        store.status === 'PAUSED' ||
        (store.active && store.nodeRuns().some((run) => run.status === 'WAITING'))),
  );

  const flowEdges = useMemo(() => {
    // React Flow drops an edge whose endpoints it does not know yet and does not retry, so an
    // edge is handed over only once both its nodes are mounted; this memo re-runs when they are.
    const mounted = new Set(mountedIds === '' ? [] : mountedIds.split(','));
    const connectable = drawn.edges.filter(
      (edge) => mounted.has(edge.from.nodeId) && mounted.has(edge.to.nodeId),
    );
    const store = useRunStore.getState();
    // The iteration a loop edge shows is the one its *target* is on: that is the node the loop
    // sends work back to, and the node whose re-runs are being counted.
    const live = (edge: Edge) => {
      const iteration = store.workflowId === workflowId ? store.iterations(edge.to.nodeId) : 0;
      return iteration > 0 ? { iteration, running: runIsLive } : { running: runIsLive };
    };
    return toFlowEdges(connectable, drawn.nodes, live, providers.data ?? []).map((e) =>
      drawn.ghostEdgeIds.has(e.id)
        ? // PG-4.4: an edge the run still walks but the graph lost — drawn faint, never edited.
          { ...e, className: GHOST_EDGE_CLASS, selectable: false, deletable: false }
        : { ...e, selected: selectedEdgeIds.includes(e.id) },
    );
  }, [drawn, mountedIds, selectedEdgeIds, workflowId, runRevision, runIsLive, providers.data]);

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
      if (selNodes.length > 0 || selEdges.length > 0) setSelectedOrderId(undefined);
      setSelection(
        selNodes.map((n) => n.id),
        selEdges.map((e) => e.id),
      );
    },
    [setSelection],
  );

  /** [audit W-6] Whether this workflow's history has a step back / forward, for the toolbar. */
  const { canUndo, canRedo } = useHistoryDepth(workflowId);

  /**
   * [audit W-6] A delete asks nothing first, so it says what went and offers Undo — of that
   * delete only: once something else has been done since, the toolbar's Undo is the way back.
   */
  const announceUndoable = useCallback(
    (message: string) => {
      const entry = useHistoryStore.getState().byWorkflow[workflowId]?.past.at(-1);
      if (entry === undefined) return;
      toast(message, {
        action: {
          label: 'Undo',
          onClick: () => {
            if (useHistoryStore.getState().byWorkflow[workflowId]?.past.at(-1) === entry) {
              editor.undo();
            } else {
              toast.warning('Not undone — the workflow changed since. Use Undo in the toolbar.');
            }
          },
        },
      });
    },
    [workflowId, editor],
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
      announceUndoable(
        nodeIds.length === 0
          ? edgeIds.length === 1
            ? 'Connection deleted'
            : 'Connections deleted'
          : nodeIds.length === 1
            ? 'Node deleted'
            : `${nodeIds.length} nodes deleted`,
      );
    },
    [editor, nodes, edges, readOnly, announceUndoable],
  );

  /** D333: remove one node and join its incoming edges to its outgoing ones, one undo step. */
  const removeNodeReconnecting = useCallback(
    (nodeId: string) => {
      if (readOnly) return;
      const ops = removeReconnectingOps(nodes, edges, nodeId, workflowId);
      if (ops.length === 0) return;
      editor.edit(ops, 'Remove node');
      announceUndoable('Node removed');
    },
    [readOnly, nodes, edges, workflowId, editor, announceUndoable],
  );

  /* ------------------------------------------- editing an edge in place (FR-CON-001/004/006) */

  /** The model catalogue, so the type dropdown can say a node's model cannot serve a type. */
  const models = useModels();
  /** The edge whose chip or handles the pointer is on; cleared a moment after it leaves. */
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverEdge = useCallback((edgeId: string | undefined) => {
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    if (edgeId !== undefined) {
      setHoveredEdgeId(edgeId);
      return;
    }
    // a short grace, so the pointer can travel from the line to its chip or handles
    hoverTimer.current = setTimeout(() => setHoveredEdgeId(undefined), 220);
  }, []);
  useEffect(
    () => () => {
      if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    },
    [],
  );

  /** An end of a data edge being dragged to a new port (FR-CON-001). */
  const [reconnect, setReconnect] = useState<EdgeReconnectDrag>();

  /** The one rule for a moved end: `checkConnection` on the graph without the edge being moved. */
  const reconnectCheck = useCallback(
    (edgeId: string): CheckConnection =>
      (attempt) => {
        const verdict = checkConnection(nodes, withoutEdge(edges, edgeId), attempt);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    [nodes, edges],
  );

  /** The end that stays put while the other is dragged, as the start of a line. */
  const fixedEndOf = useCallback(
    (edgeId: string, moving: EdgeEnd): ConnectFrom | undefined => {
      const edge = edges.find((e) => e.id === edgeId);
      if (edge === undefined) return undefined;
      return moving === 'target'
        ? { nodeId: edge.from.nodeId, portId: edge.from.portId, type: 'source' }
        : { nodeId: edge.to.nodeId, portId: edge.to.portId, type: 'target' };
    },
    [edges],
  );

  /**
   * Where a dragged end was let go: on a port of the right side — that port; on a card — the card's
   * first compatible input (or output) as a line dropped on a card picks (D350); on empty Canvas —
   * nothing, and the edge stays as it was. One batch either way (delete + add), one undo step.
   */
  const finishReconnect = useCallback(
    (edgeId: string, end: EdgeEnd, clientX: number, clientY: number) => {
      if (readOnly) return;
      const fixed = fixedEndOf(edgeId, end);
      if (fixed === undefined) return;
      const under =
        typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(clientX, clientY)
          : null;
      const handle = under?.closest('.react-flow__handle');
      const wanted = end === 'target' ? 'target' : 'source';
      const handleNodeId = handle?.getAttribute('data-nodeid');
      const handlePortId = handle?.getAttribute('data-handleid');
      let attempt: ConnectionAttempt | undefined;
      if (handle && handle.classList.contains(wanted) && handleNodeId && handlePortId) {
        attempt =
          end === 'target'
            ? {
                source: fixed.nodeId,
                sourceHandle: fixed.portId,
                target: handleNodeId,
                targetHandle: handlePortId,
              }
            : {
                source: handleNodeId,
                sourceHandle: handlePortId,
                target: fixed.nodeId,
                targetHandle: fixed.portId,
              };
      } else {
        const cardNodeId = under
          ?.closest('[data-node-card]')
          ?.closest('.react-flow__node')
          ?.getAttribute('data-id');
        if (!cardNodeId) return; // empty Canvas: cancelled, the edge stays
        const outcome = dropOnCard(nodes, fixed, cardNodeId, reconnectCheck(edgeId));
        if (outcome.kind === 'refuse') {
          toast.error('Connection refused', { description: outcome.reason });
          return;
        }
        const choice = outcome.kind === 'connect' ? outcome.choice : outcome.choices[0];
        if (choice === undefined) return;
        attempt = choice.attempt;
      }
      const plan = reconnectPlan(nodes, edges, edgeId, attempt, workflowId);
      if (plan.kind === 'refuse') {
        toast.error('Connection refused', { description: plan.reason });
        return;
      }
      if (plan.kind === 'ok') {
        editor.edit(plan.ops, 'Reconnect');
        setSelection([], []);
      }
    },
    [readOnly, fixedEndOf, nodes, edges, reconnectCheck, workflowId, editor, setSelection],
  );

  // The drag itself: the moving end follows the pointer until it is let go (or Escape cancels).
  const reconnectKey = reconnect === undefined ? '' : `${reconnect.edgeId}\u0000${reconnect.end}`;
  const finishReconnectRef = useRef(finishReconnect);
  finishReconnectRef.current = finishReconnect;
  useEffect(() => {
    if (reconnectKey === '') return;
    const [edgeId = '', endRaw] = reconnectKey.split('\u0000');
    const end: EdgeEnd = endRaw === 'source' ? 'source' : 'target';
    const move = (event: PointerEvent) => {
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setReconnect((current) => current && { ...current, x: at.x, y: at.y });
    };
    const up = (event: PointerEvent) => {
      setReconnect(undefined);
      finishReconnectRef.current(edgeId, end, event.clientX, event.clientY);
    };
    const cancel = () => setReconnect(undefined);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [reconnectKey, flow]);

  /** While an end is dragged, the ports it could land on light up as for a new line (D350). */
  const reconnectStates = useMemo(() => {
    if (reconnectKey === '') return undefined;
    const [edgeId = '', endRaw] = reconnectKey.split('\u0000');
    const fixed = fixedEndOf(edgeId, endRaw === 'source' ? 'source' : 'target');
    return fixed === undefined
      ? undefined
      : portConnectStates(nodes, fixed, reconnectCheck(edgeId));
  }, [reconnectKey, fixedEndOf, nodes, reconnectCheck]);

  /** The live half of the edge-edit API; the API the layer holds reads it through a ref. */
  const edgeEditImpl = {
    typeOptions: (edgeId: string): EdgeTypeOption[] =>
      edgeTypeOptions(nodes, edges, edgeId, models.data?.items ?? [], workflowId),
    pickType: (edgeId: string, option: EdgeTypeOption) => {
      if (readOnly || !option.ok || option.current) return;
      // re-planned on the graph as it is now: the menu may have been open across a change
      const fresh = edgeTypeOptions(
        nodes,
        edges,
        edgeId,
        models.data?.items ?? [],
        workflowId,
      ).find((o) => o.type === option.type);
      if (fresh === undefined || !fresh.ok || fresh.current) {
        if (fresh !== undefined && !fresh.ok) {
          toast.error('Type not changed', { description: fresh.reason });
        }
        return;
      }
      editor.edit(fresh.ops, `Change connection to ${option.type}`);
    },
    debate: (edgeId: string): DebateMenu => debateMenuFor(nodes, edges, edgeId),
    setDebate: (edgeId: string, debate: DebateConfig | null) => {
      if (readOnly) return;
      editor.edit(
        [{ op: 'update_edge', edgeId, patch: { debate } }],
        debate === null ? 'Stop debating' : 'Debate',
      );
    },
    remove: (edgeId: string) => {
      setHoveredEdgeId(undefined);
      deleteElements([], [edgeId]);
    },
    select: (edgeId: string) => setSelection([], [edgeId]),
    startReconnect: (edgeId: string, end: EdgeEnd, event: ReactPointerEvent) => {
      if (readOnly || event.button !== 0) return;
      const edge = edges.find((e) => e.id === edgeId);
      if (edge === undefined || edge.kind !== 'data') return;
      event.preventDefault();
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setSelection([], [edgeId]);
      setReconnect({ edgeId, end, x: at.x, y: at.y });
    },
  };
  const edgeEditRef = useRef(edgeEditImpl);
  edgeEditRef.current = edgeEditImpl;
  const edgeEdit = useMemo<EdgeEditApi>(
    () => ({
      typeOptions: (edgeId) => edgeEditRef.current.typeOptions(edgeId),
      pickType: (edgeId, option) => edgeEditRef.current.pickType(edgeId, option),
      debate: (edgeId) => edgeEditRef.current.debate(edgeId),
      setDebate: (edgeId, debate) => edgeEditRef.current.setDebate(edgeId, debate),
      remove: (edgeId) => edgeEditRef.current.remove(edgeId),
      select: (edgeId) => edgeEditRef.current.select(edgeId),
      hover: (edgeId) => hoverEdge(edgeId),
      startReconnect: (edgeId, end, event) =>
        edgeEditRef.current.startReconnect(edgeId, end, event),
    }),
    [hoverEdge],
  );

  const onEdgeMouseEnter: EdgeMouseHandler = useCallback(
    (_event, edge) => hoverEdge(edge.id),
    [hoverEdge],
  );
  const onEdgeMouseLeave: EdgeMouseHandler = useCallback(() => hoverEdge(undefined), [hoverEdge]);

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: AceFlowNode[]; edges: Array<{ id: string }> }) =>
      deleteElements(
        gone.map((n) => n.id),
        cut.map((e) => e.id),
      ),
    [deleteElements],
  );

  const addNodeAt = useCallback(
    function addNodeAt(
      kind: CanvasNodeKind,
      position: { x: number; y: number },
      init?: NewNodeInit,
    ): Node | undefined {
      if (readOnly) return undefined;
      // PG-1.3 (D351): an Agent/Model waits for the picker; Cancel creates nothing.
      if (needsProviderChoice(kind, init)) {
        requestProviderChoice({
          ...(init?.modelId === undefined ? {} : { initial: { modelId: init.modelId } }),
          onChosen: (choice) => addNodeAt(kind, position, { ...init, ...choice }),
        });
        return undefined;
      }
      // Unnamed, an Agent/Model is "New agent", "New agent 2"…: never a name already on the board.
      const fallback = NEW_NODE_NAME[kind];
      const named =
        fallback === undefined || (init?.name ?? '').trim() !== ''
          ? init
          : {
              ...init,
              name: uniqueNodeName(
                fallback,
                nodes.map((each) => each.name),
              ),
            };
      const node = applyNewNodeInit(
        createNode(kind, workflowId, {
          x: Math.round(position.x),
          y: Math.round(position.y),
        }),
        named,
      );
      editor.edit([{ op: 'add_node', node }], 'Add node');
      selectWhenAdded([node.id]);
      return node;
    },
    [editor, workflowId, selectWhenAdded, readOnly, nodes],
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
      const size = cardSize(kind);
      const slot = freeSlotNear(
        nodes,
        { x: center.x - size.w / 2, y: center.y - size.h / 2 },
        visible,
      );
      const node = addNodeAt(kind, slot, init);

      // when the view was too crowded to hold it, bring the new node into sight
      const inView =
        slot.x >= visible.x &&
        slot.y >= visible.y &&
        slot.x <= visible.x + visible.width &&
        slot.y <= visible.y + visible.height;
      if (!inView) requestAnimationFrame(fitAll);
      return node;
    },
    [addNodeAt, flow, nodes, readOnly, fitAll],
  );

  /**
   * The theme's "Add node" (D332): an Agent after the last stage, linked to it, as one undo step;
   * then selected, its settings opened and the view centred on it.
   */
  const addStage = useCallback(
    (preset?: DebateRole) => {
      if (readOnly) return;
      // PG-1.3 (D351): provider, then model, then the node — nothing is sent before both are chosen.
      requestProviderChoice({
        onChosen: (choice) => {
          const plan = planNewStage({
            nodes,
            edges,
            workflowId,
            choice,
            ...(preset === undefined ? {} : { preset }),
          });
          editor.edit(plan.ops, 'Add node');
          selectWhenAdded([plan.node.id]);
          usePanelsStore.getState().openSettings({ kind: 'node', id: plan.node.id });
          const { cw, ch } = canvasSize();
          const { x, y } = plan.node.position;
          void flow.setViewport(centreOn(flow.getViewport(), x + 105, y + 140, cw, ch));
        },
      });
    },
    [readOnly, nodes, edges, workflowId, editor, selectWhenAdded, canvasSize, flow],
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
      const place = (placed: Node[]) => {
        editor.edit(
          placed.map((node) => ({ op: 'add_node' as const, node })),
          placed.length === 1 ? 'Duplicate node' : `Duplicate ${placed.length} nodes`,
        );
        selectWhenAdded(placed.map((n) => n.id));
      };
      // PG-1.3 (D351): a copy that would be born without a usable provider asks for one first.
      const known = providers.data ?? [];
      if (!copies.some((copy) => lacksUsableProvider(copy, known))) {
        place(copies);
        return;
      }
      const only = copies.length === 1 ? copies[0] : undefined;
      const agentCopy = only?.kind === 'agent' ? only : undefined;
      requestProviderChoice({
        title: 'Choose a provider for the copy',
        confirmLabel: 'Duplicate',
        // D353: one agent copied — a model that cannot honour its schema or tools is marked.
        ...(agentCopy === undefined ? {} : { needs: agentCopy.config }),
        onChosen: (choice) =>
          place(
            copies.map((copy) =>
              lacksUsableProvider(copy, known) ? withProviderChoice(copy, choice) : copy,
            ),
          ),
      });
    },
    [nodes, editor, selectWhenAdded, readOnly, providers.data],
  );

  const duplicateSelection = useCallback(
    () => duplicateNodesById(selectedNodeIds),
    [duplicateNodesById, selectedNodeIds],
  );

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
      selectWhenAdded(pasted.nodes.map((n) => n.id));
    },
    [readOnly, workflowId, nodes, editor, selectWhenAdded],
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
    requestAnimationFrame(fitAll);
  }, [readOnly, nodes, edges, flow, editor, fitAll]);

  const undo = useCallback(() => {
    if (!readOnly) editor.undo();
  }, [editor, readOnly]);
  const redo = useCallback(() => {
    if (!readOnly) editor.redo();
  }, [editor, readOnly]);

  /* ---------------------------------------------------------------- position history (D332) */

  /** The theme's `nodeDown`: a press on a card, unlocked, remembers where every node stood. */
  /** Where the last left press went down: a release more than 4 px away is a drag (D350). */
  const pressAt = useRef<{ x: number; y: number }>(undefined);

  const onMouseDownCapture = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button === 0) pressAt.current = { x: event.clientX, y: event.clientY };
      if (event.button !== 0 || readOnly || hand || locked || !onCard(event.target)) return;
      const snapshot = snapshotPositions(nodes);
      setMoveHistory((history) => [...history.slice(-(MOVE_HISTORY_LIMIT - 1)), snapshot]);
    },
    [readOnly, hand, locked, nodes],
  );

  const undoMove = useCallback(() => {
    if (readOnly) return;
    const { ops, rest } = takeMoveBack(moveHistory, nodes);
    if (ops.length > 0)
      editor.edit(ops, ops.length === 1 ? 'Move node' : `Move ${ops.length} nodes`);
    setMoveHistory(rest);
  }, [readOnly, moveHistory, nodes, editor]);

  const canUndoMove = useMemo(
    () => moveHistory.some((snapshot) => movesBack(snapshot, nodes).length > 0),
    [moveHistory, nodes],
  );

  /* ------------------------------------------------- who runs when (D373) */

  /** A Run order edit: its ops as one undo step, or its reason as a toast. */
  const applyRunOrder = useCallback(
    (outcome: RunOrderEdit) => {
      if (readOnly) return;
      if (!outcome.ok) {
        toast.error('Run order not changed', { description: outcome.reason });
        return;
      }
      if (outcome.ops.length > 0) editor.edit(outcome.ops, outcome.label);
    },
    [readOnly, editor],
  );

  /** The "run after" links as the order layer draws them; the run's lost ones faint (PG-4.4). */
  const orderLinks = useMemo<OrderLink[]>(
    () =>
      drawn.edges
        .filter((edge) => edge.kind === 'order')
        .map((edge) => ({
          id: edge.id,
          fromNodeId: edge.from.nodeId,
          toNodeId: edge.to.nodeId,
          ...(drawn.ghostEdgeIds.has(edge.id) ? { ghost: true } : {}),
        })),
    [drawn],
  );

  const orderEditImpl = {
    select: (edgeId: string) => {
      setSelection([], []);
      setSelectedOrderId(edgeId);
    },
    remove: (edgeId: string) => {
      setSelectedOrderId((at) => (at === edgeId ? undefined : at));
      deleteElements([], [edgeId]);
    },
  };
  const orderEditRef = useRef(orderEditImpl);
  orderEditRef.current = orderEditImpl;
  const orderEdit = useMemo<OrderEditApi>(
    () => ({
      select: (edgeId) => orderEditRef.current.select(edgeId),
      remove: (edgeId) => orderEditRef.current.remove(edgeId),
    }),
    [],
  );

  /** A selected link goes with Delete or Backspace, as a selected connection does (FR-CAN-009). */
  useEffect(() => {
    if (selectedOrderId === undefined || readOnly) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedOrderId(undefined);
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      orderEditRef.current.remove(selectedOrderId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedOrderId, readOnly]);

  /** PG-1.2 (D360): the cards' Settings and More buttons. */
  const startRun = useStartRun(workflowId);
  const startRunMutate = startRun.mutate;
  const cardActions = useMemo<NodeCardActions>(
    () => ({
      readOnly,
      openSettings: (nodeId) => {
        setSelection([nodeId], []);
        if (!readOnly) usePanelsStore.getState().openSettings({ kind: 'node', id: nodeId });
      },
      connectTo: (nodeId) => {
        if (!readOnly) setConnectFromNodeId(nodeId);
      },
      duplicate: (nodeId) => duplicateNodesById([nodeId]),
      remove: (nodeId) => deleteElements([nodeId], []),
      runAfter: (nodeId) => {
        if (!readOnly) setRunAfterNodeId(nodeId);
      },
      // [audit W-1] a refused start says why and puts the run on screen back (useStartRun);
      // [audit W-8] the menu holds it back while a run is going, and so does this
      runFromHere: (nodeId) => {
        const store = useRunStore.getState();
        if (store.workflowId === workflowId && store.active) return;
        startRunMutate({ startFromNodeId: nodeId });
      },
    }),
    [readOnly, setSelection, duplicateNodesById, deleteElements, startRunMutate, workflowId],
  );

  // Expose to the settings modal, the sheet and the workspace menu (outside the flow).
  const register = useCanvasApi((s) => s.register);
  useEffect(
    () =>
      register({
        addNode: addNodeAtCenter,
        deleteNodes: (ids) => deleteElements(ids, []),
        removeNodeReconnecting,
        fitView: fitAll,
        duplicateSelection,
        autoArrange,
        undo,
        redo,
        readOnly,
        focusNode,
      }),
    [
      register,
      addNodeAtCenter,
      deleteElements,
      removeNodeReconnecting,
      fitAll,
      duplicateSelection,
      autoArrange,
      undo,
      redo,
      readOnly,
      focusNode,
    ],
  );

  /* ---------------------------------------------------------------- click to open settings */

  /**
   * D332: a click (or double-click) on a card that did not move it selects it and opens its
   * settings — locked or not. Shift/Ctrl/⌘ keep it a multi-select; the hand tool selects nothing.
   * D350: only a click — the pointer moved at most 4 px since the press — on the card body, never
   * on a port or one of the card's buttons (those have their own actions).
   */
  const onNodeClick = useCallback(
    (event: ReactMouseEvent, node: { id: string }) => {
      if (hand || !onCard(event.target)) return;
      if (!isClick(pressAt.current, { x: event.clientX, y: event.clientY })) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;
      setSelection([node.id], []);
      // PG-4.4: a ghost has no settings to open — the graph no longer has it; selecting it is
      // what shows its run in the Inspector.
      if (drawn.sinceRun.get(node.id) === 'removed') return;
      if (!readOnly) usePanelsStore.getState().openSettings({ kind: 'node', id: node.id });
    },
    [hand, readOnly, setSelection, drawn],
  );

  /* ---------------------------------------------------------------- drop from a drag source */

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
        fitAll();
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
  }, [fitAll, selectAll, copySelection, paste, duplicateSelection, editor, readOnly]);

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
   * (its own inline menu), and the toolbar, minimap, breadcrumb and Add node get no menu at all.
   */
  const onCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const nodeEl = target?.closest('.react-flow__node');
      const nodeId = nodeEl?.getAttribute('data-id') ?? undefined;
      if (nodeId !== undefined && drawn.sinceRun.get(nodeId) === 'removed') {
        // PG-4.4: a ghost card offers no actions; the right-click only selects it.
        event.preventDefault();
        setEdgeMenu(undefined);
        setMenuTarget(undefined);
        setSelection([nodeId], []);
        return;
      }
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
    [flow, selectedNodeIds, setSelection, drawn],
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
  const cursor = paneDragging ? 'grabbing' : hand ? 'grab' : 'default';

  return (
    <CanvasDarkContext.Provider value={dark}>
      <PortConnectContext.Provider value={connectStates}>
        {inRouter && <FollowNodeFromUrl focus={focusNode} subscribe={rf.subscribe} />}
        <CardActionsProvider value={cardActions} routed={inRouter} workflowId={workflowId}>
          <ContextMenu
            modal={false}
            onOpenChange={(open) => {
              if (!open) setMenuTarget(undefined);
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                ref={wrapper}
                className="absolute inset-0 select-none overflow-hidden bg-[var(--canvas)] leading-[normal] text-[var(--ink)]"
                style={{ cursor }}
                data-testid="canvas"
                data-readonly={readOnly ? 'true' : undefined}
                data-locked={locked ? 'true' : 'false'}
                data-tool={hand ? 'hand' : 'select'}
                data-far={far ? 'true' : undefined}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onContextMenu={onCanvasContextMenu}
                onMouseDownCapture={onMouseDownCapture}
              >
                <CanvasBackdrop />
                <ReactFlow<AceFlowNode>
                  nodes={shownNodes}
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
                  onEdgeMouseEnter={readOnly ? undefined : onEdgeMouseEnter}
                  onEdgeMouseLeave={readOnly ? undefined : onEdgeMouseLeave}
                  onPaneClick={() => {
                    setEdgeMenu(undefined);
                    setSelectedOrderId(undefined);
                  }}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeClick}
                  onMoveEnd={onMoveEnd}
                  defaultViewport={savedViewport ?? { x: 0, y: 0, zoom: 1 }}
                  deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
                  nodesDraggable={!readOnly && !locked && !hand}
                  nodesConnectable={!readOnly && !hand}
                  elementsSelectable={!hand}
                  multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
                  selectionKeyCode={hand ? null : 'Shift'}
                  // D332: React Flow pans on a left or middle drag; the wheel is the Canvas's own.
                  panOnDrag={[0, 1]}
                  panOnScroll={false}
                  zoomOnScroll={false}
                  zoomOnPinch={false}
                  zoomOnDoubleClick={false}
                  // Culling leaves off-screen nodes unmeasured, so a fit cannot bring them back and a
                  // node added outside the view becomes unreachable. Rendering all 200 fixture nodes
                  // costs less than the noise in TC-NFR-001, so the trade is not worth it.
                  onlyRenderVisibleElements={false}
                  minZoom={ZOOM_MIN}
                  maxZoom={ZOOM_MAX}
                  connectionLineStyle={{
                    stroke: '#ef6b3f',
                    strokeWidth: 1.6,
                    strokeDasharray: '5 5',
                  }}
                  proOptions={{ hideAttribution: true }}
                  className="ace-canvas"
                  style={{ background: 'transparent' }}
                >
                  <EdgeLayer
                    nodes={drawn.nodes}
                    edges={flowEdges}
                    edit={readOnly || hand ? undefined : edgeEdit}
                    hoveredEdgeId={hoveredEdgeId}
                    reconnect={reconnect}
                  />
                  <OrderEdgeLayer
                    nodes={drawn.nodes}
                    links={orderLinks}
                    selectedIds={selectedOrderId === undefined ? [] : [selectedOrderId]}
                    edit={readOnly || hand ? undefined : orderEdit}
                  />
                  <PortDotLayer
                    nodes={nodes}
                    connectStates={connectStates ?? reconnectStates}
                    selectedNodeIds={selectedNodeIds}
                    armedPortId={armedPortId}
                  />
                  <ConnectRefusalTooltip states={connectStates} />
                </ReactFlow>

                {inRouter && !readOnly && <CanvasBreadcrumb workflowId={workflowId} />}

                <button
                  type="button"
                  data-testid="run-order-button"
                  aria-label="Run order"
                  aria-pressed={runOrderOpen}
                  title="Who runs when"
                  onClick={() => setRunOrderOpen((open) => !open)}
                  className={cn(
                    'absolute top-[12px] z-[5] flex h-[34px] cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-full border bg-[var(--surface)] px-[14px] text-[12.5px] font-semibold text-[var(--ink)] shadow-[0_10px_26px_-14px_rgba(40,25,15,0.45)] outline-none hover:border-[#ef6b3f] focus-visible:border-[var(--focus)]',
                    readOnly ? 'right-[16px]' : 'right-[136px]',
                    runOrderOpen ? 'border-[#ef6b3f]' : 'border-[var(--line)]',
                  )}
                >
                  <Icons.ListOrdered aria-hidden size={14} />
                  Run order
                </button>
                {runOrderOpen && (
                  <RunOrderPanel
                    workflowId={workflowId}
                    nodes={nodes}
                    edges={edges}
                    readOnly={readOnly}
                    onFocus={(nodeId) => {
                      focusNode(nodeId);
                    }}
                    onEdit={applyRunOrder}
                    onClose={() => setRunOrderOpen(false)}
                  />
                )}

                {!readOnly && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid="new-node-button"
                        title="Add a node"
                        className="absolute right-[16px] top-[12px] z-[5] flex h-[34px] cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--surface)] py-0 pl-[6px] pr-[16px] text-[12.5px] font-semibold text-[var(--ink)] shadow-[0_10px_26px_-14px_rgba(40,25,15,0.45)] outline-none hover:border-[#ef6b3f] hover:shadow-[0_12px_30px_-12px_rgba(239,107,63,0.45)] focus-visible:border-[var(--focus)]"
                      >
                        <span
                          aria-hidden
                          className="flex h-[24px] w-[24px] items-center justify-center rounded-full bg-[#ef6b3f] text-[16px] leading-none text-[#fff] shadow-[0_0_0_3px_rgba(239,107,63,0.15)]"
                        >
                          +
                        </span>
                        Add node
                      </button>
                    </DropdownMenuTrigger>
                    {/* D406: an Agent, or one of the preset debaters. */}
                    <DropdownMenuContent align="end" data-testid="new-node-menu">
                      {ADD_NODE_CHOICES.map((choice) => (
                        <DropdownMenuItem
                          key={choice.label}
                          data-testid={`new-node-${choice.preset ?? 'agent'}`}
                          className="h-auto min-h-8 items-start py-[6px]"
                          onSelect={() => addStage(choice.preset)}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="font-medium">{choice.label}</span>
                            <span className="max-w-[240px] whitespace-normal text-[11px] leading-[1.35] text-[var(--muted)]">
                              {choice.hint}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <CanvasToolbar
                  readOnly={readOnly}
                  locked={locked}
                  hand={hand}
                  canUndoMove={canUndoMove}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  mod={MOD}
                  onUndo={undo}
                  onRedo={redo}
                  onZoomIn={() => zoomBy(() => ZOOM_STEP)}
                  onZoomOut={() => zoomBy(() => 1 / ZOOM_STEP)}
                  onResetZoom={() => zoomBy((zoom) => 1 / zoom)}
                  onFit={fitAll}
                  onToggleLock={() => setLocked((on) => !on)}
                  onToggleHand={() => setHand((on) => !on)}
                  onUndoMove={undoMove}
                />
                <CanvasMinimap dark={dark} />

                {/* PG-1.3 (D351): the provider-first picker Add node, drop and Duplicate open. */}
                <ProviderPickerHost />

                {loopCandidate && (
                  <MakeLoopEdgeDialog
                    candidate={loopCandidate}
                    onCancel={() => setLoopCandidate(undefined)}
                    onCreate={(loop) => createLoopEdge(loopCandidate, loop)}
                  />
                )}

                {dropChooser && (
                  <DropChooserMenu
                    chooser={dropChooser}
                    onPick={(choice) => {
                      setDropChooser(undefined);
                      tryConnect(choice.attempt);
                    }}
                    onClose={() => setDropChooser(undefined)}
                  />
                )}

                {edgeMenu && (
                  <div
                    role="menu"
                    aria-label="Connection actions"
                    className={cn(MENU_CONTENT_CLASS, 'absolute')}
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
                        if (!readOnly)
                          usePanelsStore.getState().openSettings({ kind: 'edge', id: edgeId });
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
                {!readOnly && (
                  <ContextMenuItem
                    onSelect={() => {
                      setSelection([menuTarget.nodeId], []);
                      usePanelsStore
                        .getState()
                        .openSettings({ kind: 'node', id: menuTarget.nodeId });
                    }}
                  >
                    Settings
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  onSelect={() => {
                    setSelection([menuTarget.nodeId], []);
                    usePanelsStore.getState().openSheet('inspect');
                  }}
                >
                  Inspect
                </ContextMenuItem>
                {inRouter &&
                  nodes.some(
                    (node) =>
                      node.id === menuTarget.nodeId &&
                      (node.kind === 'agent' || node.kind === 'model'),
                  ) && <OpenInDomainItem workflowId={workflowId} nodeId={menuTarget.nodeId} />}
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
                    {PALETTE_NODE_KINDS.map((kind) => (
                      <ContextMenuItem
                        key={kind}
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
                <ContextMenuItem onSelect={fitAll}>
                  Fit view <ContextMenuShortcut>F</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
          {runAfterNodeId !== undefined && (
            <RunAfterDialog
              nodes={nodes}
              edges={edges}
              nodeId={runAfterNodeId}
              onPick={(afterId) =>
                applyRunOrder(addRunAfter(workflowId, nodes, edges, runAfterNodeId, afterId))
              }
              onClose={() => setRunAfterNodeId(undefined)}
            />
          )}
          {connectFromNodeId !== undefined && (
            <ConnectToDialog
              nodes={nodes}
              fromNodeId={connectFromNodeId}
              check={checkForUi}
              onConnect={(choice) => tryConnect(choice.attempt)}
              onClose={() => setConnectFromNodeId(undefined)}
            />
          )}
        </CardActionsProvider>
      </PortConnectContext.Provider>
    </CanvasDarkContext.Provider>
  );
}

/**
 * D350: a line dropped on a card that more than one input fits — a small menu at the drop point,
 * one item per input. Escape or a press elsewhere closes it, connecting nothing.
 */
function DropChooserMenu({
  chooser,
  onPick,
  onClose,
}: {
  chooser: DropChooser;
  onPick: (choice: ConnectChoice) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof globalThis.Node && menu.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Connect to which input?"
      data-testid="drop-chooser"
      className={cn(MENU_CONTENT_CLASS, 'absolute z-[20]')}
      style={{ left: chooser.x, top: chooser.y }}
    >
      <div className="px-[10px] py-[6px] text-[11px] font-semibold text-[var(--muted)]">
        Connect to which input?
      </div>
      {chooser.choices.map((choice) => (
        <button
          key={`${choice.from.id}>${choice.to.id}`}
          type="button"
          role="menuitem"
          className={cn(EDGE_MENU_ITEM, 'text-[var(--ink)]')}
          onClick={() => onPick(choice)}
        >
          {portLabel(choice.from, 'out')}
          <Icons.ArrowRight aria-hidden size={12} className="mx-1 inline shrink-0" />
          {portLabel(choice.to, 'in')}
        </button>
      ))}
    </div>
  );
}

const EDGE_MENU_ITEM =
  'relative flex h-8 w-full shrink-0 cursor-pointer select-none items-center gap-2 rounded-[7px] border-none bg-transparent px-[10px] text-left text-[12.5px] outline-none hover:bg-[rgba(239,107,63,0.12)] focus-visible:bg-[rgba(239,107,63,0.12)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

/**
 * What the edge context menu offers (round 3 §5 item 8), in the theme's menu.
 *
 * "Make loop edge" asks the contract, never a rule of its own, and when the contract refuses it says
 * why rather than hiding: the usual answer for an existing data edge is that its target is not
 * upstream of its source, which is exactly what the operator needs to hear. A loop edge already on
 * the graph offers its settings instead — the node settings modal, opened on the edge (D333).
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
          className={cn(EDGE_MENU_ITEM, 'text-[var(--ink)]')}
          onClick={() => onEditLoop(edge.id)}
        >
          Loop settings
        </button>
      ) : readOnly ? null : (
        <button
          type="button"
          role="menuitem"
          className={cn(EDGE_MENU_ITEM, 'text-[var(--ink)]')}
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
          className={cn(EDGE_MENU_ITEM, 'text-danger')}
          onClick={onDelete}
        >
          Delete connection
        </button>
      )}
    </>
  );
}
