import { RUN_EVENT_TYPES, type Id, type RunState, type TraceEntry } from '@ace/contracts';
import { Button, TraceTimeline } from '@ace/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '../app/api';
import { useRun, useSocketStatus } from '../runs/hooks';
import { frameRunId, useSocketFrames } from '../usage/live';

/** A run that can still add events to its log; anything else has a closed trace (BR-04). */
const LIVE: ReadonlySet<RunState> = new Set<RunState>(['PREFLIGHT', 'RUNNING', 'PAUSED']);

/**
 * While a run is live and the socket is not open, the trace is polled — the backstop for frames
 * that cannot arrive. [audit W-20] With the socket open its frames refetch it, so no poll as well.
 */
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
 *
 * In the theme (D328): a mono small-caps heading with the count beside it, "live" as the theme's
 * live pill, and the scope switch as a small Close pill.
 */
export function TraceTab({ runId, nodeId }: { runId: Id; nodeId?: Id }) {
  const queryClient = useQueryClient();
  const run = useRun(runId);
  const live = run.data !== undefined && LIVE.has(run.data.status);
  const [wholeRun, setWholeRun] = useState(false);
  const socket = useSocketStatus();

  const trace = useQuery({
    queryKey: traceQueryKey(runId),
    queryFn: () => api().getRunTrace(runId),
    refetchInterval: live && socket !== 'open' ? POLL_MS : false,
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
          className="m-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]"
        >
          Trace
        </Heading>
        {trace.data && (
          <span
            className="font-machine text-[10.5px] text-[var(--muted)]"
            data-testid="trace-count"
          >
            {narrowed
              ? `${entries.length} of ${all.length} entries`
              : `${all.length} ${all.length === 1 ? 'entry' : 'entries'}`}
          </span>
        )}
        {live && (
          <span
            className="flex h-[24px] items-center gap-[5px] rounded-full border border-[var(--line)] px-[9px] font-machine text-[10px] text-[#2f9e63]"
            data-testid="trace-live"
          >
            <span
              aria-hidden
              className="h-[6px] w-[6px] rounded-full bg-[#2f9e63] motion-safe:animate-[livePulse_2s_ease-in-out_infinite]"
            />
            live
          </span>
        )}
        {nodeId !== undefined && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="ml-auto h-[26px] px-[11px] text-[11px]"
            aria-pressed={wholeRun}
            data-testid="trace-scope-toggle"
            onClick={() => setWholeRun((value) => !value)}
          >
            {wholeRun ? 'Show this node only' : 'Show whole run'}
          </Button>
        )}
      </div>

      {trace.isPending ? (
        <p className="m-0 py-3 text-center text-[13px] text-[var(--muted)]">Loading trace…</p>
      ) : trace.isError ? (
        <p role="alert" className="m-0 text-[13px] text-danger">
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
