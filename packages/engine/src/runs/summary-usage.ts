import type { Id, Usage } from '@ace/contracts';

import { sumUsage } from './cost.js';

/**
 * What summarising a node's inputs cost, carried until that node's run is recorded (F5). Keyed by
 * run and target node so concurrent runs never share an entry; a run's entries are dropped when it
 * ends, so nothing accumulates for ever.
 */
export interface SummaryUsageLedger {
  add(runId: Id, nodeId: Id, usage: Usage): void;
  /** Returns what has accumulated for the node and clears it. */
  take(runId: Id, nodeId: Id): Usage | undefined;
  dropRun(runId: Id): void;
}

export function createSummaryUsageLedger(): SummaryUsageLedger {
  const entries = new Map<Id, Map<Id, Usage>>();
  return {
    add(runId, nodeId, usage) {
      const forRun = entries.get(runId) ?? new Map<Id, Usage>();
      const carried = forRun.get(nodeId);
      forRun.set(nodeId, carried === undefined ? usage : sumUsage([carried, usage]));
      entries.set(runId, forRun);
    },
    take(runId, nodeId) {
      const forRun = entries.get(runId);
      const carried = forRun?.get(nodeId);
      forRun?.delete(nodeId);
      return carried;
    },
    dropRun(runId) {
      entries.delete(runId);
    },
  };
}
