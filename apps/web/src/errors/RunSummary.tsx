import { NODE_STATES, type BudgetHalt, type HaltReason, type NodeState } from '@ace/contracts';

import { HaltReasonNote } from '../runs/controls/HaltReason';

/**
 * How a run ended, counted by node state (FR-ERR-007, TC-ERR-008).
 *
 * The point of this component is one number that must never be wrong: **failures are FAILED nodes
 * and nothing else**. A node the operator stopped is STOPPED and a node the run never reached is
 * BLOCKED (Arch §19.1); folding either into "failed" would tell the operator something broke when
 * nothing did.
 */

/** Enough of a node run to count; both the live overlay's view and a `NodeRun` record satisfy it. */
export interface CountableNodeRun {
  status: NodeState;
}

/** Every state with its count — zero included, so a caller can render a fixed row of chips. */
export function countByState(
  nodeRuns: readonly CountableNodeRun[],
): Readonly<Record<NodeState, number>> {
  const counts = Object.fromEntries(NODE_STATES.map((state) => [state, 0])) as Record<
    NodeState,
    number
  >;
  for (const nodeRun of nodeRuns) counts[nodeRun.status] += 1;
  return counts;
}

/** FR-ERR-007: FAILED is the only state that counts as a failure. */
export function failureCount(nodeRuns: readonly CountableNodeRun[]): number {
  return countByState(nodeRuns).FAILED;
}

export interface RunSummaryProps {
  nodeRuns: readonly CountableNodeRun[];
  /** Set when the run is HALTED, so the summary can say why in words (FR-GRD-008). */
  haltReason?: HaltReason;
  budgetHalt?: BudgetHalt;
}

/** The counted outcome of a run, failures and stops kept apart (FR-ERR-007, TC-ERR-008). */
export function RunSummary({ nodeRuns, haltReason, budgetHalt }: RunSummaryProps) {
  const counts = countByState(nodeRuns);
  const chips: Array<{ state: NodeState; label: string; count: number }> = [
    { state: 'COMPLETED', label: 'completed', count: counts.COMPLETED },
    { state: 'FAILED', label: 'failed', count: counts.FAILED },
    { state: 'STOPPED', label: 'stopped', count: counts.STOPPED },
    { state: 'BLOCKED', label: 'blocked', count: counts.BLOCKED },
  ];

  return (
    <section
      data-testid="run-summary"
      data-failed={counts.FAILED}
      data-stopped={counts.STOPPED}
      data-blocked={counts.BLOCKED}
      className="flex flex-col gap-2"
    >
      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li
            key={chip.state}
            data-testid={`run-summary-${chip.label}`}
            className="rounded-chip border border-border bg-card px-2 py-0.5 font-machine text-xs text-fg-muted"
          >
            {chip.count} {chip.label}
          </li>
        ))}
      </ul>
      {haltReason && (
        <HaltReasonNote reason={haltReason} {...(budgetHalt === undefined ? {} : { budgetHalt })} />
      )}
    </section>
  );
}
