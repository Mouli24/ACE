import type {
  DataType,
  FailureReason,
  ModelUsed,
  Node,
  NodeState,
  Port,
  ProviderType,
} from '@ace/contracts';
import { DEFAULT_SEARCH_MODE } from '@ace/contracts';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
  type Node as FlowNode,
} from '@xyflow/react';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { InputDropZone } from '../artifacts/InputDropZone';
import { findBlockingNodeId } from '../errors/blocked';
import { NodeApproval, NodeErrorCard, UnderCard } from '../runs/NodeRunAttachments';
import { useNodeOverlay, useRunStore } from '../runs/run-store';
import { th, themeProviderOf } from '../theme/constants';
import { nodeStatusLook } from '../theme/format';
import { useWorkflowGraph } from '../workflows/hooks';

import { DOC_W, STAGE_W, isStageKind, portAnchor } from './anchors';
import { PortConnectContext } from './card-context';
import { NodeCardButtons } from './NodeCardButtons';
import { NodePreflightIssues } from './NodePreflightIssues';
import { useKnowledgeBaseName, useWorkflowProjectId } from './retrieval/hooks';

/** React Flow node payload: the contract node plus what the Canvas knows about it. */
export type FlowNodeData = {
  node: Node;
  connectedPortIds: Set<string>;
  /** The node's provider type, for the stage card's orb and border (FR-NODE-010). */
  provider?: ProviderType;
  /** The provider record's name, for the stage card's sub line. */
  providerName?: string;
  /** Set when the node's provider is gone (FR-PRV-005). */
  providerMissing?: boolean;
  /** Agent/Model: its 1-based place among the workflow's stages (`agentsOf` order). */
  stage?: number;
  /** Other kinds: the stages this node's output feeds, for "Attached to Stage n". */
  feeds?: readonly number[];
  /** Output: the data types arriving on its connected inputs. */
  receives?: readonly DataType[];
  /** Keyboard connect (NFR-USE-02): the output port armed with Enter, if any. */
  armedPortId: string | undefined;
  onPortKey: (port: Port, direction: 'in' | 'out', nodeId: string) => void;
};
export type AceFlowNode = FlowNode<FlowNodeData, 'ace'>;

/** Whether the Canvas is drawn dark: the stage orbs and badges take the theme's dark look. */
export const CanvasDarkContext = createContext(false);

export interface NodeCardViewProps {
  node: Node;
  /** The status row, from the run overlay's `node.state` frames (FR-EXE-009). */
  state: NodeState;
  selected: boolean;
  connectedPortIds: Set<string>;
  /** Provider look, fixed per provider type and never moved by state (FR-NODE-010). */
  provider?: ProviderType;
  providerName?: string;
  stage?: number;
  feeds?: readonly number[];
  receives?: readonly DataType[];
  dark?: boolean;
  armedPortId?: string;
  onPortKey?: (port: Port, direction: 'in' | 'out') => void;
  /** A Retrieval node's base, by name, once the project's bases have loaded (FR-RAG-006). */
  knowledgeBaseName?: string;
}

/** The card's 1px border: handles are placed inside it, anchors are measured from outside it. */
const BORDER = 1;

/**
 * One port's React Flow handle (D350, supersedes D332's invisible one): a 22px target centred on the
 * theme's anchor with an 8px dot in its data type's colour. `theme.css` shows it on hover, on a
 * selected card, on focus or armed for a keyboard connect (NFR-USE-02), and — from
 * `PortConnectContext` — on every compatible port while a line is drawn; an incompatible one is
 * dimmed and says why.
 */
function PortHandle({
  port,
  direction,
  index,
  count,
  kind,
  connected,
  armed,
  onKey,
}: {
  port: Port;
  direction: 'in' | 'out';
  index: number;
  count: number;
  kind: Node['kind'];
  connected: boolean;
  armed: boolean;
  onKey?: (port: Port, direction: 'in' | 'out') => void;
}) {
  const anchor = portAnchor(kind, direction, index, count);
  const connecting = useContext(PortConnectContext)?.get(port.id);
  const refused = connecting?.look === 'incompatible' ? connecting.reason : undefined;
  const label = `${port.dataType} ${direction === 'in' ? 'input' : 'output'} “${port.name}”${
    port.multi ? ', accepts many' : ''
  }`;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onKey?.(port, direction);
    }
  };
  return (
    <Handle
      id={port.id}
      type={direction === 'in' ? 'target' : 'source'}
      position={direction === 'in' ? Position.Left : Position.Right}
      className="ace-port"
      style={
        {
          left: anchor.x - BORDER,
          top: anchor.y - BORDER,
          right: 'auto',
          transform: 'translate(-50%, -50%)',
          '--port-color': `var(--port-${port.dataType})`,
        } as CSSProperties
      }
      tabIndex={0}
      role="button"
      aria-label={label}
      {...(refused === undefined ? {} : { title: refused, 'aria-description': refused })}
      data-testid={`port-${port.id}`}
      data-connected={connected ? 'true' : 'false'}
      data-datatype={port.dataType}
      data-armed={armed ? 'true' : 'false'}
      data-connect={connecting?.look ?? 'none'}
      onKeyDown={onKeyDown}
    />
  );
}

