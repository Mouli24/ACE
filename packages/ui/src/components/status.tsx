import type { NodeState, ProviderState } from '@ace/contracts';
import {
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleStop,
  CircleX,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { PROVIDER_STATUS } from '../tokens.js';

/** The state colour as a CSS variable, so the Paper theme recolours it (tokens.ts keeps the hex). */
const statusVar = (state: NodeState): string => `var(--color-status-${state})`;

/**
 * One label, one icon and one colour per `NodeState` (FR-EXE-009, TC-EXE-008). Nine states, nine
 * of each: the ring colour alone would fail a colour-blind reader, so the icon and the word carry
 * the same information. The provider accent is a separate token and never moves with state
 * (FR-NODE-010).
 */
export interface NodeStateMeta {
  label: string;
  Icon: LucideIcon;
  color: string;
  /** RUNNING is the only state that animates, so a static screenshot stays readable. */
  spin?: boolean;
}

export const NODE_STATE_META: Readonly<Record<NodeState, NodeStateMeta>> = {
  IDLE: { label: 'idle', Icon: Circle, color: statusVar('IDLE') },
  READY: { label: 'ready', Icon: CircleDot, color: statusVar('READY') },
  RUNNING: { label: 'running', Icon: LoaderCircle, color: statusVar('RUNNING'), spin: true },
  WAITING: { label: 'waiting', Icon: Hourglass, color: statusVar('WAITING') },
  COMPLETED: { label: 'completed', Icon: CircleCheck, color: statusVar('COMPLETED') },
  PAUSED: { label: 'paused', Icon: CirclePause, color: statusVar('PAUSED') },
  STOPPED: { label: 'stopped', Icon: CircleStop, color: statusVar('STOPPED') },
  BLOCKED: { label: 'blocked', Icon: CircleSlash, color: statusVar('BLOCKED') },
  FAILED: { label: 'failed', Icon: CircleX, color: statusVar('FAILED') },
};

export interface StatusRingProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: NodeState;
  /** Print the state name next to the icon (used in the inspector and the run list). */
  showLabel?: boolean;
}

/** The node state indicator: icon in the state colour, with the state name for screen readers. */
export function StatusRing({ state, showLabel, className, ...props }: StatusRingProps) {
  const meta = NODE_STATE_META[state];
  return (
    <span
      data-testid="status-ring"
      data-state={state}
      aria-label={meta.label}
      role="img"
      title={meta.label}
      className={cn('inline-flex items-center gap-1 font-machine text-[11px]', className)}
      style={{ color: meta.color }}
      {...props}
    >
      <meta.Icon className={cn('h-3.5 w-3.5 shrink-0', meta.spin && 'ace-spin')} aria-hidden />
      {showLabel && <span aria-hidden>{meta.label}</span>}
    </span>
  );
}

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: NodeState;
}

/**
 * The design's status treatment: a spinner (RUNNING), a pulsing dot (WAITING), a hollow dot (IDLE)
 * or a filled dot, then the lowercase state word, all in the state colour (FR-EXE-009). The word
 * is printed, so colour alone never carries the state.
 */
export function StatusChip({ state, className, style, ...props }: StatusChipProps) {
  const meta = NODE_STATE_META[state];
  const dot = 'h-[7px] w-[7px] shrink-0 rounded-full';
  return (
    <span
      data-testid="status-chip"
      data-state={state}
      aria-label={meta.label}
      role="img"
      className={cn('inline-flex items-center gap-1.5 font-machine text-[10.5px]', className)}
      style={{ ...style, color: meta.color }}
      {...props}
    >
      {state === 'RUNNING' ? (
        <LoaderCircle className="ace-spin h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <span
          aria-hidden
          className={cn(
            dot,
            state === 'WAITING' && 'ace-pulse',
            state === 'IDLE' ? 'border border-current' : 'bg-current',
          )}
        />
      )}
      <span aria-hidden>{meta.label}</span>
    </span>
  );
}

/** Human wording for the six provider states (Arch §19.3); the enum name stays the contract. */
export const PROVIDER_STATE_LABEL: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  CONNECTED: 'connected',
  AUTH_FAILED: 'auth failed',
  UNREACHABLE: 'unreachable',
  RATE_LIMITED: 'rate limited',
};

export interface ProviderStatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  name: string;
  status: ProviderState;
  message?: string;
  lastCheckedAt?: string;
}

/**
 * A provider's reachability, for the top bar and the providers screen (FR-PRV-004). It shows the
 * name, a coloured dot and the state — never a key, which the API does not even return (FR-PRV-002).
 */
export function ProviderStatusChip({
  name,
  status,
  message,
  lastCheckedAt,
  className,
  ...props
}: ProviderStatusChipProps) {
  const title = [
    `${name}: ${PROVIDER_STATE_LABEL[status]}`,
    message,
    lastCheckedAt && `checked ${lastCheckedAt}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      data-testid={`provider-chip-${name}`}
      data-status={status}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip border border-border bg-canvas px-2 py-0.5',
        'font-machine text-[11px] leading-4 text-fg-muted',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn('h-2 w-2 shrink-0 rounded-full', status === 'CHECKING' && 'animate-pulse')}
        style={{ backgroundColor: PROVIDER_STATUS[status] }}
      />
      <span className="max-w-[10rem] truncate">{name}</span>
      <span>{PROVIDER_STATE_LABEL[status]}</span>
    </span>
  );
}
