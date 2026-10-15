import type { Id, NodeRun, RunAction } from '@ace/contracts';
import { PartRenderer, StatusRing } from '@ace/ui';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../app/api';
import { useWorkflowSubscription } from '../app/socket';
import { ErrorsTab } from '../errors/ErrorsTab';
import { TraceTab } from '../inspector/TraceTab';
import { useProviders } from '../providers/hooks';
import { TOUCH_TARGETS } from '../responsive/touch';
import { useIsCompact } from '../responsive/useIsCompact';
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
  useEndRun,
} from './hooks';
import { CostValue, costText } from './CostValue';
import { CHIP_CLASS, RunStateChip } from './RunStateChip';

/** The theme's small-caps section label: JetBrains Mono 9.5px, 0.1em, muted, 500 (D328). */
const SECTION_LABEL =
  'm-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]';

/** The output card's action button, as a link: 28px, radius 8, hairline, `--chip`, 12px / 600. */
const ACTION_LINK =
  'inline-flex h-[28px] items-center whitespace-nowrap rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-3 text-[12px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * `/runs/:runId` (round 2 §5 step 9, extended in round 3): one run — the snapshot it executed, the
 * state each node ended in, what it cost, and what went wrong.
 *
 * The recording itself cannot be edited (BR-04), but a run can still be *acted on*: paused, stopped,
 * restarted, a failed node retried, an approval answered. Which of those is offered is the engine's
 * `allowedActions` and nothing else (FR-CTL-006).
 *
 * An uncovered screen in the theme's vocabulary (D328): a 960px column, a 20px title, the state as a
 * mono chip, sections under small-caps labels, each output as the green output card and the
 * snapshot as a table card with hairline rows.
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
  const end = useEndRun();
  const retry = useRetryNodeRun();
  const compact = useIsCompact();
  // The trace and the node states arrive as the workflow's run frames (FR-OBS-001); counted, so an
  // open Canvas on the same workflow keeps its own feed when this page unmounts.
  useWorkflowSubscription(run.data?.workflowId);
  const busy =
    pause.isPending || resume.isPending || stop.isPending || restart.isPending || end.isPending;

  if (run.isPending) {
    return <p className="p-6 text-center text-[13px] text-[var(--muted)]">Loading run…</p>;
  }
  if (run.isError) {
    return (
      <p role="alert" className="p-6 text-center text-[13px] text-[#c94c27]">
        Could not load this run: {run.error.message}
      </p>
    );
  }
  if (!run.data) return null;

  const stateByNodeId = new Map<string, NodeRun>(
    (nodeRuns.data ?? []).map((nodeRun) => [nodeRun.nodeId, nodeRun]),
  );

  const record = run.data;
  const onAction = async (action: RunAction) =>
    ({ pause, resume, stop, restart, end })[action].mutateAsync(record.id);

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

  /* What each node produced, in snapshot order — the run's results, readable on a phone (FR-MOB-001). */
  const outputs = record.snapshot.nodes.flatMap((node) => {
    const output = stateByNodeId.get(node.id)?.output;
    return output === undefined || output.length === 0 ? [] : [{ node, output }];
  });

  return (
    <main
      className={`mx-auto flex h-full w-full min-w-0 max-w-[960px] flex-col gap-6 overflow-y-auto text-[var(--ink)] ${compact ? `px-4 py-4 ${TOUCH_TARGETS}` : 'px-6 py-8'}`}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-[10px]">
          <h1 className="m-0 text-[20px] font-bold tracking-[-0.01em]">Run</h1>
          <RunStateChip
            data-testid="run-detail-status"
            status={run.data.status}
            {...(run.data.haltReason === undefined ? {} : { haltReason: run.data.haltReason })}
          />
          <span className="text-[12px] text-[var(--muted)]">
            {new Date(run.data.startedAt).toLocaleString()}
            {run.data.durationMs === undefined ? '' : ` · ${run.data.durationMs} ms`}
          </span>
          <span className="flex-1" />
          <Link
            to={`/projects/${run.data.projectId}/workflows/${run.data.workflowId}?run=${run.data.id}`}
            className={ACTION_LINK}
          >
            open the Canvas<span aria-hidden>&nbsp;→</span>
          </Link>
          {/* PG-3.7: every mode, the run selected in it. */}
          <Link
            to={`/projects/${run.data.projectId}/workflows/${run.data.workflowId}/forge?run=${run.data.id}`}
            className={ACTION_LINK}
            data-testid="run-detail-open-forge"
          >
            Open in Forge<span aria-hidden>&nbsp;→</span>
          </Link>
          <Link
            to={`/projects/${run.data.projectId}/workflows/${run.data.workflowId}/domain?run=${run.data.id}`}
            className={ACTION_LINK}
          >
            Open in Domain<span aria-hidden>&nbsp;→</span>
          </Link>
        </div>
        <span
          className="font-machine text-[11.5px] text-[var(--muted)]"
          data-testid="run-detail-totals"
        >
          {run.data.totals.tokensIn}↓ {run.data.totals.tokensOut}↑{' '}
          <CostValue usage={run.data.totals} format={(value) => `$${value.toFixed(4)}`} />
          {run.data.totals.priceTableVersion ? ` · ${run.data.totals.priceTableVersion}` : ''}
        </span>
      </header>

      {/* FR-EXE-003: a run refused at pre-flight is still a run, and its issues are the record. */}
      {run.data.preflightIssues.length > 0 && (
        <section
          data-testid="run-detail-preflight"
          className="overflow-hidden rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)]"
        >
          <h2 className="m-0 flex items-center gap-2 border-b border-[rgba(201,76,39,0.25)] bg-[rgba(201,76,39,0.10)] px-[14px] py-[10px] text-[13px] font-bold">
            <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
            Pre-flight refused this run
          </h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {run.data.preflightIssues.map((issue, index) => (
              <li
                key={index}
                className="flex min-h-[36px] flex-wrap items-center gap-[10px] border-t border-[var(--line)] px-[14px] py-2 text-[12.5px] first:border-t-0"
              >
                <span className={`${CHIP_CLASS} bg-[#c94c271f] text-[#c94c27]`}>{issue.code}</span>
                <span className="min-w-0 flex-1">{issue.message}</span>
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
        <section className="flex flex-col gap-[10px]" data-testid="run-detail-approvals">
          <h2 className={SECTION_LABEL}>Waiting on you</h2>
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

      {outputs.length > 0 && (
        <section className="flex min-w-0 flex-col gap-[10px]" data-testid="run-detail-outputs">
          <h2 className={SECTION_LABEL}>Outputs</h2>
          <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
            {outputs.map(({ node, output }) => (
              <li
                key={node.id}
                data-testid={`run-detail-output-${node.id}`}
                className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[rgba(47,158,99,0.35)] bg-[var(--surface)]"
              >
                <span className="flex items-center gap-2 border-b border-[rgba(47,158,99,0.25)] bg-[rgba(47,158,99,0.10)] px-[14px] py-[10px] text-[13px] font-bold">
                  <span
                    aria-hidden
                    className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]"
                  />
                  {node.name}
                </span>
                <div className="flex min-w-0 flex-col gap-2 overflow-x-auto break-words px-[14px] py-[11px]">
                  {output.map((part, index) => (
                    <PartRenderer
                      key={index}
                      part={part}
                      contentUrl={(artifactId) => api().artifactContentUrl(artifactId)}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="min-w-0" data-testid="run-detail-trace">
        <TraceTab runId={run.data.id} />
      </section>

      <section className="flex flex-col gap-[10px]">
        <h2 className={SECTION_LABEL}>Snapshot · version {run.data.snapshot.version}</h2>
        <ul
          className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-0"
          data-testid="run-detail-nodes"
        >
          {run.data.snapshot.nodes.map((node) => {
            const nodeRun = stateByNodeId.get(node.id);
            return (
              <li
                key={node.id}
                data-testid={`run-detail-node-${node.id}`}
                data-state={nodeRun?.status ?? 'IDLE'}
                className="flex min-h-[36px] min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line)] px-[14px] py-[7px] text-[12.5px] first:border-t-0"
              >
                <StatusRing state={nodeRun?.status ?? 'IDLE'} showLabel />
                <span className="min-w-0 truncate font-semibold">{node.name}</span>
                <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>
                  {node.kind}
                </span>
                {nodeRun?.modelUsed && (
                  <span className="font-machine text-[11px] text-[var(--muted)]">
                    {nodeRun.modelUsed.modelId}
                    {nodeRun.modelUsed.viaFallback ? ' (fallback)' : ''}
                  </span>
                )}
                <span className="ml-auto font-machine text-[11px] text-[var(--muted)]">
                  {nodeRun
                    ? `${nodeRun.usage.tokensIn}↓ ${nodeRun.usage.tokensOut}↑ ${costText(nodeRun.usage, (value) => `$${value.toFixed(4)}`)}`
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
