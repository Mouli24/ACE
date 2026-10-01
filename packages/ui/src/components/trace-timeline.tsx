import type { TraceEntry, TraceEntryKind } from '@ace/contracts';
import {
  Activity,
  ChevronRight,
  Cpu,
  Hand,
  Repeat,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '../lib/cn.js';
import { JsonTree } from './json-tree.js';

/**
 * A run's trace as an ordered vertical timeline (FR-OBS-001, TC-OBS-001). Entries render in the
 * order given — the engine sends ascending `seq` — each with an icon for its kind, its label, the
 * time since the run started and, where it spans time, its duration. The detail (the event payload)
 * is behind a disclosure button, so a long trace opens compact and is keyboard-operable.
 */

export const TRACE_KIND_ICON: Readonly<Record<TraceEntryKind, LucideIcon>> = {
  node_run: Cpu,
  tool_call: Wrench,
  verdict: ShieldCheck,
  approval: Hand,
  loop: Repeat,
  run_event: Activity,
};

export const TRACE_KIND_LABEL: Readonly<Record<TraceEntryKind, string>> = {
  node_run: 'Node run',
  tool_call: 'Tool call',
  verdict: 'Guardrail verdict',
  approval: 'Approval',
  loop: 'Loop iteration',
  run_event: 'Run event',
};

/** `320 ms`, `1.2 s`, `2 m 03 s`. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

function relative(at: string, base: number): string {
  const delta = Date.parse(at) - base;
  if (!Number.isFinite(delta)) return '';
  return `+${formatDurationMs(Math.max(0, delta))}`;
}

export interface TraceTimelineProps {
  entries: readonly TraceEntry[];
  /** The instant relative times count from; defaults to the first entry's `at`. */
  startedAt?: string;
  /** Detail open on first render for these seqs. */
  defaultExpanded?: readonly number[];
  className?: string;
}

function TraceRow({
  entry,
  base,
  open: initialOpen,
}: {
  entry: TraceEntry;
  base: number;
  open: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const detailId = useId();
  const Icon = TRACE_KIND_ICON[entry.kind];
  const hasDetail = entry.detail !== undefined && entry.detail !== null;

  return (
    <li className="relative pl-8" data-testid={`trace-entry-${entry.seq}`} data-kind={entry.kind}>
      <span
        aria-hidden
        className="absolute left-0 top-1.5 flex size-6 items-center justify-center rounded-full border border-border bg-card text-fg-muted"
      >
        <Icon className="size-3.5" />
      </span>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-border/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:hover:bg-transparent"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-fg-muted transition-transform',
            open && 'rotate-90',
            !hasDetail && 'invisible',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="break-words text-sm text-fg">{entry.label}</span>
          <span className="flex flex-wrap gap-x-2 font-machine text-[11px] text-fg-muted">
            <span className="sr-only">{TRACE_KIND_LABEL[entry.kind]}, </span>
            <span>#{entry.seq}</span>
            <time dateTime={entry.at} title={entry.at}>
              {relative(entry.at, base)}
            </time>
            {entry.durationMs !== undefined ? (
              <span data-testid="trace-duration">took {formatDurationMs(entry.durationMs)}</span>
            ) : null}
            {entry.nodeId ? <span className="truncate">{entry.nodeId}</span> : null}
          </span>
        </span>
      </button>
      {hasDetail && open ? (
        <div id={detailId} className="ml-7 mt-1 rounded-md border border-border bg-canvas p-2">
          <JsonTree value={entry.detail} />
        </div>
      ) : null}
    </li>
  );
}

export function TraceTimeline({
  entries,
  startedAt,
  defaultExpanded = [],
  className,
}: TraceTimelineProps) {
  if (entries.length === 0) {
    return (
      <p className={cn('text-sm text-fg-muted', className)} data-testid="trace-empty">
        No trace entries yet.
      </p>
    );
  }
  const baseAt = startedAt ?? entries[0]?.at ?? '';
  const base = Date.parse(baseAt);
  return (
    <ol
      className={cn(
        'relative flex flex-col gap-1 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-border',
        className,
      )}
      aria-label="Run trace"
      data-testid="trace-timeline"
    >
      {entries.map((entry) => (
        <TraceRow
          key={entry.seq}
          entry={entry}
          base={base}
          open={defaultExpanded.includes(entry.seq)}
        />
      ))}
    </ol>
  );
}
