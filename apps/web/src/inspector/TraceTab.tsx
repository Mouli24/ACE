import { RUN_EVENT_TYPES, type Id, type RunState, type TraceEntry } from '@ace/contracts';
import { Button, TraceTimeline } from '@ace/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '../app/api';
import { useRun } from '../runs/hooks';
import { frameRunId, useSocketFrames } from '../usage/live';

/** A run that can still add events to its log; anything else has a closed trace (BR-04). */
const LIVE: ReadonlySet<RunState> = new Set<RunState>(['PREFLIGHT', 'RUNNING', 'PAUSED']);

/** While a run is live, the trace is also polled — a backstop for a socket not subscribed to it. */
const POLL_MS = 2_000;
/** Frames arrive in bursts (a node's state, output, usage); one refetch covers a burst. */
const BURST_MS = 250;

/** Every persisted run frame — `node.token` never reaches the event log, so never the trace. */
const TRACED_FRAMES = RUN_EVENT_TYPES.filter((type) => type !== 'node.token');

export const traceQueryKey = (runId: Id) => ['trace', runId] as const;

/**
 * The run's trace, from `GET /runs/:id/trace`, optionally narrowed to one node (FR-OBS-001,
 * TC-OBS-001). Entries render exactly in the order the engine sends them — ascending `seq`, the
 * event log's own order — and are never re-sorted here. While the run is live the trace is
 * refetched on its frames and polled modestly; a finished run's trace cannot change.
 */
export function TraceTab({ runId, nodeId }: { runId: Id; nodeId?: Id }) {
  const queryClient = useQueryClient();
  const run = useRun(runId);
  const live = run.data !== undefined && LIVE.has(run.data.status);
  const [wholeRun, setWholeRun] = useState(false);

  const trace = useQuery({
    queryKey: traceQueryKey(runId),
    queryFn: () => api().getRunTrace(runId),
    refetchInterval: live ? POLL_MS : false,
  });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useSocketFrames(TRACED_FRAMES, (frame) => {
    if (frameRunId(frame) !== runId || timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void queryClient.invalidateQueries({ queryKey: traceQueryKey(runId) });
    }, BURST_MS);
  });

  const all: readonly TraceEntry[] = trace.data ?? [];
  const narrowed = nodeId !== undefined && !wholeRun;
  const entries = narrowed ? all.filter((entry) => entry.nodeId === nodeId) : all;
  const Heading = nodeId === undefined ? 'h2' : 'h3';

  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-testid="trace-tab"
      data-scope={narrowed ? 'node' : 'run'}
      aria-labelledby={`trace-heading-${runId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading
          id={`trace-heading-${runId}`}
          className="font-human text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Trace
        </Heading>
        {trace.data && (
          <span className="font-machine text-[11px] text-fg-muted" data-testid="trace-count">
            {narrowed
              ? `${entries.length} of ${all.length} entries`
              : `${all.length} ${all.length === 1 ? 'entry' : 'entries'}`}
          </span>
        )}
        {live && (
          <span className="font-machine text-[11px] text-fg-muted" data-testid="trace-live">
            live
          </span>
        )}
        {nodeId !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            aria-pressed={wholeRun}
            data-testid="trace-scope-toggle"
            onClick={() => setWholeRun((value) => !value)}
          >
            {wholeRun ? 'Show this node only' : 'Show whole run'}
          </Button>
        )}
      </div>

      {trace.isPending ? (
        <p className="text-sm text-fg-muted">Loading trace…</p>
      ) : trace.isError ? (
        <p role="alert" className="text-sm text-[var(--color-status-FAILED)]">
          Could not load the trace: {trace.error.message}
        </p>
      ) : (
        <TraceTimeline
          entries={entries}
          {...(run.data?.startedAt === undefined ? {} : { startedAt: run.data.startedAt })}
        />
      )}
    </section>
  );
}
