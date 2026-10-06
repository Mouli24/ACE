import { z } from 'zod';

import {
  FailureReasonSchema,
  HaltReasonSchema,
  NodeStateSchema,
  ProviderStateSchema,
} from './enums.js';
import { ChatMessageSchema, MessageSchema } from './chat.js';
import { PartSchema } from './envelope.js';
import { IdSchema, LoopStopReasonSchema, TimestampSchema } from './graph.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema, VerdictSchema } from './guardrails.js';
import {
  BudgetHaltSchema,
  ModelUsedSchema,
  NodeErrorSchema,
  RunSummarySchema,
  UsageSchema,
} from './runs.js';
import { KbDocumentStatusSchema } from './knowledge.js';
import { MemoryOpSchema } from './memory.js';
import { TaskActivitySchema, TaskSchema } from './tasks.js';
import { McpServerStatusSchema, ToolCallSchema } from './tools.js';
import { DayTotalsSchema } from './usage.js';

/**
 * The event log and the events that ride the WebSocket (round 2 §2.4, round 3 §2.6,
 * round 4 §2.5, round 5 §2.8, FR-EXE-014, Arch §20.3).
 *
 * Almost every event is persisted with a global monotonic `seq`, which is what `resume
 * { afterSeq }` replays from. Two are not: `node.token` and round 4's `chat.token` are transient
 * stream frames, so they carry no `seq` and are never written down — a reconnecting client
 * rebuilds the text from the `node.output` or `chat.message` that follows. Round 3's six events
 * are all persisted; of round 4's five, four are; round 5's two are both persisted.
 *
 * Events come in three families, by the subscription they ride: run events on a `workflow`
 * subscription, thread events on a `thread` one (round 4 §2.5), engine events on `engine`.
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

export const RunStartedPayloadSchema = z.strictObject({
  run: RunSummarySchema,
});
export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;

export const RunCompletedPayloadSchema = z.strictObject({
  runId: IdSchema,
  status: TerminalRunStateSchema,
  haltReason: HaltReasonSchema.optional(),
  totals: UsageSchema,
  finalOutput: PartsByNodeIdSchema.optional(),
  /** Round 3: set only when `haltReason` is `budget_exceeded` (D80). */
  budgetHalt: BudgetHaltSchema.optional(),
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

/**
 * A run's running totals. From round 5 the one emitted when a run completes also carries the day's
 * totals across every run, for the top bar (§2.8, FR-OBS-002); the ones emitted mid-run do not.
 */
export const UsageUpdatedPayloadSchema = z.strictObject({
  runId: IdSchema,
  totals: UsageSchema,
  dayTotals: DayTotalsSchema.optional(),
});
export type UsageUpdatedPayload = z.infer<typeof UsageUpdatedPayloadSchema>;

export const ProviderStatusPayloadSchema = z.strictObject({
  providerId: IdSchema,
  status: ProviderStateSchema,
  message: z.string().optional(),
});
export type ProviderStatusPayload = z.infer<typeof ProviderStatusPayloadSchema>;

/* Round 3 §2.6 — all persisted. `run.completed` may now halt `stopped` or `budget_exceeded`. */

/** No new dispatch; nodes already running finish (FR-CTL-001, D4). */
export const RunPausedPayloadSchema = z.strictObject({ runId: IdSchema });
export type RunPausedPayload = z.infer<typeof RunPausedPayloadSchema>;

/** Dispatch continues where the run paused (FR-CTL-002). */
export const RunResumedPayloadSchema = z.strictObject({ runId: IdSchema });
export type RunResumedPayload = z.infer<typeof RunResumedPayloadSchema>;

/** An `ask_user` check put a node in WAITING; the card shows this request (FR-GRD-013). */
export const NodeApprovalRequiredPayloadSchema = z.strictObject({
  runId: IdSchema,
  request: ApprovalRequestSchema,
});
export type NodeApprovalRequiredPayload = z.infer<typeof NodeApprovalRequiredPayloadSchema>;

export const NodeApprovalDecidedPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  decision: ApprovalDecisionSchema,
});
export type NodeApprovalDecidedPayload = z.infer<typeof NodeApprovalDecidedPayloadSchema>;

