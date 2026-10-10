import type {
  DomainCost,
  DomainUsageSnapshot,
  Id,
  PricingTable,
  UsageSource,
} from '@ace/contracts';

import type { EngineEvent } from '../ports/index.js';
import type { DomainContext } from './context.js';
import { costOfTurn, sumCosts } from './pricing.js';
import { createDomainProjection, type DomainProjection } from './projection.js';

/**
 * The run's usage as Domain shows it (D306, D313): every turn's tokens with where they came from,
 * totals per node and for the run, the share that is estimated, the budget, and the cost — the
 * provider's own report where there is one, else an estimate from `ace.pricing.json`, else null.
 * The tokens are Track's tokens: they come from the same `usage.updated` events.
 */

type SourceMix = 'reported' | 'estimated' | 'mixed';

function mixOf(sources: readonly UsageSource[]): SourceMix | null {
  const distinct = new Set(sources);
  if (distinct.size === 0) return null;
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined ? only : 'mixed';
}

/** The snapshot from a projection that has already folded the run's events. */
export function usageSnapshot(
  projection: DomainProjection,
  context: DomainContext,
  pricing: PricingTable,
): DomainUsageSnapshot {
  const turns = projection.turnUsage().map((turn) => ({
    ...turn,
    source: turn.usage.source ?? ('reported' as const),
    cost: costOfTurn(turn.usage, pricing, turn.providerType, turn.modelIds),
  }));

  const input = turns.reduce((sum, turn) => sum + turn.usage.tokensIn, 0);
  const output = turns.reduce((sum, turn) => sum + turn.usage.tokensOut, 0);
  const cachedInput = turns.reduce((sum, turn) => sum + (turn.usage.cachedTokensIn ?? 0), 0);
  const estimated = turns
    .filter((turn) => turn.source === 'estimated')
    .reduce((sum, turn) => sum + turn.usage.tokensIn + turn.usage.tokensOut, 0);
  const used = input + output;

  const limit = projection.budgetLimit();
  const states = projection.nodeStates();

  const perNode = context.roster.map((entry) => {
    const mine = turns.filter((turn) => turn.nodeId === entry.nodeId);
    const nodeIn = mine.reduce((sum, turn) => sum + turn.usage.tokensIn, 0);
    const nodeOut = mine.reduce((sum, turn) => sum + turn.usage.tokensOut, 0);
    const cost: DomainCost | null =
      mine.length === 0 ? null : sumCosts(mine.map((turn) => turn.cost));
    return {
      nodeId: entry.nodeId,
      handle: entry.handle,
      name: entry.name,
      brain: entry.brain,
      state: states[entry.nodeId] ?? 'IDLE',
      activity: projection.activity(entry.nodeId),
      input: nodeIn,
      output: nodeOut,
      source: mixOf(mine.map((turn) => turn.source)),
      costEst: cost,
      budgetShare: limit === null ? null : (nodeIn + nodeOut) / limit,
    };
  });

  return {
    runId: context.runId,
    budget:
      limit === null
        ? null
        : {
            limit,
            used,
            level: used >= limit ? 'EXCEEDED' : used >= limit * 0.8 ? 'WARN' : 'OK',
          },
    total: { input, output, cachedInput, estimatedShare: used === 0 ? 0 : estimated / used },
    costEst: sumCosts(turns.map((turn) => turn.cost)),
    perNode,
    perTurn: turns.map((turn) => ({
      turnId: turn.nodeRunId as Id,
      nodeId: turn.nodeId,
      input: turn.usage.tokensIn,
      output: turn.usage.tokensOut,
      source: turn.source,
      costEst: turn.cost,
    })),
  };
}

/** `projectUsage(events, pricing) → UsageSnapshot` (D303): pure, from the event log alone. */
export function projectUsage(
  events: readonly EngineEvent[],
  context: DomainContext,
  pricing: PricingTable,
): DomainUsageSnapshot {
  const projection = createDomainProjection(context);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) projection.apply(event);
  return usageSnapshot(projection, context, pricing);
}