function PortHandles({
  node,
  connectedPortIds,
  armedPortId,
  onPortKey,
}: Pick<NodeCardViewProps, 'node' | 'connectedPortIds' | 'armedPortId' | 'onPortKey'>) {
  const side = (ports: readonly Port[], direction: 'in' | 'out') =>
    ports.map((port, index) => (
      <PortHandle
        key={port.id}
        port={port}
        direction={direction}
        index={index}
        count={ports.length}
        kind={node.kind}
        connected={connectedPortIds.has(port.id)}
        armed={armedPortId === port.id}
        {...(onPortKey === undefined ? {} : { onKey: onPortKey })}
      />
    ));
  return (
    <>
      {side(node.inputs, 'in')}
      {side(node.outputs, 'out')}
    </>
  );
}

/** What the stage card's sub line says: the provider record and the model, or what is missing. */
function stageSub(node: Node, providerName: string | undefined): string {
  const modelId = node.kind === 'agent' || node.kind === 'model' ? node.config.modelId : undefined;
  return `${providerName ?? 'no provider'} · ${modelId ?? 'no model'}`;
}

/**
 * The theme's Stage card (D332) for Agent and Model nodes: 210 × 280, the provider's orb and
 * border, `STAGE n · NAME`, the provider and model, and the live status.
 */
function StageCard(props: NodeCardViewProps) {
  const { node, state, selected, provider, providerName, stage, dark = false } = props;
  const look = th(themeProviderOf(provider), dark);
  const ring = look.w ? '#bdb6ae' : look.c;
  const status = nodeStatusLook(state);
  const name = node.name || 'Untitled';
  const n = stage ?? '';
  return (
    <div
      data-node-card
      data-testid={`node-card-${node.id}`}
      data-kind={node.kind}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      data-provider={provider ?? 'none'}
      className="relative h-[280px] w-[210px] cursor-move rounded-[10px] bg-[var(--frame)] text-[var(--ink)]"
      style={{
        border: `1px solid ${selected ? ring : look.w ? 'var(--frameLine)' : `rgba(${look.glow},0.38)`}`,
        boxShadow: selected
          ? `0 0 0 2px ${ring}, 0 12px 40px -16px rgba(${look.glow},0.55)`
          : 'none',
      }}
    >
      <div
        data-testid={`stage-label-${node.id}`}
        className="absolute left-[12px] top-[-9px] whitespace-nowrap rounded-[4px] bg-[var(--canvas)] px-[7px] py-[2px] font-machine text-[9px] font-medium tracking-[0.1em] text-[#7a62d6]"
      >
        STAGE {n} · {name.toUpperCase()}
      </div>
      <NodeCardButtons node={node} className="right-[16px] top-[12px]" />
      <div className="absolute right-[-9px] top-[-9px] flex h-[20px] w-[20px] items-center justify-center rounded-full border border-[var(--frameLine)] bg-[var(--surface)] text-[10px] font-semibold">
        {n}
      </div>
      <div
        data-testid={`stage-orb-${node.id}`}
        className="absolute left-[77px] top-[90px] flex h-[56px] w-[56px] items-center justify-center rounded-full"
        style={{ background: look.orb, boxShadow: look.ring }}
      >
        <img
          src={look.logo}
          alt=""
          className="h-[26px] w-[26px]"
          style={{ filter: look.logoFilter }}
        />
      </div>
      <div
        className="absolute left-[74px] top-[86px] flex h-[16px] w-[16px] items-center justify-center rounded-full text-[9px] font-bold text-[#fff] shadow-[0_0_0_2px_var(--canvas)]"
        style={{ background: look.badge }}
      >
        {n}
      </div>
      <div className="absolute left-[127px] top-[88px] text-[8px] tracking-[-1px] text-[var(--muted)]">
        ⋮⋮
      </div>
      <div className="absolute left-0 right-0 top-[158px] text-center">
        <div className="text-[12px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{name}</div>
        <div
          data-testid={`stage-sub-${node.id}`}
          className="mt-[3px] font-machine text-[9.5px] text-[var(--muted)]"
        >
          {stageSub(node, providerName)}
        </div>
      </div>
      <div
        data-testid="status-chip"
        data-state={state}
        className="absolute bottom-[12px] left-[12px] right-[12px] flex items-center gap-[6px] text-[10px] text-[var(--muted)]"
      >
        <span
          aria-hidden
          className="h-[6px] w-[6px] rounded-full"
          style={{ background: status.color }}
        />
        {status.label}
      </div>
      <PortHandles {...props} />
    </div>
  );
}

