import type {
  FailureReason,
  ModelUsed,
  Node,
  NodeState,
  Part,
  Port,
  ProviderType,
} from '@ace/contracts';
import { Badge, StatusChip, StreamingText, cn } from '@ace/ui';
import { Handle, Position, type NodeProps, type Node as FlowNode } from '@xyflow/react';
import {
  BookOpen,
  Bot,
  Cpu,
  Flag,
  GitMerge,
  Lock,
  TextCursorInput,
  Trash2,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { memo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { InputDropZone } from '../artifacts/InputDropZone';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useCanvasApi } from '../canvas/canvas-api';
import { findBlockingNodeId } from '../errors/blocked';
import { NodeApproval, NodeErrorCard, NodeRunActions } from '../runs/NodeRunAttachments';
import { useNodeOverlay, useRunStore } from '../runs/run-store';
import { useWorkflowGraph } from '../workflows/hooks';
import { DEFAULT_SEARCH_MODE } from '@ace/contracts';

import type { CanvasNodeKind } from './factory';
import { NodePreflightIssues } from './NodePreflightIssues';
import { useKnowledgeBaseName, useWorkflowProjectId } from './retrieval/hooks';

export const KIND_ICON: Record<CanvasNodeKind, LucideIcon> = {
  input: TextCursorInput,
  agent: Bot,
  model: Cpu,
  output: Flag,
  merge: GitMerge,
  transform: Wand2,
  retrieval: BookOpen,
};

/** React Flow node payload: the contract node plus what the Canvas knows about it. */
export type FlowNodeData = {
  node: Node;
  connectedPortIds: Set<string>;
  /** The node's provider type, for the accent border (FR-NODE-010). */
  provider?: ProviderType;
  /** Set when the node's provider is gone (FR-PRV-005). */
  providerMissing?: boolean;
  /** Keyboard connect (NFR-USE-02): the output port armed with Enter, if any. */
  armedPortId: string | undefined;
  onPortKey: (port: Port, direction: 'in' | 'out', nodeId: string) => void;
};
export type AceFlowNode = FlowNode<FlowNodeData, 'ace'>;

export interface NodeCardViewProps {
  node: Node;
  /** Drives the glow and the status chip; from the run overlay's `node.state` frames (FR-EXE-009). */
  state: NodeState;
  selected: boolean;
  connectedPortIds: Set<string>;
  /** Provider accent, fixed per provider type and never moved by state (FR-NODE-010). */
  provider?: ProviderType;
  armedPortId?: string;
  onPortKey?: (port: Port, direction: 'in' | 'out') => void;
  /** The node's run actions, when a run has reached it — a slot so this view stays pure. */
  actions?: ReactNode;
  /** The selected-node toolbar, drawn above the card — a slot for the same reason. */
  toolbar?: ReactNode;
  /**
   * Static port dots instead of React Flow handles, for a card drawn outside a flow (the New node
   * dialog's preview): nothing to connect to, and no React Flow store to register with.
   */
  preview?: boolean;
  /** Text streamed by this node's current run, as it arrives (FR-EXE-008). */
  streamedText?: string;
  /** What the router actually used, so a fallback is visible on the card (FR-RTR-006). */
  modelUsed?: ModelUsed;
  /** The run's final output for this node — Output nodes render it (FR-NODE-012). */
  finalOutput?: Part[];
  /** The node names a provider the engine no longer has (FR-PRV-005). */
  providerMissing?: boolean;
  /** Why the node failed, so the card says which kind of failure it was (FR-ERR-002, BR-03). */
  failureReason?: FailureReason;
  /** The upstream node that stopped the run, on a BLOCKED card (FR-ERR-006). */
  blockedByName?: string;
  /** A Retrieval node's base, by name, once the project's bases have loaded (FR-RAG-006). */
  knowledgeBaseName?: string;
}

/** Each failure reason in the words a person reads; the enum value stays the contract's (BR-03). */
const FAILURE_TEXT: Readonly<Record<FailureReason, string>> = {
  RUN_FAILED: 'failed',
  CONTRACT_VIOLATION: 'output did not match the contract',
  GUARDRAIL_VIOLATION: 'blocked by a guardrail',
  BLOCKED: 'never ran',
};

/** Enough of a `Part` to show on a card; the inspector renders the typed view (round 4 adds more). */
function partText(part: Part): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'json') return JSON.stringify(part.value);
  if (part.type === 'code') return part.text;
  return `[${part.type}]`;
}

