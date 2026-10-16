import type {
  DomainUsageSnapshot,
  FailureReason,
  HaltReason,
  Id,
  NodeState,
  RunState,
} from '@ace/contracts';
import { useMemo } from 'react';

import { useRunStore } from '../runs/run-store';

/**
 * PG-3.3: Domain reads a run's node states and tokens from the one run overlay every mode reads
 * (`useRunStore`), not from its own copy — so Ideate, Forge, Domain and the footer agree on the
 * same run. The engine's usage snapshot (D306, D313) still brings what only it knows: the budget,
 * the activity lines, the per-turn bars, the costs and the estimate markers.
 */
export interface DomainRunOverlay {
  /** The overlay holds this run: its numbers below are the run's own. */
  held: boolean;
  status: RunState | undefined;
  /** PG-4.2: why the run halted, once it has. */
  haltReason: HaltReason | undefined;
  /** PG-4.2: each FAILED node's reason, from its newest node run. */
  failureReasons: ReadonlyMap<Id, FailureReason>;
  states: Readonly<Record<Id, NodeState>>;
  /** Each node's tokens over every node run of it in this run. */
  tokens: ReadonlyMap<Id, { in: number; out: number }>;
  totals: { in: number; out: number } | undefined;
}

const EMPTY: DomainRunOverlay = {
  held: false,
  status: undefined,
  haltReason: undefined,
  failureReasons: new Map(),
  states: {},
  tokens: new Map(),
  totals: undefined,
};

export function useDomainRunOverlay(runId: Id | undefined): DomainRunOverlay {
  // `run:revision` — a string, so the selector is stable between frames that touch nothing
  const key = useRunStore((store) =>
    runId !== undefined && store.runId === runId ? `${runId}:${store.revision}` : '',
  );
  return useMemo(() => {
    if (key === '') return EMPTY;
    const store = useRunStore.getState();
    const states: Record<Id, NodeState> = {};
    const tokens = new Map<Id, { in: number; out: number }>();
    const failureReasons = new Map<Id, FailureReason>();
    for (const nodeRun of store.nodeRuns()) {
      // the newest node run of each node decides its state, as on the Canvas
      states[nodeRun.nodeId] = store.nodeState(nodeRun.nodeId);
      const reason = store.nodeRun(nodeRun.nodeId)?.failureReason;
      if (reason !== undefined) failureReasons.set(nodeRun.nodeId, reason);
      const sum = tokens.get(nodeRun.nodeId) ?? { in: 0, out: 0 };
      tokens.set(nodeRun.nodeId, {
        in: sum.in + nodeRun.usage.tokensIn,
        out: sum.out + nodeRun.usage.tokensOut,
      });
    }
    return {
      held: true,
      status: store.status,
      haltReason: store.haltReason,
      failureReasons,
      states,
      tokens,
      totals:
        store.totals === undefined
          ? undefined
          : { in: store.totals.tokensIn, out: store.totals.tokensOut },
    };
  }, [key]);
}

/**
 * The Team aside's numbers with the overlay's node states and tokens laid over the snapshot's
 * (PG-3.3). Without the overlay holding the run, the snapshot is shown as the engine sent it.
 */
export function withRunOverlay(
  usage: DomainUsageSnapshot | null,
  overlay: DomainRunOverlay,
): DomainUsageSnapshot | null {
  if (usage === null || !overlay.held) return usage;
  return {
    ...usage,
    total:
      overlay.totals === undefined
        ? usage.total
        : { ...usage.total, input: overlay.totals.in, output: overlay.totals.out },
    perNode: usage.perNode.map((node) => {
      const tokens = overlay.tokens.get(node.nodeId);
      return {
        ...node,
        state: overlay.states[node.nodeId] ?? node.state,
        ...(tokens === undefined ? {} : { input: tokens.in, output: tokens.out }),
      };
    }),
  };
}
