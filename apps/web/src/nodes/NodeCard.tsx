import type { Node, NodeState, Port, ProviderType } from '@ace/contracts';
import { Badge, PROVIDER_ACCENT, STATUS_RING, cn, tokens } from '@ace/ui';
import { Handle, Position, type NodeProps, type Node as FlowNode } from '@xyflow/react';
import { Bot, Cpu, Flag, GitMerge, TextCursorInput, Wand2, type LucideIcon } from 'lucide-react';
import { memo, type CSSProperties, type KeyboardEvent } from 'react';

import type { Round1NodeKind } from './factory';

export const KIND_ICON: Record<Round1NodeKind, LucideIcon> = {
  input: TextCursorInput,
  agent: Bot,
  model: Cpu,
  output: Flag,
  merge: GitMerge,
  transform: Wand2,
};

/** React Flow node payload: the contract node plus what the Canvas knows about it. */
export type FlowNodeData = {
  node: Node;
  connectedPortIds: Set<string>;
  /** Keyboard connect (NFR-USE-02): the output port armed with Enter, if any. */
  armedPortId: string | undefined;
  onPortKey: (port: Port, direction: 'in' | 'out', nodeId: string) => void;
};
export type AceFlowNode = FlowNode<FlowNodeData, 'ace'>;

export interface NodeCardViewProps {
  node: Node;
  /** Status ring (FR-NODE-010). Always IDLE in round 1; the run engine drives it from round 2. */
  state: NodeState;
  selected: boolean;
  connectedPortIds: Set<string>;
  /** Provider accent border; `undefined` until a provider is chosen (round 2). */
  provider?: ProviderType;
  armedPortId?: string;
  onPortKey?: (port: Port, direction: 'in' | 'out') => void;
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
}: NodeCardViewProps) {
  const Icon = KIND_ICON[node.kind as Round1NodeKind] ?? Bot;
  const chip = modelLabel(node);
  const style = {
    '--accent-color': provider ? PROVIDER_ACCENT[provider] : tokens.color.border,
    '--ring-color': STATUS_RING[state],
  } as CSSProperties;

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
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-2">
        <Icon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="truncate font-human text-sm font-semibold">{node.name}</span>
        <span className="ml-auto font-machine text-[10px] uppercase text-fg-muted">
          {node.kind}
        </span>
      </header>
      {chip && (
        <div className="px-3 pt-1">
          <Badge>{chip}</Badge>
        </div>
      )}
      {node.kind === 'output' && (
        <p className="px-3 pt-1 font-human text-xs italic text-fg-muted">
          final result appears here after a run
        </p>
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

/** The React Flow wrapper: memoised so a pan or an unrelated edit never re-renders it (NFR-PERF-01). */
export const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps<AceFlowNode>) {
  return (
    <NodeCardView
      node={data.node}
      state="IDLE"
      selected={Boolean(selected)}
      connectedPortIds={data.connectedPortIds}
      armedPortId={data.armedPortId}
      onPortKey={(port, direction) => data.onPortKey(port, direction, data.node.id)}
    />
  );
});

export const nodeTypes = { ace: FlowNodeCard };
