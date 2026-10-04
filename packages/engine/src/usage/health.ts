import { ERROR_KINDS, type HealthMetrics } from '@ace/contracts';

import type { Scope, UsageRepository } from '../ports/index.js';

/**
 * Health metrics (FR-OBS-007, F10): the repository counts, and this makes sure every `ErrorKind`
 * is named, at 0 when nothing failed that way (D234).
 */
export async function healthMetrics(usage: UsageRepository, scope: Scope): Promise<HealthMetrics> {
  const counts = await usage.healthCounts(scope);
  const nodeFailuresByKind = Object.fromEntries(
    ERROR_KINDS.map((kind) => [kind, counts.nodeFailuresByKind[kind] ?? 0]),
  ) as HealthMetrics['nodeFailuresByKind'];

  return { ...counts, nodeFailuresByKind };
}
