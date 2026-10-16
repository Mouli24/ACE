import type { NodeRun, Part, Run } from '@ace/contracts';
import { Button, cn, Icons, PartRenderer, toast } from '@ace/ui';

import { api } from '../app/api';
import { useRestartRun } from '../runs/hooks';
import { isLiveRun } from '../runs/selected-run';
import { haltWords } from './looks';

/**
 * The end of a run's conversation, said plainly (`@workflow`): a COMPLETE run's result — what each
 * Output node produced, through the part renderers — or, for a HALTED or BLOCKED run, why it
 * stopped in words, with Retry (a restart, when the engine allows one). Domain's projection ends
 * with a one-line "Run COMPLETE." and never shows an Output node's parts, so this card is the
 * result, not a copy of a message above it. Nothing while the run is live.
 */
export function RunResult({
  run,
  nodeRuns,
  onRestarted,
  className,
}: {
  run: Run;
  nodeRuns?: readonly NodeRun[];
  /** The restart made a new run: the caller selects it. */
  onRestarted?: (run: Run) => void;
  className?: string;
}) {
  const restart = useRestartRun();
  if (isLiveRun(run)) return null;

  const canRestart = (run.allowedActions ?? []).includes('restart');
  const retry = canRestart ? (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      data-testid="run-result-retry"
      disabled={restart.isPending}
      onClick={() =>
        restart.mutate(run.id, {
          onSuccess: (next) => onRestarted?.(next),
          onError: (error) => toast.error(error.message),
        })
      }
    >
      <Icons.RotateCcw aria-hidden size={13} />
      Retry
    </Button>
  ) : null;

  if (run.status === 'COMPLETE') {
    const outputs = run.snapshot.nodes
      .filter((node) => node.kind === 'output')
      .map((node) => ({ node, parts: outputOf(run, nodeRuns, node.id) }))
      .filter((each) => each.parts.length > 0);
    return (
      <section
        data-testid="run-result"
        data-status="COMPLETE"
        aria-label="Result"
        className={cn(
          'flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[rgba(47,158,99,0.35)] bg-[var(--surface)]',
          className,
        )}
      >
        <h3 className="m-0 flex items-center gap-2 border-b border-[rgba(47,158,99,0.25)] bg-[rgba(47,158,99,0.10)] px-[14px] py-[10px] text-[13px] font-bold">
          <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]" />
          Result
        </h3>
        {outputs.length === 0 ? (
          <p className="m-0 px-[14px] py-[11px] text-[12.5px] text-[var(--muted)]">
            The run completed, but no Output node produced anything.
          </p>
        ) : (
          outputs.map(({ node, parts }) => (
            <div
              key={node.id}
              data-testid={`run-result-output-${node.id}`}
              className="flex min-w-0 flex-col gap-2 overflow-x-auto break-words border-t border-[var(--line)] px-[14px] py-[11px] first-of-type:border-t-0"
            >
              {outputs.length > 1 && (
                <span className="text-[11px] font-semibold text-[var(--muted)]">{node.name}</span>
              )}
              {parts.map((part, index) => (
                <PartRenderer
                  key={index}
                  part={part}
                  contentUrl={(artifactId) => api().artifactContentUrl(artifactId)}
                />
              ))}
            </div>
          ))
        )}
      </section>
    );
  }

  const reasons = failureLines(run, nodeRuns);
  const title =
    run.status === 'BLOCKED'
      ? 'Pre-flight blocked this run — nothing was sent to a provider'
      : `The run halted — ${haltWords(run.haltReason ?? 'failure')}`;
  return (
    <section
      role="alert"
      data-testid="run-result"
      data-status={run.status}
      aria-label="Result"
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)] px-[14px] py-[11px]',
        className,
      )}
    >
      <h3 className="m-0 flex items-center gap-2 text-[13px] font-bold">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
        {title}
      </h3>
      {reasons.length > 0 && (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px]">
          {reasons.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {retry !== null && <div className="flex">{retry}</div>}
    </section>
  );
}

/** What an Output node gave the run: the run's `finalOutput`, else its newest node run's output. */
function outputOf(run: Run, nodeRuns: readonly NodeRun[] | undefined, nodeId: string): Part[] {
  const recorded = run.finalOutput?.[nodeId];
  if (recorded !== undefined && recorded.length > 0) return recorded;
  const latest = [...(nodeRuns ?? [])]
    .reverse()
    .find((each) => each.nodeId === nodeId && each.output !== undefined);
  return latest?.output ?? [];
}

/** Why the run did not complete, one line each: pre-flight issues, a budget, failed nodes. */
function failureLines(run: Run, nodeRuns: readonly NodeRun[] | undefined): string[] {
  if (run.status === 'BLOCKED') return run.preflightIssues.map((issue) => issue.message);
  const names = new Map(run.snapshot.nodes.map((node) => [node.id, node.name]));
  const lines: string[] = [];
  if (run.budgetHalt !== undefined) {
    lines.push(
      `The ${run.budgetHalt.scope} budget was reached: $${run.budgetHalt.costUsd.toFixed(4)} of a $${run.budgetHalt.capUsd.toFixed(2)} cap.`,
    );
  }
  const seen = new Set<string>();
  for (const record of [...(nodeRuns ?? [])].reverse()) {
    if (record.status !== 'FAILED' || seen.has(record.nodeId)) continue;
    seen.add(record.nodeId);
    const name = names.get(record.nodeId) ?? 'A node';
    lines.push(
      record.error === undefined
        ? `${name} failed (${record.failureReason ?? 'RUN_FAILED'}).`
        : `${name} failed: ${record.error.message}`,
    );
  }
  return lines;
}