/** Every verdict is emitted as well as stored on its node run (FR-GRD-015). */
export const GuardrailVerdictPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  verdict: VerdictSchema,
});
export type GuardrailVerdictPayload = z.infer<typeof GuardrailVerdictPayloadSchema>;

/**
 * Without `stop`: a loop edge re-queued its target, and `iteration` is the iteration the target now
 * starts (2, 3, …). With `stop`: nothing was re-queued — the loop ended after `iteration`, the last
 * one run, for that reason (§2.4).
 */
export const LoopIterationPayloadSchema = z.strictObject({
  runId: IdSchema,
  edgeId: IdSchema,
  targetNodeId: IdSchema,
  iteration: z.number().int().min(1),
  stop: LoopStopReasonSchema.optional(),
});
export type LoopIterationPayload = z.infer<typeof LoopIterationPayloadSchema>;

/* Round 4 §2.5 — four persisted, one transient. */

/** One logged tool call, as it happened (FR-TOOL-009, TC-TOOL-010). */
export const ToolCallPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  toolCall: ToolCallSchema,
});
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

/** A new row of the workflow's timeline (FR-CHAT-001); it rides the workflow subscription. */
export const MessageCreatedPayloadSchema = z.strictObject({
  workflowId: IdSchema,
  message: MessageSchema,
});
export type MessageCreatedPayload = z.infer<typeof MessageCreatedPayloadSchema>;

/**
 * A finished turn of a direct chat — the reply the `chat.token` deltas were building, or a blocked
 * one (FR-CHAT-006, FR-CHAT-008). Persisted, but on the thread, never on a run (FR-CHAT-005).
 */
export const ChatMessagePayloadSchema = z.strictObject({
  threadId: IdSchema,
  message: ChatMessageSchema,
});
export type ChatMessagePayload = z.infer<typeof ChatMessagePayloadSchema>;

/** Batched like `node.token`, and transient for the same reason (FR-CHAT-006). */
export const ChatTokenPayloadSchema = z.strictObject({
  threadId: IdSchema,
  delta: z.string(),
});
export type ChatTokenPayload = z.infer<typeof ChatTokenPayloadSchema>;

/** An MCP server came up, went away, or changed how many tools it offers (FR-TOOL-007, D16). */
export const McpStatusPayloadSchema = z.strictObject({
  serverId: IdSchema,
  status: McpServerStatusSchema,
  toolCount: z.number().int().min(0),
});
export type McpStatusPayload = z.infer<typeof McpStatusPayloadSchema>;

/* Round 5 §2.8 — both persisted. */

/**
 * A knowledge-base document moved through ingestion (FR-RAG-003, Arch §21.3): one at every stage,
 * and a last one at `ready` or `failed`. `progress` is the share of the whole pipeline done, 0..1;
 * `error` is the reason, set only on `failed`. A base belongs to a project, not a workflow, so this
 * rides the engine subscription, as `provider.status` does (D230).
 */
export const KbIngestPayloadSchema = z.strictObject({
  knowledgeBaseId: IdSchema,
  documentId: IdSchema,
  status: KbDocumentStatusSchema,
  progress: z.number().min(0).max(1).optional(),
  error: z.string().min(1).optional(),
});
export type KbIngestPayload = z.infer<typeof KbIngestPayloadSchema>;

/**
 * An agent's memory changed (FR-MEM-002, FR-MEM-004): its own `__memory` ops after a node run,
 * or the user's deletes — a clear is one `delete` per key. A delete belongs to no run, and every
 * member of the run family is part of a run's event log, so this rides the engine subscription
 * beside `kb.ingest`; an open Memory tab keeps the frames whose `nodeId` it shows (D230).
 */
export const MemoryUpdatedPayloadSchema = z.strictObject({
  nodeId: IdSchema,
  ops: z.array(MemoryOpSchema).min(1),
});
export type MemoryUpdatedPayload = z.infer<typeof MemoryUpdatedPayloadSchema>;

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
  persistedFrame('run.paused', RunPausedPayloadSchema),
  persistedFrame('run.resumed', RunResumedPayloadSchema),
  persistedFrame('node.approval_required', NodeApprovalRequiredPayloadSchema),
  persistedFrame('node.approval_decided', NodeApprovalDecidedPayloadSchema),
  persistedFrame('guardrail.verdict', GuardrailVerdictPayloadSchema),
  persistedFrame('loop.iteration', LoopIterationPayloadSchema),
  persistedFrame('tool.call', ToolCallPayloadSchema),
  persistedFrame('message.created', MessageCreatedPayloadSchema),
] as const;

