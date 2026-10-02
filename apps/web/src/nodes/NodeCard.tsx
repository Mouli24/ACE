import type {
  FailureReason,
  ModelUsed,
  Node,
  NodeState,
  Part,
  Port,
  ProviderType,
} from '@ace/contracts';
import {
  Badge,
  PROVIDER_ACCENT,
  STATUS_RING,
  StatusRing,
  StreamingText,
  cn,
  tokens,
} from '@ace/ui';
import { Handle, Position, type NodeProps, type Node as FlowNode } from '@xyflow/react';
import {
  BookOpen,
  Bot,
  Cpu,
  Flag,
  GitMerge,
  Lock,
  TextCursorInput,
  TriangleAlert,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { memo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { InputDropZone } from '../artifacts/InputDropZone';
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
  /** Status ring; driven by the run overlay's `node.state` frames (FR-EXE-009). */
  state: NodeState;
  selected: boolean;
  connectedPortIds: Set<string>;
  /** Provider accent border, fixed per provider type and never moved by state (FR-NODE-010). */
  provider?: ProviderType;
  armedPortId?: string;
  onPortKey?: (port: Port, direction: 'in' | 'out') => void;
  /** The node's run actions, when a run has reached it — a slot so this view stays pure. */
  actions?: ReactNode;
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

function modelLabel(node: Node): string {
  if (node.kind === 'agent' || node.kind === 'model') return node.config.modelId ?? 'no model';
  return '';
}

function PortHandle({
  port,
  direction,
  connected,
  armed,
  onKey,
}: {
  port: Port;
  direction: 'in' | 'out';
  connected: boolean;
  armed: boolean;
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
  return (
    <div className="relative flex h-5 items-center">
      <Handle
        id={port.id}
        type={direction === 'in' ? 'target' : 'source'}
        position={direction === 'in' ? Position.Left : Position.Right}
        className={cn(
          '!h-3 !w-3 !rounded-full !border-2 !border-fg-muted !bg-card !transition-colors',
          connected && '!border-accent !bg-accent',
          armed && '!ring-2 !ring-accent',
          'focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-accent',
        )}
        style={{ position: 'absolute', top: '50%' }}
        tabIndex={0}
        role="button"
        aria-label={label}
        title={label}
        data-testid={`port-${port.id}`}
        data-connected={connected ? 'true' : 'false'}
        data-datatype={port.dataType}
        onKeyDown={onKeyDown}
      />
      <span
        className={cn(
          'font-machine text-[10px] leading-none text-fg-muted',
          direction === 'in' ? 'pl-3' : 'pr-3',
        )}
      >
        {port.name}
      </span>
    </div>
  );
}

/**
 * The node card (FR-NODE-005/006/010/012). Pure view: everything it shows comes from the contract
 * node and the props, so it renders the same inside React Flow and in a component test.
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
}: NodeCardViewProps) {
  const Icon = KIND_ICON[node.kind as CanvasNodeKind] ?? Bot;
  const chip = modelLabel(node);
  const style = {
    '--accent-color': provider ? PROVIDER_ACCENT[provider] : tokens.color.border,
    '--ring-color': STATUS_RING[state],
  } as CSSProperties;

  /*
   * BLOCKED is greyed and locked because nothing went wrong here — the run never reached this node
   * (FR-ERR-006). STOPPED gets no fault styling at all: a cancellation the operator asked for must
   * not read as a fault (FR-ERR-007), so only FAILED is ever tinted with the danger colour.
   */
  const isBlocked = state === 'BLOCKED';

  return (
    <div
      data-testid={`node-card-${node.id}`}
      data-kind={node.kind}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      style={style}
      className={cn(
        'min-w-[180px] rounded-card border border-border bg-card text-fg shadow-md',
        'border-l-4 border-l-[var(--accent-color)]',
        'ring-2 ring-[var(--ring-color)] ring-offset-2 ring-offset-canvas',
        selected && 'outline outline-2 outline-offset-4 outline-selection',
        isBlocked && 'opacity-70 grayscale',
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-2">
        {isBlocked ? (
          <Lock
            className="h-4 w-4 shrink-0 text-fg-muted"
            aria-label="blocked"
            data-testid={`blocked-lock-${node.id}`}
          />
        ) : (
          <Icon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        )}
        <span className="truncate font-human text-sm font-semibold">{node.name}</span>
        <StatusRing state={state} className="ml-auto" />
        <span className="font-machine text-[10px] uppercase text-fg-muted">{node.kind}</span>
        {actions}
      </header>
      {chip && (
        <div className="flex flex-wrap items-center gap-1 px-3 pt-1">
          <Badge>{chip}</Badge>
          {providerMissing && (
            <Badge
              data-testid={`provider-missing-${node.id}`}
              className="border-danger text-danger"
              title="This node's provider was removed; choose another before running."
            >
              provider missing
            </Badge>
          )}
        </div>
      )}
      {isBlocked && (
        <p
          className="px-3 pt-1 font-human text-xs text-fg-muted"
          data-testid={`blocked-by-${node.id}`}
        >
          {blockedByName === undefined ? 'blocked upstream' : `blocked by ${blockedByName}`}
        </p>
      )}
      {state === 'STOPPED' && (
        <p
          className="px-3 pt-1 font-human text-xs text-fg-muted"
          data-testid={`stopped-note-card-${node.id}`}
        >
          stopped — not a failure
        </p>
      )}
      {state === 'FAILED' && failureReason !== undefined && (
        <p
          className="flex items-center gap-1 px-3 pt-1 font-human text-xs text-danger"
          data-testid={`failure-${node.id}`}
          data-reason={failureReason}
        >
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
          {FAILURE_TEXT[failureReason]}
        </p>
      )}
      {/* FR-RTR-006: what actually answered, and whether the router had to fall back. */}
      {modelUsed && (
        <p
          className="px-3 pt-1 font-machine text-[10px] text-fg-muted"
          data-testid={`used-model-${node.id}`}
        >
          used: {modelUsed.modelId}
          {modelUsed.viaFallback ? ' (fallback)' : ''}
        </p>
      )}
      {streamedText && (
        <div className="px-3 pt-1">
          <StreamingText text={streamedText} nodeRunId={node.id} />
        </div>
      )}
      {node.kind === 'output' &&
        (finalOutput === undefined ? (
          <p className="px-3 pt-1 font-human text-xs italic text-fg-muted">
            final result appears here after a run
          </p>
        ) : (
          <p
            className="line-clamp-4 px-3 pt-1 font-human text-xs text-fg"
            data-testid={`final-output-${node.id}`}
          >
            {finalOutput.map((part) => partText(part)).join('\n')}
          </p>
        ))}
      {node.kind === 'retrieval' && (
        <RetrievalSummary
          nodeId={node.id}
          knowledgeBaseId={node.config.knowledgeBaseId}
          knowledgeBaseName={knowledgeBaseName}
          k={node.config.k}
          mode={node.config.mode ?? DEFAULT_SEARCH_MODE}
        />
      )}
      {node.kind === 'input' && node.config.text && (
        <p className="line-clamp-2 px-3 pt-1 font-human text-xs text-fg-muted">
          {node.config.text}
        </p>
      )}
      <div className="flex justify-between gap-4 px-0 py-2">
        <div className="flex flex-col gap-1">
          {node.inputs.map((port) => (
            <PortHandle
              key={port.id}
              port={port}
              direction="in"
              connected={connectedPortIds.has(port.id)}
              armed={armedPortId === port.id}
              onKey={onPortKey}
            />
          ))}
        </div>
        <div className="flex flex-col items-end gap-1">
          {node.outputs.map((port) => (
            <PortHandle
              key={port.id}
              port={port}
              direction="out"
              connected={connectedPortIds.has(port.id)}
              armed={armedPortId === port.id}
              onKey={onPortKey}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The React Flow wrapper: memoised so a pan or an unrelated edit never re-renders it (NFR-PERF-01).
 * The live overlay is read here rather than passed through `data`, so one node's token does not
 * rebuild the whole node array (NFR-PERF-04).
 */
export const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps<AceFlowNode>) {
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
 * What a Retrieval node searches, on its card (FR-RAG-006): the base, how many hits and how. With no
 * base chosen the card says so — the same gap pre-flight reports as `missing_knowledge_base`.
 */
function RetrievalSummary({
  nodeId,
  knowledgeBaseId,
  knowledgeBaseName,
  k,
  mode,
}: {
  nodeId: string;
  knowledgeBaseId: string | undefined;
  knowledgeBaseName: string | undefined;
  k: number;
  mode: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pt-1"
      data-testid={`retrieval-summary-${nodeId}`}
    >
      {knowledgeBaseId === undefined ? (
        <Badge className="border-dashed text-fg-muted" data-testid={`retrieval-kb-${nodeId}`}>
          no knowledge base
        </Badge>
      ) : (
        <Badge data-testid={`retrieval-kb-${nodeId}`} title={knowledgeBaseId}>
          {knowledgeBaseName ?? 'knowledge base'}
        </Badge>
      )}
      <span
        className="font-machine text-[10px] text-fg-muted"
        data-testid={`retrieval-k-${nodeId}`}
      >
        k {k}
      </span>
      <span
        className="font-machine text-[10px] text-fg-muted"
        data-testid={`retrieval-mode-${nodeId}`}
      >
        {mode}
      </span>
    </div>
  );
}

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