const isModelKind = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

/** What the chip under the name says (FR-NODE-005): the model, or the one setting that matters. */
function chipLabel(node: Node, knowledgeBaseName: string | undefined): string {
  switch (node.kind) {
    case 'agent':
    case 'model':
      return node.config.modelId ?? 'no model';
    case 'input': {
      const files = node.config.artifactIds.length;
      return files === 0 ? 'text' : `text · ${files} ${files === 1 ? 'file' : 'files'}`;
    }
    case 'merge':
      return `mode · ${node.config.mode}`;
    case 'transform':
      return node.config.op;
    case 'output':
      return 'final result';
    case 'retrieval':
      return node.config.knowledgeBaseId === undefined
        ? 'no knowledge base'
        : (knowledgeBaseName ?? 'knowledge base');
    default:
      return node.kind;
  }
}

/** The body text before anything has run: what will appear here, in the node's own terms. */
function placeholder(node: Node): string | undefined {
  if (isModelKind(node)) return 'streamed output appears here';
  if (node.kind === 'merge') {
    return node.config.mode === 'any' ? 'waits for the first input' : 'waits for every input';
  }
  if (node.kind === 'transform') return 'same result every time — no model';
  return undefined;
}

const ITALIC = 'font-human text-[13px] italic text-fg-muted';
const MONO = 'font-machine text-[10.5px] text-fg-soft';

/** The port dot, connected (filled with the accent) or open; a card-coloured halo lifts it off the edge. */
const portDotStyle = (connected: boolean): CSSProperties => ({
  borderColor: connected ? 'var(--accent-color)' : 'var(--color-fg-muted)',
  backgroundColor: connected ? 'var(--accent-color)' : 'var(--color-card)',
  boxShadow: '0 0 0 3px var(--color-card)',
});

function PortRow({
  port,
  direction,
  connected,
  armed,
  preview,
  onKey,
}: {
  port: Port;
  direction: 'in' | 'out';
  connected: boolean;
  armed: boolean;
  preview: boolean;
  onKey?: (port: Port, direction: 'in' | 'out') => void;
}) {
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
  const side = direction === 'in' ? '-left-5' : '-right-5';
  const dot = preview ? (
    <span
      aria-hidden
      data-testid={`port-dot-${port.id}`}
      className={cn('absolute top-[5px] h-3 w-3 rounded-full border-2', side)}
      style={portDotStyle(connected)}
    />
  ) : (
    <Handle
      id={port.id}
      type={direction === 'in' ? 'target' : 'source'}
      position={direction === 'in' ? Position.Left : Position.Right}
      className={cn(
        '!absolute !top-[5px] !h-3 !w-3 !transform-none !rounded-full !border-2 !transition-colors',
        direction === 'in' ? '!-left-5' : '!-right-5',
        armed && '!ring-2 !ring-accent',
        'focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-accent',
      )}
      style={portDotStyle(connected)}
      tabIndex={0}
      role="button"
      aria-label={label}
      title={label}
      data-testid={`port-${port.id}`}
      data-connected={connected ? 'true' : 'false'}
      data-datatype={port.dataType}
      onKeyDown={onKeyDown}
    />
  );
  // Type-derived ports are named after their type (D18), so the type is only spelled out when it
  // says something the name does not.
  const type =
    port.name === port.dataType ? null : <span className="text-fg-faint">{port.dataType}</span>;
  return (
    <div
      data-port-row
      className="relative flex h-[22px] items-center gap-1.5 font-machine text-[10px] text-fg-muted"
    >
      {direction === 'in' ? (
        <>
          {dot}
          {port.name}
          {type}
        </>
      ) : (
        <>
          {type}
          {port.name}
          {dot}
        </>
      )}
    </div>
  );
}

/**
 * What the card's body box says. First match wins: a state that needs explaining (stopped, blocked,
 * failed, waiting) beats the node's own content, and the content beats the placeholder.
 */