const upper = (value: string): string => value.replace(/_/g, ' ').toUpperCase();

/** A description excerpt: one paragraph of real text, cut where the card would run long. */
function excerpt(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 120 ? `${flat.slice(0, 119).trimEnd()}…` : flat;
}

/** The document card's mono meta line, `KIND · detail`, from the node's real config. */
function DocMeta({ node, receives }: { node: Node; receives: readonly DataType[] }) {
  switch (node.kind) {
    case 'input': {
      const files = node.config.artifactIds.length;
      if (files === 0) return <>INPUT · {node.config.outputTypes.map(upper).join(' · ')}</>;
      return (
        <>
          INPUT ·{' '}
          <span data-testid={`input-attachment-count-${node.id}`}>
            {files} {files === 1 ? 'FILE' : 'FILES'}
          </span>
        </>
      );
    }
    case 'output':
      return <>{['OUTPUT', ...receives.map(upper)].join(' · ')}</>;
    case 'merge':
      return <>MERGE · {upper(node.config.mode)}</>;
    case 'transform':
      return <>TRANSFORM · {upper(node.config.op)}</>;
    case 'retrieval':
      return (
        <span data-testid={`retrieval-summary-${node.id}`}>
          RETRIEVAL · <span data-testid={`retrieval-k-${node.id}`}>K {node.config.k}</span> ·{' '}
          <span data-testid={`retrieval-mode-${node.id}`}>
            {upper(node.config.mode ?? DEFAULT_SEARCH_MODE)}
          </span>
        </span>
      );
    default:
      return <>{upper(node.kind)}</>;
  }
}

/** The document card's description: a real excerpt of what the node holds, or nothing. */
function docDescription(node: Node, knowledgeBaseName: string | undefined): ReactNode {
  switch (node.kind) {
    case 'input':
      return excerpt(node.config.text);
    case 'transform':
      if (node.config.op === 'template') return excerpt(node.config.template);
      if (node.config.op === 'extract_json_field') return excerpt(node.config.path);
      return undefined;
    case 'retrieval':
      return (
        <span data-testid={`retrieval-kb-${node.id}`}>
          {node.config.knowledgeBaseId === undefined
            ? 'no knowledge base'
            : (knowledgeBaseName ?? 'knowledge base')}
        </span>
      );
    default:
      return undefined;
  }
}

/**
 * The theme's Document card (D332) for every kind that is not a stage: the name, `KIND · detail`,
 * an excerpt of what it holds, and "Attached to Stage n" when its output feeds a stage.
 */
function DocCard(props: NodeCardViewProps) {
  const { node, state, selected, feeds = [], receives = [], knowledgeBaseName } = props;
  const description = docDescription(node, knowledgeBaseName);
  const attached =
    feeds.length === 0
      ? undefined
      : feeds.length === 1
        ? `Attached to Stage ${feeds[0]}`
        : `Attached to Stages ${feeds.join(', ')}`;
  return (
    <div
      data-node-card
      data-testid={`node-card-${node.id}`}
      data-kind={node.kind}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      className="relative w-[200px] cursor-move rounded-[8px] bg-[var(--surface)] px-[14px] pb-[10px] pt-[14px] text-[var(--ink)] shadow-[0_10px_30px_-14px_rgba(40,25,15,0.35)]"
      style={{ border: `1px solid ${selected ? '#ef6b3f' : 'var(--line)'}` }}
    >
      <NodeCardButtons node={node} className="right-[8px] top-[8px]" />
      <div className="pr-[46px] text-[13px] font-bold leading-[1.25] tracking-[-0.01em]">
        {node.name}
      </div>
      <div
        data-testid={`node-meta-${node.id}`}
        className="mt-[4px] font-machine text-[9px] text-[var(--muted)]"
      >
        <DocMeta node={node} receives={receives} />
      </div>
      {description !== undefined && (
        <div
          data-testid={`node-description-${node.id}`}
          className="mt-[10px] text-[10px] leading-[1.45] text-[var(--muted)] [text-wrap:pretty]"
        >
          {description}
        </div>
      )}
      {attached !== undefined && (
        <>
          <div className="mb-[8px] mt-[10px] h-px bg-[var(--line)]" />
          <div
            data-testid={`node-attached-${node.id}`}
            className="text-center text-[9.5px] font-semibold"
          >
            {attached}
          </div>
        </>
      )}
      <PortHandles {...props} />
    </div>
  );
}

