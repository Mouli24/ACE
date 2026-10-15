import type { DayTotals, HealthMetrics, UsageQuery, UsageResponse } from '@ace/contracts';

import type { Repository, Scope, UsageRepository } from '../ports/index.js';
import { sumUsage } from '../runs/cost.js';
import { healthMetrics } from './health.js';

export { healthMetrics } from './health.js';

/**
 * Usage and health read models (round 5 §2.6, FR-OBS-002, FR-OBS-004, FR-OBS-007). The repository
 * folds node runs with D234's semantics; this passes the parsed query through and shapes the answer.
 */
export interface UsageService {
  usage(query: UsageQuery): Promise<UsageResponse>;
  dayTotals(day: string): Promise<DayTotals>;
  health(): Promise<HealthMetrics>;
}

/** The repository's usage port, which is optional on `Repository` until a store implements it. */
export function requireUsageRepository(repository: Pick<Repository, 'usage'>): UsageRepository {
  if (repository.usage === undefined) {
    throw new Error('The repository does not implement the usage port (UsageRepository).');
  }
  return repository.usage;
}

export function createUsageService(deps: { usage: UsageRepository; scope: Scope }): UsageService {
  return {
    usage: (query) => deps.usage.aggregate(deps.scope, query),
    /** PG-4.3: the day's node runs and its direct chat, together, with the chat part said apart. */
    async dayTotals(day) {
      const runs = await deps.usage.dayTotals(deps.scope, day);
      const chat = await deps.usage.chatDayTotals?.(deps.scope, day);
      if (chat === undefined || (chat.tokensIn === 0 && chat.tokensOut === 0 && chat.costUsd === 0)) {
        return { day, totals: runs };
      }
      return { day, totals: sumUsage([runs, chat]), chat };
    },
    health: () => healthMetrics(deps.usage, deps.scope),
  };
}
