import type { TraceEntry, TraceEntryKind } from '@ace/contracts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '../lib/cn.js';
import { JsonTree } from './json-tree.js';

/**
 * A run's trace as an ordered list (FR-OBS-001, TC-OBS-001). Entries render in the order given —
 * the engine sends ascending `seq` — each with a glyph for its kind, its label, the time since the
 * run started and, where it spans time, its duration. The detail (the event payload) is behind a
 * disclosure button, so a long trace opens compact and is keyboard-operable.
 *
 * In the theme (D328) this is Domain's "What it did" list: one soft box, radius 10, rows 12.5px with
 * a hairline between them, an 18px round marker and the duration in mono on the right.
 */

/** One text glyph per trace kind, in the theme's vocabulary. */
export const TRACE_KIND_ICON: Readonly<Record<TraceEntryKind, string>> = {
  node_run: '●',
  tool_call: '⌁',
  verdict: '✦',
  approval: '✋',
  loop: '↺',
  run_event: '▶',
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
  const hasDetail = entry.detail !== undefined && entry.detail !== null;

  return (
    <li
      className="border-t border-[var(--line)] first:border-t-0"
      data-testid={`trace-entry-${entry.seq}`}
      data-kind={entry.kind}
    >
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-[10px] border-none bg-transparent px-3 py-[9px] text-left text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f] disabled:cursor-default disabled:hover:bg-transparent"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--hover)] text-[9px] text-[var(--muted)]"
        >
          {TRACE_KIND_ICON[entry.kind]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="break-words text-[12.5px]">{entry.label}</span>
          <span className="flex flex-wrap gap-x-2 font-machine text-[10.5px] text-[var(--muted)]">
            <span className="sr-only">{TRACE_KIND_LABEL[entry.kind]}, </span>
            <span>#{entry.seq}</span>
            <time dateTime={entry.at} title={entry.at}>
              {relative(entry.at, base)}
            </time>
            {entry.nodeId ? <span className="truncate">{entry.nodeId}</span> : null}
          </span>
        </span>
        {entry.durationMs !== undefined ? (
          <span
            data-testid="trace-duration"
            className="shrink-0 font-machine text-[10.5px] text-[var(--muted)]"
          >
            took {formatDurationMs(entry.durationMs)}
          </span>
        ) : null}
        <span
          aria-hidden
          className={cn(
            'w-[10px] shrink-0 text-[10px] text-[var(--muted)]',
            !hasDetail && 'invisible',
          )}
        >
          {open ? <ChevronDown aria-hidden size={10} /> : <ChevronRight aria-hidden size={10} />}
        </span>
      </button>
      {hasDetail && open ? (
        <div id={detailId} className="px-3 pb-[10px]">
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
      <p
        className={cn('py-3 text-center text-[13px] text-[var(--muted)]', className)}
        data-testid="trace-empty"
      >
        No trace entries yet.
      </p>
    );
  }
  const baseAt = startedAt ?? entries[0]?.at ?? '';
  const base = Date.parse(baseAt);
  return (
    <ol
      className={cn(
        'm-0 flex list-none flex-col overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--soft)] p-0',
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