/**
 * The node card (FR-NODE-005/006/010/012): a Stage card for Agent and Model, a Document card for
 * every other kind (D332). Pure view: everything it shows comes from the contract node and the
 * props, so it renders the same inside React Flow and in a component test.
 */
export function NodeCardView(props: NodeCardViewProps) {
  return isStageKind(props.node.kind) ? <StageCard {...props} /> : <DocCard {...props} />;
}

/** Each failure reason in the words a person reads; the enum value stays the contract's (BR-03). */
const FAILURE_TEXT: Readonly<Record<FailureReason, string>> = {
  RUN_FAILED: 'failed',
  CONTRACT_VIOLATION: 'output did not match the contract',
  GUARDRAIL_VIOLATION: 'blocked by a guardrail',
  BLOCKED: 'never ran',
};

export interface NodeCardNotesProps {
  node: Node;
  state: NodeState;
  /** What the router actually used, so a fallback is visible (FR-RTR-006). */
  modelUsed?: ModelUsed;
  /** The node names a provider the engine no longer has (FR-PRV-005). */
  providerMissing?: boolean;
  /** Why the node failed, so it says which kind of failure it was (FR-ERR-002, BR-03). */
  failureReason?: FailureReason;
  /** The upstream node that stopped the run, on a BLOCKED node (FR-ERR-006). */
  blockedByName?: string;
}

const NOTE = 'text-[10px] leading-[1.45] text-[var(--muted)]';

/**
 * What the card has no room for (D332), as small muted lines under it: why it failed, what blocked
 * it, a missing provider, the model that actually answered when it was not the configured one,
 * and where a running node's answer is read (D285: the chat, never the card).
 */
export function NodeCardNotes({
  node,
  state,
  modelUsed,
  providerMissing,
  failureReason,
  blockedByName,
}: NodeCardNotesProps) {
  const configuredModel =
    node.kind === 'agent' || node.kind === 'model' ? node.config.modelId : undefined;
  const showUsed =
    modelUsed !== undefined && (modelUsed.viaFallback || modelUsed.modelId !== configuredModel);
  const lines: ReactNode[] = [];
  if (state === 'RUNNING' && isStageKind(node.kind)) {
    lines.push(
      <p key="running" className={NOTE} data-testid={`running-note-${node.id}`}>
        running — answer in Chat
      </p>,
    );
  }
  if (state === 'BLOCKED') {
    lines.push(
      <p key="blocked" className={NOTE} data-testid={`blocked-by-${node.id}`}>
        {blockedByName === undefined ? 'blocked upstream' : `blocked by ${blockedByName}`}
      </p>,
    );
  }
  if (state === 'FAILED' && failureReason !== undefined) {
    lines.push(
      <p key="failed" className={NOTE}>
        <span data-testid={`failure-${node.id}`} data-reason={failureReason}>
          {FAILURE_TEXT[failureReason]}
        </span>
      </p>,
    );
  }
  if (providerMissing) {
    lines.push(
      <p key="provider" className={NOTE} data-testid={`provider-missing-${node.id}`}>
        provider missing
      </p>,
    );
  }
  if (showUsed) {
    lines.push(
      <p key="used" className={`${NOTE} truncate`} data-testid={`used-model-${node.id}`}>
        used: {modelUsed.modelId}
        {modelUsed.viaFallback ? ' (fallback)' : ''}
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return (
    <div data-testid={`node-notes-${node.id}`} className="flex flex-col px-[2px]">
      {lines}
    </div>
  );
}

/**
 * React Flow takes a node's handle positions from its first measure, and a node array that reaches
 * it without `measured` just after that measure (the Canvas's selection merge, a refetch) wipes
 * them. It measures again only when the card's size changes, so until then it draws none of the
 * node's edges and no connection starts or ends on it. When a measured node has lost them, measure
 * it again.
 */
function useHandlePositionsKept(id: string): void {
  const lost = useStore((state) => {
    const node = state.nodeLookup.get(id);
    return Boolean(
      node &&
      !node.hidden &&
      node.measured.width &&
      node.measured.height &&
      !node.internals.handleBounds,
    );
  });
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (lost) updateNodeInternals(id);
  }, [lost, id, updateNodeInternals]);
}