function CardBody({
  node,
  state,
  streamedText,
  finalOutput,
  failureReason,
  blockedByName,
}: Pick<
  NodeCardViewProps,
  'node' | 'state' | 'streamedText' | 'finalOutput' | 'failureReason' | 'blockedByName'
>) {
  /*
   * BLOCKED is greyed and locked because nothing went wrong here — the run never reached this node
   * (FR-ERR-006). STOPPED gets no fault styling at all: a cancellation the operator asked for must
   * not read as a fault (FR-ERR-007), so only FAILED is ever tinted with the danger colour.
   */
  if (state === 'STOPPED') {
    return (
      <p className={ITALIC} data-testid={`stopped-note-card-${node.id}`}>
        stopped — not a failure
      </p>
    );
  }
  if (state === 'BLOCKED') {
    return (
      <p className={ITALIC} data-testid={`blocked-by-${node.id}`}>
        {blockedByName === undefined ? 'blocked upstream' : `blocked by ${blockedByName}`}
      </p>
    );
  }
  if (state === 'FAILED' && failureReason !== undefined) {
    return (
      <p className="font-machine text-[10.5px] text-danger">
        <span aria-hidden>⚠ </span>
        <span data-testid={`failure-${node.id}`} data-reason={failureReason}>
          {FAILURE_TEXT[failureReason]}
        </span>
      </p>
    );
  }
  if (state === 'WAITING') return <p className={ITALIC}>waiting on your approval…</p>;
  if (streamedText) {
    return (
      <StreamingText
        text={streamedText}
        nodeRunId={node.id}
        // `!` beats StreamingText's inline max-height, so the text fills the box and no more.
        className={cn('!max-h-full leading-normal', MONO)}
      />
    );
  }
  if (node.kind === 'output') {
    return finalOutput === undefined ? (
      <p className={ITALIC}>final result appears here after a run</p>
    ) : (
      <p
        className={cn('line-clamp-3 whitespace-pre-wrap break-words', MONO)}
        data-testid={`final-output-${node.id}`}
      >
        {finalOutput.map((part) => partText(part)).join('\n')}
      </p>
    );
  }
  if (node.kind === 'input') {
    return node.config.text ? (
      <p className={cn('line-clamp-3 break-words', MONO)}>{node.config.text}</p>
    ) : null;
  }
  if (node.kind === 'retrieval') {
    return (
      <p className={MONO} data-testid={`retrieval-summary-${node.id}`}>
        <span data-testid={`retrieval-k-${node.id}`}>k {node.config.k}</span>
        {' · '}
        <span data-testid={`retrieval-mode-${node.id}`}>
          {node.config.mode ?? DEFAULT_SEARCH_MODE}
        </span>
      </p>
    );
  }
  const idle = placeholder(node);
  return idle === undefined ? null : <p className={ITALIC}>{idle}</p>;
}

/**
 * The node card (FR-NODE-005/006/010/012). Pure view: everything it shows comes from the contract
 * node and the props, so it renders the same inside React Flow and in a component test.
 *
 * The look lives in `.ace-node` (theme.css): `--accent-color` tints the fill, border and glow, and
 * `data-state` sets how brightly it glows (BLOCKED greys itself). The accent is the provider's CSS
 * variable, never a hex value, so the Paper theme recolours it.
 */