/**
 * Round 4 §2.5's chat frames. Their own family, because they ride the new `thread` subscription
 * and a direct chat belongs to no run (FR-CHAT-005) — putting `chat.token` among the run events
 * would also make `PERSISTED_RUN_EVENT_TYPES` shorter by a type no run ever sees.
 */
export const THREAD_EVENT_FRAME_SCHEMAS = [
  persistedFrame('chat.message', ChatMessagePayloadSchema),
  transientFrame('chat.token', ChatTokenPayloadSchema),
] as const;

/**
 * ACE parity P0: a task changed — its stage, state, plan, workspace or anything else on the card —
 * with the activity row that says why, when there is one. Rides the engine subscription, as the
 * board shows every project's tasks without subscribing per task.
 */
export const TaskUpdatedPayloadSchema = z.strictObject({
  task: TaskSchema,
  activity: TaskActivitySchema.optional(),
});
export type TaskUpdatedPayload = z.infer<typeof TaskUpdatedPayloadSchema>;

/** A task was deleted; the board drops its card. */
export const TaskDeletedPayloadSchema = z.strictObject({
  taskId: IdSchema,
  projectId: IdSchema,
});
export type TaskDeletedPayload = z.infer<typeof TaskDeletedPayloadSchema>;

export const ENGINE_EVENT_FRAME_SCHEMAS = [
  persistedFrame('provider.status', ProviderStatusPayloadSchema),
  persistedFrame('mcp.status', McpStatusPayloadSchema),
  persistedFrame('kb.ingest', KbIngestPayloadSchema),
  persistedFrame('memory.updated', MemoryUpdatedPayloadSchema),
  persistedFrame('task.updated', TaskUpdatedPayloadSchema),
  persistedFrame('task.deleted', TaskDeletedPayloadSchema),
] as const;

/** Server → client, run scope (round 2 §2.4, round 3 §2.6, round 4 §2.5). */
export const RunEventSchema = z.discriminatedUnion('type', RUN_EVENT_FRAME_SCHEMAS);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Server → client, thread scope (round 4 §2.5). */
export const ThreadEventSchema = z.discriminatedUnion('type', THREAD_EVENT_FRAME_SCHEMAS);
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

/** Server → client, engine scope (§2.4, round 4 §2.5, round 5 §2.8). */
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
  'run.paused',
  'run.resumed',
  'node.approval_required',
  'node.approval_decided',
  'guardrail.verdict',
  'loop.iteration',
  'tool.call',
  'message.created',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const THREAD_EVENT_TYPES = ['chat.message', 'chat.token'] as const;
export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

export const ENGINE_EVENT_TYPES = [
  'provider.status',
  'mcp.status',
  'kb.ingest',
  'memory.updated',
  'task.updated',
  'task.deleted',
] as const;
export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

/** Not persisted, no `seq`, never replayed by `resume` (§2.4, round 4 §2.5). */
export const TRANSIENT_EVENT_TYPES = ['node.token', 'chat.token'] as const;
export type TransientEventType = (typeof TRANSIENT_EVENT_TYPES)[number];

export type PersistedRunEventType = Exclude<RunEventType, TransientEventType>;
export type PersistedThreadEventType = Exclude<ThreadEventType, TransientEventType>;

const isTransient = (type: RunEventType | ThreadEventType): type is TransientEventType =>
  (TRANSIENT_EVENT_TYPES as readonly string[]).includes(type);

export const PERSISTED_RUN_EVENT_TYPES = RUN_EVENT_TYPES.filter(
  (type): type is PersistedRunEventType => !isTransient(type),
);

/** The same derivation for the thread family: `chat.message` is kept, `chat.token` is not. */
export const PERSISTED_THREAD_EVENT_TYPES = THREAD_EVENT_TYPES.filter(
  (type): type is PersistedThreadEventType => !isTransient(type),
);
