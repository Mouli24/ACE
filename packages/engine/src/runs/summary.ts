import type { Run, RunSummary } from '@ace/contracts';

/** One row of the run history (FR-EXE-012) — everything but the snapshot and the parts. */
export function toSummary(run: Run): RunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    totals: run.totals,
    // FR-BEN-008: a live `run.started` tells a client this run belongs to the bench, not the history.
    ...(run.benchExperimentId === undefined ? {} : { benchExperimentId: run.benchExperimentId }),
  };
}
