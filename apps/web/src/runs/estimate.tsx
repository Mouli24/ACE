import type { CostRange, Node, NodeEstimate, WorkflowEstimate } from '@ace/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../app/api';
import { useWorkflowGraph } from '../workflows/hooks';

/**
 * PG-4.3: what a run could cost, before it starts. One `POST /workflows/:id/estimate` per graph
 * version — the key carries the version, so an edit fetches a fresh one and a render never does —
 * shared by the Run button, the start dialog and every node card.
 */

export const estimateRootKey = ['workflow-estimate'] as const;

export function useWorkflowEstimate(workflowId: string | undefined) {
  const version = useWorkflowGraph(workflowId).data?.workflow.version;
  return useQuery({
    queryKey: [...estimateRootKey, workflowId ?? '', version ?? -1] as const,
    queryFn: () => api().estimateWorkflow(workflowId ?? ''),
    enabled: Boolean(workflowId) && version !== undefined,
    // Today's spend moves with every run; the graph's part changes only with its version.
    staleTime: 30_000,
    retry: false,
  });
}

/** Node id → its estimate, for the cards (one object per estimate, so a card re-renders only then). */
export function useNodeEstimates(
  workflowId: string | undefined,
): ReadonlyMap<string, NodeEstimate> | undefined {
  const estimate = useWorkflowEstimate(workflowId).data;
  return useMemo(
    () =>
      estimate === undefined
        ? undefined
        : new Map(estimate.nodes.map((node) => [node.nodeId, node] as const)),
    [estimate],
  );
}

/** `$0.0023`, `$0.012`, `$1.25` — enough digits that a small cost does not read as $0. */
export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  if (usd < 1) return `$${Number(usd.toFixed(3))}`;
  return `$${usd.toFixed(2)}`;
}

/** A range as it reads: `≈ $0.002–0.01`, `≈ $0.01`, `free`, `?`, or a known part with `+ ?`. */
export function formatCostRange(range: CostRange & { free?: boolean | undefined }): string {
  if (range.free === true) return 'free';
  const known = range.maxUsd > 0 || range.minUsd > 0;
  if (range.unknown && !known) return '?';
  const low = money(range.minUsd);
  const high = money(range.maxUsd);
  const span = low === high ? `≈ ${high}` : `≈ ${low}–${high.replace(/^\$/, '')}`;
  return range.unknown ? `${span} + ?` : span;
}

const REASON: Readonly<Record<NonNullable<NodeEstimate['reason']>, string>> = {
  no_model: 'no model chosen',
  model_missing: 'model not in the catalogue',
  unpriced: 'no price for this model',
};

/** What is left before a cap trips: the run cap, or today's daily budget less today's spend. */
export function remainingBudget(estimate: WorkflowEstimate): number | undefined {
  const { maxCostPerRunUsd, dailyBudgetUsd, spentTodayUsd } = estimate.budget;
  const left = [
    maxCostPerRunUsd,
    dailyBudgetUsd === undefined ? undefined : Math.max(0, dailyBudgetUsd - spentTodayUsd),
  ].filter((value): value is number => value !== undefined);
  return left.length === 0 ? undefined : Math.min(...left);
}

/** The run could cost more than is left: worth asking before Start. */
export function overBudget(estimate: WorkflowEstimate): boolean {
  const left = remainingBudget(estimate);
  return left !== undefined && estimate.total.maxUsd > left;
}

/** One line for a tooltip: the estimate and what is left. */
export function estimateTitle(estimate: WorkflowEstimate): string {
  const left = remainingBudget(estimate);
  return `Estimated ${formatCostRange(estimate.total)}${
    left === undefined ? ' · no budget cap set' : ` · ${money(left)} left`
  }`;
}

/** The estimate and the budget it runs against, as the start dialog shows them (PG-4.3). */
export function EstimateSummary({
  estimate,
  nodes,
}: {
  estimate: WorkflowEstimate;
  nodes: readonly Pick<Node, 'id' | 'name'>[];
}) {
  const nameOf = (id: string) => nodes.find((node) => node.id === id)?.name ?? id;
  const unknown = estimate.nodes.filter((node) => node.unknown);
  const { maxCostPerRunUsd, dailyBudgetUsd, spentTodayUsd, spentTodayKnown } = estimate.budget;
  const over = overBudget(estimate);
  return (
    <section
      aria-label="Estimated cost"
      data-testid="run-estimate"
      className="flex flex-col gap-1.5 rounded-[9px] border border-[var(--line)] px-3 py-2.5 text-[12px]"
    >
      <p>
        Estimated cost:{' '}
        <span className="font-machine font-semibold" data-testid="run-estimate-total">
          {formatCostRange(estimate.total)}
        </span>
      </p>
      {unknown.length > 0 && (
        <p className="text-[var(--muted)]" data-testid="run-estimate-unknown">
          Unknown for{' '}
          {unknown
            .map((node) => `${nameOf(node.nodeId)} (${REASON[node.reason ?? 'unpriced']})`)
            .join(', ')}
          .
        </p>
      )}
      <p className="text-[var(--muted)]" data-testid="run-estimate-budget">
        {maxCostPerRunUsd === undefined && dailyBudgetUsd === undefined
          ? 'No run or daily budget set.'
          : [
              maxCostPerRunUsd === undefined ? undefined : `Run cap ${money(maxCostPerRunUsd)}`,
              dailyBudgetUsd === undefined
                ? undefined
                : `today ${money(spentTodayUsd)}${spentTodayKnown ? '' : ' + ?'} of ${money(
                    dailyBudgetUsd,
                  )} spent, ${money(Math.max(0, dailyBudgetUsd - spentTodayUsd))} left`,
            ]
              .filter(Boolean)
              .join(' · ')}
      </p>
      {over && (
        <p role="alert" className="text-danger" data-testid="run-estimate-over">
          At most this run could cost more than is left; it halts when a cap is reached.
        </p>
      )}
    </section>
  );
}
