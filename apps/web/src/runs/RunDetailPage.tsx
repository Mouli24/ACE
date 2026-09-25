import type { Id, NodeRun } from '@ace/contracts';
import { StatusRing } from '@ace/ui';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ErrorsTab } from '../errors/ErrorsTab';
import { useProviders } from '../providers/hooks';
import { ApprovalStack } from './approvals/ApprovalStack';
import { RunControls } from './controls/RunControls';
import {
  useApprovals,
  useNodeRunsOnce,
  usePauseRun,
  useRestartRun,
  useResumeRun,
  useRetryNodeRun,
  useRun,
  useStopRun,
} from './hooks';

/**
 * `/runs/:runId` (round 2 §5 step 9, extended in round 3): one run — the snapshot it executed, the
 * state each node ended in, what it cost, and what went wrong.
 *
 * The recording itself cannot be edited (BR-04), but a run can still be *acted on*: paused, stopped,
 * restarted, a failed node retried, an approval answered. Which of those is offered is the engine's
 * `allowedActions` and nothing else (FR-CTL-006).
 */
export function RunDetailPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const run = useRun(runId);
  const nodeRuns = useNodeRunsOnce(runId);
  const providers = useProviders();
  const approvals = useApprovals(runId);
  const pause = usePauseRun();
  const resume = useResumeRun();
  const stop = useStopRun();
  const restart = useRestartRun();
  const retry = useRetryNodeRun();
  const busy = pause.isPending || resume.isPending || stop.isPending || restart.isPending;

  if (run.isPending) return <p className="p-6 text-fg-muted">Loading run…</p>;
  if (run.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Could not load this run: {run.error.message}
      </p>
    );
  }
  if (!run.data) return null;

  const stateByNodeId = new Map<string, NodeRun>(
    (nodeRuns.data ?? []).map((nodeRun) => [nodeRun.nodeId, nodeRun]),
  );

  const record = run.data;
  const onAction = async (action: 'pause' | 'resume' | 'stop' | 'restart') =>
    ({ pause, resume, stop, restart })[action].mutateAsync(record.id);

  const providerNames = Object.fromEntries(
    (providers.data ?? []).map((provider) => [provider.id, provider.name]),
  );

  const errorRows = (nodeRuns.data ?? []).map((nodeRun) => ({
    nodeRunId: nodeRun.id,
    nodeId: nodeRun.nodeId,
    status: nodeRun.status,
    attempt: nodeRun.attempt,
    ...(nodeRun.failureReason === undefined ? {} : { failureReason: nodeRun.failureReason }),
    ...(nodeRun.error === undefined ? {} : { error: nodeRun.error }),
  }));

  return (
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-4 py-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-human text-2xl font-semibold">Run</h1>
        <span
          data-testid="run-detail-status"
          data-status={run.data.status}
          className="rounded-chip border border-border bg-card px-2 py-0.5 font-machine text-xs"
        >
          {run.data.status}
          {run.data.haltReason ? ` · ${run.data.haltReason}` : ''}
        </span>
        <span className="font-machine text-xs text-fg-muted">
          {new Date(run.data.startedAt).toLocaleString()}
          {run.data.durationMs === undefined ? '' : ` · ${run.data.durationMs} ms`}
        </span>
        <span className="ml-auto font-machine text-xs" data-testid="run-detail-totals">
          {run.data.totals.tokensIn}↓ {run.data.totals.tokensOut}↑ $
          {run.data.totals.costUsd.toFixed(4)}
          {run.data.totals.priceTableVersion ? ` · ${run.data.totals.priceTableVersion}` : ''}
        </span>
        <Link
          to={`/projects/${run.data.projectId}/workflows/${run.data.workflowId}`}
          className="font-machine text-xs underline"
        >
          open the Canvas
        </Link>
      </header>

      {/* FR-EXE-003: a run refused at pre-flight is still a run, and its issues are the record. */}
      {run.data.preflightIssues.length > 0 && (
        <section
          data-testid="run-detail-preflight"
          className="flex flex-col gap-2 rounded-card border border-[var(--color-status-BLOCKED)]/60 bg-card p-4"
        >
          <h2 className="font-human text-sm font-semibold">Pre-flight refused this run</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {run.data.preflightIssues.map((issue, index) => (
              <li key={index} className="flex gap-2">
                <span className="font-machine text-xs text-fg-muted">{issue.code}</span>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RunControls
        runId={record.id}
        status={record.status}
        {...(record.allowedActions === undefined ? {} : { allowedActions: record.allowedActions })}
        {...(record.haltReason === undefined ? {} : { haltReason: record.haltReason })}
        {...(record.budgetHalt === undefined ? {} : { budgetHalt: record.budgetHalt })}
        onAction={onAction}
        onOpenRun={(id: Id) => navigate(`/runs/${id}`)}
        busy={busy}
      />

      {/* An approval waits on a person wherever they are looking (FR-GRD-013, §5 item 4). */}
      {(approvals.data ?? []).length > 0 && (
        <section className="flex flex-col gap-2" data-testid="run-detail-approvals">
          <h2 className="font-human text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Waiting on you
          </h2>
          <ApprovalStack requests={approvals.data ?? []} className="max-w-md" />
        </section>
      )}

      <ErrorsTab
        nodes={record.snapshot.nodes}
        edges={record.snapshot.edges}
        nodeRuns={errorRows}
        {...(record.haltReason === undefined ? {} : { haltReason: record.haltReason })}
        {...(record.budgetHalt === undefined ? {} : { budgetHalt: record.budgetHalt })}
        providerNames={providerNames}
        onRetry={(nodeRunId) => retry.mutate({ nodeRunId, withDownstream: false })}
        {...(retry.isPending && retry.variables !== undefined
          ? { retryingNodeRunId: retry.variables.nodeRunId }
          : {})}
      />

      <section className="flex flex-col gap-2">
        <h2 className="font-human text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Snapshot · version {run.data.snapshot.version}
        </h2>
        <ul className="flex flex-col gap-1" data-testid="run-detail-nodes">
          {run.data.snapshot.nodes.map((node) => {
            const nodeRun = stateByNodeId.get(node.id);
            return (
              <li
                key={node.id}
                data-testid={`run-detail-node-${node.id}`}
                data-state={nodeRun?.status ?? 'IDLE'}
                className="flex items-center gap-3 rounded-card border border-border bg-panel px-3 py-2"
              >
                <StatusRing state={nodeRun?.status ?? 'IDLE'} showLabel />
                <span className="font-human text-sm">{node.name}</span>
                <span className="font-machine text-[10px] uppercase text-fg-muted">
                  {node.kind}
                </span>
                {nodeRun?.modelUsed && (
                  <span className="font-machine text-xs text-fg-muted">
                    {nodeRun.modelUsed.modelId}
                    {nodeRun.modelUsed.viaFallback ? ' (fallback)' : ''}
                  </span>
                )}
                <span className="ml-auto font-machine text-xs text-fg-muted">
                  {nodeRun
                    ? `${nodeRun.usage.tokensIn}↓ ${nodeRun.usage.tokensOut}↑ $${nodeRun.usage.costUsd.toFixed(4)}`
                    : 'not run'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
