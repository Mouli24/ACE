import type { ProcessSummary } from '@ace/contracts';
import { cn } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';

import { nodeStatusLook } from '../../theme/format';
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
 */
export function ProcessesList({ projectId }: { projectId: string }) {
  const list = useProcessList(projectId);
  const stop = useStopProcess(projectId);
  const queryClient = useQueryClient();
  const tabs = useProjectTerminals(projectId).tabs;
  const unowned = useTerminalStore((state) => state.unowned);
  const items = list.data ?? [];

  return (
    <section aria-label="Processes" className="flex min-h-0 w-[240px] shrink-0 flex-col gap-[6px]">
      <h3 className="m-0 font-machine text-[10px] font-normal tracking-[0.1em] text-[var(--muted)]">
        PROCESSES
      </h3>
      {list.isSuccess && items.length === 0 && (
        <p className="m-0 text-[12px] text-[var(--muted)]">Nothing has run yet.</p>
      )}
      {items.length > 0 && (
        <ul className="m-0 flex min-h-0 list-none flex-col overflow-auto rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-0">
          {items.map((summary) => {
            const running = summary.status === 'running';
            const owned = tabs.some((tab) => tab.processId === summary.id);
            const preview = running && !owned ? lastLine(unowned[summary.id]?.output) : undefined;
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
                  <span className="block truncate text-[var(--ink)]" title={summary.command}>
                    {summary.label}
                  </span>
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
                    <button
                      type="button"
                      aria-label={`Stop ${summary.label}`}
                      onClick={() => stop.mutate(summary.id)}
                      className={cn(ROW_ACTION, 'text-[#c94c27]')}
                    >
                      Stop
                    </button>
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
