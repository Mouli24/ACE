import type { NodeState, ProviderState } from '@ace/contracts';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/** The state colour as a CSS variable, so light and dark each recolour it (tokens.ts keeps the hex). */
const statusVar = (state: NodeState): string => `var(--color-status-${state})`;

/**
 * The theme's `colour + '1f'` chip fill for a colour held in a CSS variable: `1f` is 12% alpha,
 * which `color-mix` reproduces without knowing the hex (D328).
 */
export const chipFill = (color: string): string => `color-mix(in srgb, ${color} 12%, transparent)`;

/** The theme's pulse for live things — its "Working" pill dot — off under reduced motion. */
export const LIVE_PULSE_CLASS = 'motion-safe:animate-[livePulse_1.4s_ease-in-out_infinite]';

/**
 * One label, one glyph and one colour per `NodeState` (FR-EXE-009, TC-EXE-008). Nine states, nine
 * of each: the colour alone would fail a colour-blind reader, so the glyph and the word carry the
 * same information. Glyphs are text, in the theme's vocabulary (✓ ✕ ▶ ◷ 🔒︎), not icons (D328).
 * The provider accent is a separate token and never moves with state (FR-NODE-010).
 */
export interface NodeStateMeta {
  label: string;
  glyph: string;
  color: string;
  /** RUNNING and WAITING are the states that pulse, so a static screenshot stays readable. */
  live?: boolean;
}

export const NODE_STATE_META: Readonly<Record<NodeState, NodeStateMeta>> = {
  IDLE: { label: 'idle', glyph: '○', color: statusVar('IDLE') },
  READY: { label: 'ready', glyph: '◎', color: statusVar('READY') },
  RUNNING: { label: 'running', glyph: '●', color: statusVar('RUNNING'), live: true },
  WAITING: { label: 'waiting', glyph: '◷', color: statusVar('WAITING'), live: true },
  COMPLETED: { label: 'completed', glyph: '✓', color: statusVar('COMPLETED') },
  PAUSED: { label: 'paused', glyph: '‖', color: statusVar('PAUSED') },
  STOPPED: { label: 'stopped', glyph: '■', color: statusVar('STOPPED') },
  BLOCKED: { label: 'blocked', glyph: '🔒︎', color: statusVar('BLOCKED') },
  FAILED: { label: 'failed', glyph: '✕', color: statusVar('FAILED') },
};

export interface StatusRingProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: NodeState;
  /** Print the state name (used in the inspector and the run list): the theme's mono chip. */
  showLabel?: boolean;
}

/**
 * The node state indicator, with the state name for screen readers. Bare, it is the state's glyph
 * in its colour; with `showLabel` it is the theme's mono chip — the word in the state colour on that
 * colour at 12% (`colour + '1f'`), radius 4.
 */
export function StatusRing({ state, showLabel, className, style, ...props }: StatusRingProps) {
  const meta = NODE_STATE_META[state];
  return (
    <span
      data-testid="status-ring"
      data-state={state}
      aria-label={meta.label}
      role="img"
      title={meta.label}
      className={cn(
        'inline-flex shrink-0 items-center font-machine',
        showLabel
          ? 'gap-1 rounded-[4px] px-[6px] py-[2px] text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]'
          : 'text-[11px] leading-none',
        className,
      )}
      style={{
        ...style,
        color: meta.color,
        ...(showLabel ? { background: chipFill(meta.color) } : {}),
      }}
      {...props}
    >
      {showLabel ? (
        <span aria-hidden>{meta.label}</span>
      ) : (
        <span aria-hidden className={cn(meta.live && LIVE_PULSE_CLASS)}>
          {meta.glyph}
        </span>
      )}
    </span>
  );
}

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: NodeState;
}

/**
 * The theme's status line (a Stage card's foot): a 6px dot in the state colour — pulsing while the
 * node is live — then the state word, 10px, muted (FR-EXE-009). The word is printed, so colour alone
 * never carries the state.
 */
export function StatusChip({ state, className, style, ...props }: StatusChipProps) {
  const meta = NODE_STATE_META[state];
  return (
    <span
      data-testid="status-chip"
      data-state={state}
      aria-label={meta.label}
      role="img"
      className={cn('inline-flex items-center gap-[6px] text-[10px]', className)}
      style={{ ...style, color: meta.color }}
      {...props}
    >
      <span
        aria-hidden
        data-live={meta.live ? 'true' : undefined}
        className={cn(
          'h-[6px] w-[6px] shrink-0 rounded-full bg-current',
          meta.live && LIVE_PULSE_CLASS,
        )}
      />
      <span aria-hidden className="text-[var(--muted)]">
        {meta.label}
      </span>
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
 * A provider's reachability, for the providers and settings screens (FR-PRV-004), as the theme's
 * "live" pill: 24px, hairline, mono 10px, a 6px dot in the state colour. It shows the name and the
 * state — never a key, which the API does not even return (FR-PRV-002).
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
        'inline-flex h-[24px] items-center gap-[5px] rounded-full border border-[var(--line)] px-[9px]',
        'font-machine text-[10px] text-[var(--muted)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'h-[6px] w-[6px] shrink-0 rounded-full',
          status === 'CHECKING' && 'motion-safe:animate-[livePulse_2s_ease-in-out_infinite]',
        )}
        style={{ backgroundColor: `var(--color-provider-status-${status})` }}
      />
      <span className="max-w-[10rem] truncate text-[var(--ink)]">{name}</span>
      <span>{PROVIDER_STATE_LABEL[status]}</span>
    </span>
  );
}