export function NodeCardView({
  node,
  state,
  selected,
  connectedPortIds,
  provider,
  armedPortId,
  onPortKey,
  streamedText,
  modelUsed,
  finalOutput,
  providerMissing,
  failureReason,
  blockedByName,
  knowledgeBaseName,
  actions,
  toolbar,
  preview = false,
}: NodeCardViewProps) {
  const Icon = KIND_ICON[node.kind as CanvasNodeKind] ?? Bot;
  const isBlocked = state === 'BLOCKED';
  const style =
    provider === undefined
      ? undefined
      : ({ '--accent-color': `var(--color-provider-${provider})` } as CSSProperties);
  const tileStyle: CSSProperties = {
    borderColor: 'color-mix(in oklab, var(--accent-color) 40%, var(--color-border))',
    backgroundColor: 'color-mix(in oklab, var(--accent-color) 14%, transparent)',
    ...(provider === undefined ? {} : { color: 'var(--accent-color)' }),
  };
  const isRetrieval = node.kind === 'retrieval';
  const knowledgeBaseId = node.kind === 'retrieval' ? node.config.knowledgeBaseId : undefined;
  const noBase = isRetrieval && knowledgeBaseId === undefined;

  return (
    <div
      data-testid={`node-card-${node.id}`}
      data-kind={node.kind}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      style={style}
      className="ace-node relative w-[220px] select-none px-3.5 py-3 text-fg"
    >
      {toolbar}
      <header className="flex h-[30px] items-center gap-[9px]">
        <span
          className={cn(
            'grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] border',
            provider === undefined && 'text-fg-soft',
          )}
          style={tileStyle}
        >
          {isBlocked ? (
            <Lock
              className="h-[15px] w-[15px]"
              strokeWidth={1.8}
              aria-label="blocked"
              data-testid={`blocked-lock-${node.id}`}
            />
          ) : (
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.8} aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-human text-[16.5px] font-semibold leading-[1.1]">
          {node.name}
        </span>
        <span className="font-machine text-[9px] uppercase tracking-[0.14em] text-fg-faint">
          {node.kind}
        </span>
        {actions}
      </header>
      <div className="mt-1.5 flex h-[22px] items-center justify-between gap-1.5">
        <Badge
          data-testid={`node-chip-${node.id}`}
          className={cn(
            'min-w-0 max-w-[128px] overflow-hidden whitespace-nowrap',
            noBase && 'border-dashed',
          )}
        >
          {isModelKind(node) && provider !== undefined && (
            <span
              aria-hidden
              data-provider-dot
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: 'var(--accent-color)' }}
            />
          )}
          <span
            className="truncate"
            {...(isRetrieval ? { 'data-testid': `retrieval-kb-${node.id}` } : {})}
            {...(knowledgeBaseId === undefined ? {} : { title: knowledgeBaseId })}
          >
            {chipLabel(node, knowledgeBaseName)}
          </span>
        </Badge>
        <StatusChip state={state} className="shrink-0" />
      </div>
      {providerMissing && (
        <p
          data-testid={`provider-missing-${node.id}`}
          className="mt-1.5 font-machine text-[10px] text-danger"
          title="This node's provider was removed; choose another before running."
        >
          provider missing
        </p>
      )}
      {/* FR-RTR-006: what actually answered, and whether the router had to fall back. */}
      {modelUsed && (
        <p
          className="mt-1.5 truncate font-machine text-[10px] text-fg-muted"
          data-testid={`used-model-${node.id}`}
        >
          used: {modelUsed.modelId}
          {modelUsed.viaFallback ? ' (fallback)' : ''}
        </p>
      )}
      <div
        data-testid={`node-body-${node.id}`}
        className="mt-2 h-16 overflow-hidden rounded-[9px] border border-border bg-sunken px-2.5 py-2 leading-normal"
      >
        <CardBody
          node={node}
          state={state}
          {...(streamedText === undefined ? {} : { streamedText })}
          {...(finalOutput === undefined ? {} : { finalOutput })}
          {...(failureReason === undefined ? {} : { failureReason })}
          {...(blockedByName === undefined ? {} : { blockedByName })}
        />
      </div>
      <div className="mt-2 flex justify-between">
        <div className="flex flex-col">
          {node.inputs.map((port) => (
            <PortRow
              key={port.id}
              port={port}
              direction="in"
              connected={connectedPortIds.has(port.id)}
              armed={armedPortId === port.id}
              preview={preview}
              {...(onPortKey === undefined ? {} : { onKey: onPortKey })}
            />
          ))}
        </div>
        <div className="flex flex-col items-end">
          {node.outputs.map((port) => (
            <PortRow
              key={port.id}
              port={port}
              direction="out"
              connected={connectedPortIds.has(port.id)}
              armed={armedPortId === port.id}
              preview={preview}
              {...(onPortKey === undefined ? {} : { onKey: onPortKey })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const TOOL =
  'h-[26px] rounded-chip px-3 font-machine text-[10.5px] transition-colors hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection';

/**
 * The selected node's toolbar (FR-CAN-003): Edit and Inspect open the sheet on that tab, `@ Chat`
 * points the Chat column at the node (Agent/Model only, FR-CHAT-004), the trash deletes it.
 *
 * Mounted only on the selected card, so only that card subscribes to the selection count — a
 * boolean, so it re-renders when the selection goes from one node to several and not otherwise
 * (NFR-PERF-01). The actions read their stores at click time and subscribe to nothing.
 */
function NodeToolbar({ node }: { node: Node }) {
  const single = useSelectionStore((s) => s.nodeIds.length === 1);
  const readOnly = useCanvasApi((s) => s.api?.readOnly === true);
  if (!single || readOnly) return null;
  return (
    <div
      data-testid={`node-toolbar-${node.id}`}
      // `nodrag nopan`: a press here is a click, never the start of a node drag or a pan.
      className="nodrag nopan absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-chip border border-border-strong bg-panel p-[3px] shadow-[var(--ace-ground)]"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        data-testid="node-toolbar-edit"
        className={cn(TOOL, 'text-fg')}
        onClick={() => usePanelsStore.getState().openSheet('configure')}
      >
        Edit
      </button>
      <button
        type="button"
        data-testid="node-toolbar-inspect"
        className={cn(TOOL, 'text-fg-soft hover:text-fg')}
        onClick={() => usePanelsStore.getState().openSheet('inspect')}
      >
        Inspect
      </button>
      {isModelKind(node) && (
        <button
          type="button"
          data-testid="node-toolbar-chat"
          className={cn(TOOL, 'text-fg-soft hover:text-fg')}
          onClick={() => usePanelsStore.getState().chatWith(node.id)}
        >
          @ Chat
        </button>
      )}
      <span aria-hidden className="h-3.5 w-px bg-border" />
      <button
        type="button"
        data-testid="node-toolbar-delete"
        aria-label="Delete node"
        title="Delete node"
        className="grid h-[26px] w-[26px] place-items-center rounded-chip text-fg-muted transition-colors hover:bg-border hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
        onClick={() => useCanvasApi.getState().api?.deleteNodes([node.id])}
      >
        <Trash2 className="h-[13px] w-[13px]" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The React Flow wrapper: memoised so a pan or an unrelated edit never re-renders it (NFR-PERF-01).
 * The live overlay is read here rather than passed through `data`, so one node's token does not
 * rebuild the whole node array (NFR-PERF-04).
 */
export const FlowNodeCard = memo(function FlowNodeCard({
  data,
  selected,
  dragging,
}: NodeProps<AceFlowNode>) {
  const node = data.node;
  const overlay = useNodeOverlay(node.id);
  const blockedByName = useBlockedByName(node, overlay.state === 'BLOCKED');
  const projectId = useWorkflowProjectId(node.workflowId);
  const knowledgeBaseName = useKnowledgeBaseName(
    projectId,
    node.kind === 'retrieval' ? node.config.knowledgeBaseId : undefined,
  );
  const card = (
    <NodeCardView
      node={node}
      state={overlay.state}
      selected={Boolean(selected)}
      connectedPortIds={data.connectedPortIds}
      armedPortId={data.armedPortId}
      onPortKey={(port, direction) => data.onPortKey(port, direction, node.id)}
      streamedText={overlay.streamedText}
      actions={<NodeRunActions node={node} />}
      {...(selected && !dragging ? { toolbar: <NodeToolbar node={node} /> } : {})}
      {...(overlay.modelUsed === undefined ? {} : { modelUsed: overlay.modelUsed })}
      {...(overlay.finalOutput === undefined ? {} : { finalOutput: overlay.finalOutput })}
      {...(overlay.failureReason === undefined ? {} : { failureReason: overlay.failureReason })}
      {...(blockedByName === undefined ? {} : { blockedByName })}
      {...(knowledgeBaseName === undefined ? {} : { knowledgeBaseName })}
      {...(data.providerMissing ? { providerMissing: true } : {})}
      {...(data.provider === undefined ? {} : { provider: data.provider })}
    />
  );
  return (
    <div className="flex flex-col items-start">
      {/* An Input node's card is itself a file drop target (FR-MM-007); other kinds render as-is. */}
      {node.kind === 'input' ? (
        <InputDropZone nodeId={node.id} workflowId={node.workflowId} config={node.config}>
          {card}
        </InputDropZone>
      ) : (
        card
      )}
      {/* Anchored to the node, because each is about this node and nothing else (§5 items 3, 4). */}
      <NodeErrorCard node={node} />
      <NodeApproval node={node} />
      <NodePreflightIssues node={node} />
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
