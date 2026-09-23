import { z } from 'zod';

import {
  FailureReasonSchema,
  HaltReasonSchema,
  NodeStateSchema,
  ProviderStateSchema,
} from './enums.js';
import { PartSchema } from './envelope.js';
import { IdSchema, TimestampSchema } from './graph.js';
import { ModelUsedSchema, NodeErrorSchema, RunSummarySchema, UsageSchema } from './runs.js';

/**
 * The event log and the run events that ride the WebSocket (round 2 §2.4, FR-EXE-014, Arch §20.3).
 *
 * Every event but one is persisted with a global monotonic `seq`, which is what `resume
 * { afterSeq }` replays from. `node.token` is the exception: it is a transient stream frame, so
 * it carries no `seq` and is never written down — a reconnecting client rebuilds the text from
 * the `node.output` that follows.
 */

/** The global event sequence: monotonic, append-only, the anchor for `resume` (round 1 §2.9). */
export const SeqSchema = z.number().int().min(0);

/** One row of the append-only log; what `GET /runs/:id/events?afterSeq=` returns. */
export const EventSchema = z.object({
  seq: SeqSchema,
  at: TimestampSchema,
  runId: IdSchema.optional(),
  workflowId: IdSchema.optional(),
  type: z.string().min(1),
  payload: z.unknown(),
});
export type Event = z.infer<typeof EventSchema>;

/** `GET /runs/:id/events?afterSeq=` — the same anchor `resume` uses (§2.5, FR-EXE-014). */
export const EventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Payloads (§2.4)                                                             */
/* -------------------------------------------------------------------------- */

/** A run ends in exactly one of three states — `RUNNING` is not an ending (BR-03). */
export const TERMINAL_RUN_STATES = ['COMPLETE', 'HALTED', 'BLOCKED'] as const;
export const TerminalRunStateSchema = z.enum(TERMINAL_RUN_STATES);
export type TerminalRunState = z.infer<typeof TerminalRunStateSchema>;

/** Long enough to say what moved, short enough for an edge label (FR-EXE-015). */
export const EDGE_TRANSFER_SUMMARY_MAX = 120;

const PartsByNodeIdSchema = z.record(IdSchema, z.array(PartSchema));

export const RunStartedPayloadSchema = z.strictObject({ run: RunSummarySchema });
export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;

export const RunCompletedPayloadSchema = z.strictObject({
  runId: IdSchema,
  status: TerminalRunStateSchema,
  haltReason: HaltReasonSchema.optional(),
  totals: UsageSchema,
  finalOutput: PartsByNodeIdSchema.optional(),
});
export type RunCompletedPayload = z.infer<typeof RunCompletedPayloadSchema>;

export const NodeStatePayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  nodeId: IdSchema,
  iteration: z.number().int().min(1),
  attempt: z.number().int().min(1),
  status: NodeStateSchema,
  failureReason: FailureReasonSchema.optional(),
});
export type NodeStatePayload = z.infer<typeof NodeStatePayloadSchema>;

/** Batched roughly every 50 ms by the executor, so one frame is several model tokens. */
export const NodeTokenPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  delta: z.string(),
});
export type NodeTokenPayload = z.infer<typeof NodeTokenPayloadSchema>;

export const NodeOutputPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  nodeId: IdSchema,
  output: z.array(PartSchema),
  usage: UsageSchema,
  modelUsed: ModelUsedSchema.optional(),
});
export type NodeOutputPayload = z.infer<typeof NodeOutputPayloadSchema>;

export const NodeErrorPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  nodeId: IdSchema,
  error: NodeErrorSchema,
  failureReason: FailureReasonSchema,
});
export type NodeErrorPayload = z.infer<typeof NodeErrorPayloadSchema>;

export const EdgeTransferPayloadSchema = z.strictObject({
  runId: IdSchema,
  edgeId: IdSchema,
  fromNodeId: IdSchema,
  toNodeId: IdSchema,
  iteration: z.number().int().min(1),
  summary: z.string().max(EDGE_TRANSFER_SUMMARY_MAX),
});
export type EdgeTransferPayload = z.infer<typeof EdgeTransferPayloadSchema>;

export const UsageUpdatedPayloadSchema = z.strictObject({
  runId: IdSchema,
  totals: UsageSchema,
});
export type UsageUpdatedPayload = z.infer<typeof UsageUpdatedPayloadSchema>;

export const ProviderStatusPayloadSchema = z.strictObject({
  providerId: IdSchema,
  status: ProviderStateSchema,
  message: z.string().optional(),
});
export type ProviderStatusPayload = z.infer<typeof ProviderStatusPayloadSchema>;

/* -------------------------------------------------------------------------- */
/* Frames                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Frames are strict: a key the contract does not name is drift, and on this seam drift is how a
 * `seq` would quietly appear on `node.token` or a message list on a payload (BR-02).
 */
const persistedFrame = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), payload, seq: SeqSchema });

const transientFrame = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), payload });

export const RUN_EVENT_FRAME_SCHEMAS = [
  persistedFrame('run.started', RunStartedPayloadSchema),
  persistedFrame('run.completed', RunCompletedPayloadSchema),
  persistedFrame('node.state', NodeStatePayloadSchema),
  transientFrame('node.token', NodeTokenPayloadSchema),
  persistedFrame('node.output', NodeOutputPayloadSchema),
  persistedFrame('node.error', NodeErrorPayloadSchema),
  persistedFrame('edge.transfer', EdgeTransferPayloadSchema),
  persistedFrame('usage.updated', UsageUpdatedPayloadSchema),
] as const;

export const ENGINE_EVENT_FRAME_SCHEMAS = [
  persistedFrame('provider.status', ProviderStatusPayloadSchema),
] as const;

/** Server → client, run scope (§2.4). */
export const RunEventSchema = z.discriminatedUnion('type', RUN_EVENT_FRAME_SCHEMAS);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Server → client, engine scope (§2.4). */
export const EngineEventSchema = z.discriminatedUnion('type', ENGINE_EVENT_FRAME_SCHEMAS);
export type EngineEvent = z.infer<typeof EngineEventSchema>;

/* -------------------------------------------------------------------------- */
/* Type lists                                                                  */
/* -------------------------------------------------------------------------- */

export const RUN_EVENT_TYPES = [
  'run.started',
  'run.completed',
  'node.state',
  'node.token',
  'node.output',
  'node.error',
  'edge.transfer',
  'usage.updated',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const ENGINE_EVENT_TYPES = ['provider.status'] as const;
export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

/** Not persisted, no `seq`, never replayed by `resume` (§2.4). */
export const TRANSIENT_EVENT_TYPES = ['node.token'] as const;
export type TransientEventType = (typeof TRANSIENT_EVENT_TYPES)[number];

export type PersistedRunEventType = Exclude<RunEventType, TransientEventType>;

const isTransient = (type: RunEventType): type is TransientEventType =>
  (TRANSIENT_EVENT_TYPES as readonly RunEventType[]).includes(type);

export const PERSISTED_RUN_EVENT_TYPES = RUN_EVENT_TYPES.filter(
  (type): type is PersistedRunEventType => !isTransient(type),
);
