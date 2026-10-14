import { z } from 'zod';

import { ErrorKindSchema } from './enums.js';
import type { PersistedRunEventType } from './events.js';
import { IdSchema, TimestampSchema } from './graph.js';
import { UsageSchema } from './runs.js';

/**
 * Usage, trace and health metrics (round 5 §2.6, FR-OBS-001, 002, 004, 007, Arch §26, §27).
 *
 * All three are read models over what the engine already records: usage folds node runs, the trace
 * folds the event log, and the health metrics count both. None of them is stored on its own, and
 * nothing here is ever sent anywhere but the local web app (NFR-PRIV-01).
 */

/* -------------------------------------------------------------------------- */
/* Usage (§2.6, FR-OBS-002, FR-OBS-004)                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a usage bucket can be keyed by. The key's value for each is: `provider` the provider id,
 * `model` the provider-side model id, `day` the UTC calendar date `YYYY-MM-DD` the node run started
 * on (the day the daily budget counts, round 3 §2.3), `workflow` the workflow id.
 */
export const USAGE_GROUP_BY = ['provider', 'model', 'day', 'workflow'] as const;
export const UsageGroupBySchema = z.enum(USAGE_GROUP_BY);
export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

/** A UTC calendar date, `YYYY-MM-DD`. */
export const UsageDaySchema = z.iso.date();

/**
 * `GET /usage?from&to&groupBy` (§2.6). `from` is inclusive and `to` exclusive, both against a node
 * run's start. `groupBy` arrives as a repeated query parameter, and a single value reads as a list
 * of one, as `MessageQuery.type` does; it names at least one grouping, none twice.
 */
export const UsageQuerySchema = z
  .object({
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    groupBy: z
      .union([z.array(UsageGroupBySchema), UsageGroupBySchema.transform((by) => [by])])
      .refine((list) => list.length > 0, 'name at least one of provider, model, day, workflow')
      .refine((list) => new Set(list).size === list.length, 'name each grouping once'),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) < Date.parse(query.to),
    { message: '`from` must be before `to`', path: ['to'] },
  );
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/**
 * One group of node runs. `key` holds one entry per `groupBy` grouping and nothing else, so a
 * bucket grouped by provider and day reads `{ provider: <id>, day: '2026-10-01' }`. `runs` counts
 * the distinct runs its node runs belong to. Only node runs that called a model are counted.
 */