/**
 * The React Flow wrapper: memoised so a pan or an unrelated edit never re-renders it (NFR-PERF-01).
 * The live overlay is read here rather than passed through `data`, so one node's token does not
 * rebuild the whole node array (NFR-PERF-04). What hangs under the card — the notes, the failure,
 * the approval and the pre-flight issues — sits in one column below it, the card's width.
 */
export const FlowNodeCard = memo(function FlowNodeCard({
  id,
  data,
  selected,
}: NodeProps<AceFlowNode>) {
  useHandlePositionsKept(id);
  const node = data.node;
  const overlay = useNodeOverlay(node.id);
  const blockedByName = useBlockedByName(node, overlay.state === 'BLOCKED');
  const projectId = useWorkflowProjectId(node.workflowId);
  const knowledgeBaseName = useKnowledgeBaseName(
    projectId,
    node.kind === 'retrieval' ? node.config.knowledgeBaseId : undefined,
  );
  const dark = useContext(CanvasDarkContext);
  const card = (
    <NodeCardView
      node={node}
      state={overlay.state}
      selected={Boolean(selected)}
      connectedPortIds={data.connectedPortIds}
      armedPortId={data.armedPortId}
      onPortKey={(port, direction) => data.onPortKey(port, direction, node.id)}
      dark={dark}
      {...(data.provider === undefined ? {} : { provider: data.provider })}
      {...(data.providerName === undefined ? {} : { providerName: data.providerName })}
      {...(data.stage === undefined ? {} : { stage: data.stage })}
      {...(data.feeds === undefined ? {} : { feeds: data.feeds })}
      {...(data.receives === undefined ? {} : { receives: data.receives })}
      {...(knowledgeBaseName === undefined ? {} : { knowledgeBaseName })}
    />
  );
  const width = isStageKind(node.kind) ? STAGE_W : DOC_W;
  return (
    <div className="relative" style={{ width }}>
      {/* An Input node's card is itself a file drop target (FR-MM-007); other kinds render as-is. */}
      {node.kind === 'input' ? (
        <InputDropZone nodeId={node.id} workflowId={node.workflowId} config={node.config}>
          {card}
        </InputDropZone>
      ) : (
        card
      )}
      <UnderCard width={width}>
        <NodeCardNotes
          node={node}
          state={overlay.state}
          {...(overlay.modelUsed === undefined ? {} : { modelUsed: overlay.modelUsed })}
          {...(overlay.failureReason === undefined ? {} : { failureReason: overlay.failureReason })}
          {...(blockedByName === undefined ? {} : { blockedByName })}
          {...(data.providerMissing ? { providerMissing: true } : {})}
        />
        <NodeErrorCard node={node} />
        <NodeApproval node={node} />
        <NodePreflightIssues node={node} />
      </UnderCard>
    </div>
  );
});

export const nodeTypes = { ace: FlowNodeCard };

/**
 * The name of the node whose failure blocked this one (FR-ERR-006, TC-ERR-007).
 *
 * The engine reports the state, not the cause, so it is resolved from the graph — and only for a card
 * that is actually BLOCKED: every other card returns before any of it is computed, which is what
 * keeps a 200-node Canvas from walking the graph once per node per frame (NFR-PERF-01). The graph
 * comes from the cache this Canvas already filled, so there is no extra request.
 */
function useBlockedByName(node: Node, blocked: boolean): string | undefined {
  const graph = useWorkflowGraph(node.workflowId);
  return useRunStore((store) => {
    void store.revision;
    if (!blocked || graph.data === undefined) return undefined;
    const stoppers = new Set(
      store
        .nodeRuns()
        .filter((run) => run.status === 'FAILED' || run.status === 'STOPPED')
        .map((run) => run.nodeId),
    );
    if (stoppers.size === 0) return undefined;
    const blockedBy = findBlockingNodeId(node.id, graph.data.edges, stoppers);
    return graph.data.nodes.find((each) => each.id === blockedBy)?.name;
  });
}
