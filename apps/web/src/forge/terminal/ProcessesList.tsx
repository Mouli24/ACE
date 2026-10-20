import type { ProcessSummary } from '@ace/contracts';
import { cn } from '@ace/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../app/api';
import { agentMap, type AgentLook } from '../../theme/agents';
import { nodeStatusLook } from '../../theme/format';
import { queryKeys } from '../../workflows/query-keys';
import { requestTerminalFocus } from './focus';
import { useProcessList, useStopProcess } from './hooks';
import { openProcessInTab } from './session';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

// eslint-disable-next-line no-control-regex -- colour escapes are exactly what is removed
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** A row's quiet action, in the footer's mono: Show, and Stop in the theme's red. */
const ROW_ACTION =
  'shrink-0 cursor-pointer rounded-[5px] border-none bg-transparent px-[5px] py-[2px] font-machine text-[10px] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/** The last line a process printed, plain, for its row. */
function lastLine(output: string | undefined): string | undefined {
  const lines = (output ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  return lines.filter((line) => line !== '').at(-1);
}

function endingOf(summary: ProcessSummary): string {
  if (summary.status === 'failed') return 'could not start';
  if (summary.signal !== null) return 'stopped';
  return `exit ${summary.exitCode ?? '?'}`;
}

/** "4s", "2m 05s", "1h 02m": how long a command has run or ran. */
function durationOf(summary: ProcessSummary, nowMs: number): string {
  const end = summary.endedAt === undefined ? nowMs : Date.parse(summary.endedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(summary.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A process's dot in the Stage cards' colours: running, done, stopped, failed. */
function dotOf(summary: ProcessSummary): string {
  if (summary.status === 'running') return nodeStatusLook('RUNNING').color;
  if (summary.status === 'failed') return nodeStatusLook('FAILED').color;
  if (summary.signal !== null) return nodeStatusLook('STOPPED').color;
  return nodeStatusLook(summary.exitCode === 0 ? 'COMPLETED' : 'FAILED').color;
}

/**
 * Running processes with Stop, and recent ones with how they ended (D301, design §6.3), carded as
 * Problems is (D334): a mono heading, then one surface card with a hairline between rows. A running
 * one no tab owns — a dev server started from another browser tab, or before a reload — shows its
 * latest line and opens in a tab with Show.
 *
 * PG-5.3 (D361): an agent's command (`summary.agent`) is listed too, with its node's colour chip
 * and name, its command in mono, its status and how long it ran. Show opens its output. A running
 * background command has Kill (Task 14); a foreground one says to stop the run. A node filter
 * (All, then each node that has rows) narrows the list.
 */
export function ProcessesList({ projectId }: { projectId: string }) {
  const list = useProcessList(projectId);
  const stop = useStopProcess(projectId);
  const queryClient = useQueryClient();
  const tabs = useProjectTerminals(projectId).tabs;
  const unowned = useTerminalStore((state) => state.unowned);
  const all = useMemo(() => list.data ?? [], [list.data]);
  const [filter, setFilter] = useState<string>('all');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyRunning = all.some((summary) => summary.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // Each agent row's node: its name and colour come from the run's snapshot (graph order, D328).
  const runIds = useMemo(
    () => [...new Set(all.flatMap((summary) => (summary.agent ? [summary.agent.runId] : [])))],
    [all],
  );
  const runs = useQueries({
    queries: runIds.map((runId) => ({
      queryKey: queryKeys.run(runId),
      queryFn: () => api().getRun(runId),
    })),
  });
  const looks = useMemo(() => {
    const byRun = new Map<string, Map<string, AgentLook>>();
    runIds.forEach((runId, index) => {
      const nodes = runs[index]?.data?.snapshot.nodes;
      if (nodes !== undefined) byRun.set(runId, agentMap(nodes));
    });
    return byRun;
  }, [runIds, runs]);
  const lookOf = (summary: ProcessSummary): AgentLook | undefined =>
    summary.agent === undefined
      ? undefined
      : looks.get(summary.agent.runId)?.get(summary.agent.nodeId);

  /** Nodes that have rows, for the filter: one entry per node id, named when the run is known. */
  const nodeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const summary of all) {
      if (summary.agent === undefined) continue;
      const look = looks.get(summary.agent.runId)?.get(summary.agent.nodeId);
      seen.set(summary.agent.nodeId, look?.name ?? 'agent');
    }
    return [...seen];
  }, [all, looks]);
  const items = filter === 'all' ? all : all.filter((summary) => summary.agent?.nodeId === filter);

  return (
    <section aria-label="Processes" className="flex min-h-0 w-[240px] shrink-0 flex-col gap-[6px]">
      <h3 className="m-0 font-machine text-[10px] font-normal tracking-[0.1em] text-[var(--muted)]">
        PROCESSES
      </h3>
      {nodeOptions.length > 0 && (
        <div role="group" aria-label="Filter by node" className="flex flex-wrap gap-[4px]">
          {[['all', 'All'], ...nodeOptions].map(([id, name]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id ?? 'all')}
              className={cn(
                ROW_ACTION,
                filter === id ? 'bg-[var(--hover)] text-[var(--ink)]' : 'text-[var(--muted)]',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {list.isSuccess && all.length === 0 && (
        <p className="m-0 text-[12px] text-[var(--muted)]">Nothing has run yet.</p>
      )}
      {list.isSuccess && all.length > 0 && items.length === 0 && (
        <p className="m-0 text-[12px] text-[var(--muted)]">Nothing from this node yet.</p>
      )}
      {items.length > 0 && (
        <ul className="m-0 flex min-h-0 list-none flex-col overflow-auto rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-0">
          {items.map((summary) => {
            const running = summary.status === 'running';
            const owned = tabs.some((tab) => tab.processId === summary.id);
            const preview = running && !owned ? lastLine(unowned[summary.id]?.output) : undefined;
            const agent = summary.agent !== undefined;
            const look = lookOf(summary);
            const background = summary.agent?.background === true;
            return (
              <li
                key={summary.id}
                data-testid={`process-${summary.id}`}
                className="flex min-h-[32px] items-center gap-[8px] border-t border-[var(--line)] px-[10px] py-[5px] text-[12px] first:border-t-0"
              >
                <span
                  aria-hidden
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ background: dotOf(summary) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-[5px]">
                    {agent && (
                      <span
                        data-testid={`process-agent-${summary.id}`}
                        title={`An agent's command (run ${summary.agent?.runId.slice(-6) ?? ''})`}
                        className="max-w-[90px] shrink-0 truncate rounded-[4px] px-[4px] font-machine text-[9px] tracking-[0.04em]"
                        style={
                          look === undefined
                            ? { background: 'var(--hover)', color: 'var(--muted)' }
                            : { background: `${look.color}22`, color: look.color }
                        }
                      >
                        {look?.name ?? 'agent'}
                      </span>
                    )}
                    <span
                      className={cn(
                        'block truncate text-[var(--ink)]',
                        agent && 'font-machine text-[11px]',
                      )}
                      title={summary.command}
                    >
                      {agent ? summary.command : summary.label}
                    </span>
                  </span>
                  {agent && (
                    <span className="block truncate font-machine text-[9.5px] text-[var(--muted)]">
                      {running ? 'running' : endingOf(summary)} · {durationOf(summary, nowMs)}
                      {background ? ' · background' : ''}
                    </span>
                  )}
                  {agent && running && !background && (
                    <span className="block text-[9.5px] text-[var(--muted)]">
                      Stop the run to stop this command.
                    </span>
                  )}
                  {preview !== undefined && (
                    <span className="block truncate font-machine text-[9.5px] text-[var(--muted)]">
                      {preview}
                    </span>
                  )}
                </span>
                {running ? (
                  <>
                    {!owned && (
                      <button
                        type="button"
                        aria-label={`Show ${summary.label}`}
                        onClick={() => {
                          requestTerminalFocus();
                          void openProcessInTab(projectId, summary, queryClient);
                        }}
                        className={cn(ROW_ACTION, 'text-[var(--muted)] hover:text-[var(--ink)]')}
                      >
                        Show
                      </button>
                    )}
                    {(!agent || background) && (
                      <button
                        type="button"
                        aria-label={`${agent ? 'Kill' : 'Stop'} ${summary.label}`}
                        onClick={() => stop.mutate(summary.id)}
                        className={cn(ROW_ACTION, 'text-[#c94c27]')}
                      >
                        {agent ? 'Kill' : 'Stop'}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="shrink-0 font-machine text-[9.5px] text-[var(--muted)]">
                    {endingOf(summary)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