export const UsageBucketSchema = z.strictObject({
  key: z.record(z.string(), z.string()),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: z.number().min(0),
  runs: z.number().int().min(0),
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

/**
 * `GET /usage` → `UsageResponse`. Buckets are ordered by key, grouping by grouping in `groupBy`
 * order, so the usage screen's table and the API compare row by row (TC-OBS-004). `totals` is the
 * exact sum of the buckets (FR-OBS-002).
 */
export const UsageResponseSchema = z.strictObject({
  buckets: z.array(UsageBucketSchema),
  totals: UsageSchema,
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

/**
 * One day's spend across every run (FR-OBS-002) — what `usage.updated` carries when a run completes,
 * for the top bar's day total (§2.8).
 */
export const DayTotalsSchema = z.strictObject({
  day: UsageDaySchema,
  totals: UsageSchema,
});
export type DayTotals = z.infer<typeof DayTotalsSchema>;

/* -------------------------------------------------------------------------- */
/* Trace (§2.6, FR-OBS-001)                                                    */
/* -------------------------------------------------------------------------- */

export const TRACE_ENTRY_KINDS = [
  'node_run',
  'tool_call',
  'verdict',
  'approval',
  'loop',
  'run_event',
] as const;
export const TraceEntryKindSchema = z.enum(TRACE_ENTRY_KINDS);
export type TraceEntryKind = z.infer<typeof TraceEntryKindSchema>;

/**
 * The kind of trace entry each persisted run event becomes (FR-OBS-001). One table, so the engine's
 * trace and the web app's mocks file an event under the same kind, and a run event added later
 * cannot be forgotten here: the `satisfies` fails until it is given a kind.
 */
export const TRACE_ENTRY_KIND_BY_EVENT_TYPE = {
  'run.started': 'run_event',
  'run.completed': 'run_event',
  'node.state': 'node_run',
  'node.output': 'node_run',
  'node.error': 'node_run',
  'edge.transfer': 'run_event',
  'usage.updated': 'run_event',
  'run.paused': 'run_event',
  'run.resumed': 'run_event',
  'node.approval_required': 'approval',
  'node.approval_decided': 'approval',
  'guardrail.verdict': 'verdict',
  'loop.iteration': 'loop',
  'tool.call': 'tool_call',
  'message.created': 'run_event',
  'human.message': 'run_event',
  'instruction.state': 'run_event',
  'envelope.sent': 'run_event',
  'envelope.routed': 'run_event',
  'node.interrupted': 'node_run',
  'run.token_budget': 'run_event',
  'run.config': 'run_event',
  'run.blocked': 'run_event',
  'run.parked': 'run_event',
  /* Debate (D352): the hub's own record; a turn is not a node run of its own. */
  'debate.started': 'run_event',
  'debate.round_started': 'run_event',
  'debate.turn_started': 'run_event',
  'debate.turn_completed': 'run_event',
  'debate.turn_failed': 'run_event',
  'debate.turn_violation': 'run_event',
  'debate.instruction_delivered': 'run_event',
  'debate.round_completed': 'run_event',
  'debate.control': 'run_event',
  'debate.stopped': 'run_event',
  'debate.verdict': 'run_event',
  'debate.failed': 'run_event',
} as const satisfies Record<PersistedRunEventType, TraceEntryKind>;

/**
 * One line of a run's trace. `seq` is the event's own, so the trace reads in exactly the event
 * log's order (FR-OBS-001, TC-OBS-001). `detail` is the event's payload, or what the entry folded
 * from it; `durationMs` is set where the entry spans time — a finished node run or tool call.
 */
export const TraceEntrySchema = z.strictObject({
  seq: z.number().int().min(0),
  at: TimestampSchema,
  kind: TraceEntryKindSchema,
  nodeId: IdSchema.optional(),
  nodeRunId: IdSchema.optional(),
  label: z.string().min(1),
  detail: z.unknown(),
  durationMs: z.number().int().min(0).optional(),
});
export type TraceEntry = z.infer<typeof TraceEntrySchema>;

/** `GET /runs/:id/trace` → a bare `TraceEntry[]`, ascending `seq` (§2.6, as D78 reads §2.5). */
export const TraceResponseSchema = z.array(TraceEntrySchema);
export type TraceResponse = z.infer<typeof TraceResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Health metrics (§2.6, FR-OBS-007)                                           */
/* -------------------------------------------------------------------------- */

const CountSchema = z.number().int().min(0);

export const LatencyPercentilesSchema = z.strictObject({
  p50: z.number().min(0),
  p95: z.number().min(0),
});
export type LatencyPercentiles = z.infer<typeof LatencyPercentilesSchema>;

/**
 * `GET /metrics/health` (FR-OBS-007, Arch §26). Every error kind is present, at 0 when nothing
 * failed that way. `providerLatencyMs` is keyed by provider id and holds only providers that have
 * been called; `guardrailVerdictsByType` is keyed by check type. `since` is the instant the counts
 * start from.
 */
export const HealthMetricsSchema = z.strictObject({
  runs: z.strictObject({
    started: CountSchema,
    completed: CountSchema,
    halted: CountSchema,
    blocked: CountSchema,
  }),
  nodeFailuresByKind: z.record(ErrorKindSchema, CountSchema),
  providerLatencyMs: z.record(IdSchema, LatencyPercentilesSchema),
  guardrailVerdictsByType: z.record(z.string(), CountSchema),
  since: TimestampSchema,
});
export type HealthMetrics = z.infer<typeof HealthMetricsSchema>;
