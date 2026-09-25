import { z } from 'zod';

import {
  ErrorKindSchema,
  FailureReasonSchema,
  HaltReasonSchema,
  NodeStateSchema,
  RunStateSchema,
  type ErrorKind,
  type RunState,
} from './enums.js';
import { EnvelopeSchema, PartSchema } from './envelope.js';
import {
  EdgeSchema,
  IdSchema,
  LoopStopReasonSchema,
  NodeSchema,
  TimestampSchema,
} from './graph.js';
import { ApprovalDecisionSchema, GuardrailPolicyRefSchema, VerdictSchema } from './guardrails.js';
import { ValidationIssueSchema } from './validation.js';

/**
 * Runs and node runs (round 2 §2.3, FR-EXE-001..015, FR-OBS-002/003, BR-03, BR-04, Arch §19.2).
 *
 * A run is a recording: the snapshot it executed, the inputs it was given, what every node run
 * did and what it cost. Nothing here is edited after the fact — the snapshot is written once with
 * the run row (BR-04) and the price table version travels with the estimate (FR-OBS-003).
 */

/* -------------------------------------------------------------------------- */
/* Usage                                                                       */
/* -------------------------------------------------------------------------- */

export const UsageSchema = z.object({
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: z.number().min(0),
  /** Absent only where nothing was spent — a priced node run always names its table version. */
  priceTableVersion: z.string().min(1).optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ZERO_USAGE: Usage = Object.freeze({ tokensIn: 0, tokensOut: 0, costUsd: 0 });

/** A fresh zeroed total — never share one object between two runs. */
export const zeroUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });

/* -------------------------------------------------------------------------- */
/* Errors on a node run (Arch §28)                                             */
/* -------------------------------------------------------------------------- */

export const NodeErrorSchema = z.object({
  kind: ErrorKindSchema,
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  providerId: IdSchema.optional(),
  details: z.unknown().optional(),
});
export type NodeError = z.infer<typeof NodeErrorSchema>;

/* -------------------------------------------------------------------------- */
/* Run controls (round 3 §2.1, FR-CTL-001..006)                                */
/* -------------------------------------------------------------------------- */

export const RUN_ACTIONS = ['pause', 'resume', 'stop', 'restart'] as const;
export const RunActionSchema = z.enum(RUN_ACTIONS);
export type RunAction = z.infer<typeof RunActionSchema>;

const ALLOWED_RUN_ACTIONS: Readonly<Record<RunState, readonly RunAction[]>> = {
  PREFLIGHT: [],
  RUNNING: ['pause', 'stop'],
  PAUSED: ['resume', 'stop'],
  COMPLETE: ['restart'],
  BLOCKED: ['restart'],
  HALTED: ['restart'],
};

/**
 * The controls a run in this state accepts: what the engine writes into `Run.allowedActions`, and
 * outside of which it answers 409 `invalid_run_state` (FR-CTL-006). One table for the engine and
 * the web mocks (D76). Stop is allowed while paused because nodes that were running when the run
 * paused may still be finishing; restart is allowed from any ending, and starts a new run.
 */
export function allowedRunActions(status: RunState): RunAction[] {
  return [...ALLOWED_RUN_ACTIONS[status]];
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

/** Written once, in the same transaction as the run row, and never updated (BR-04, FR-NODE-009). */
export const RunSnapshotSchema = z.object({
  version: z.number().int().min(0),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

/** Parts keyed by node id: the inputs given at start, and the final output per Output node. */
const PartsByNodeIdSchema = z.record(IdSchema, z.array(PartSchema));

export const RunSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  projectId: IdSchema,
  status: RunStateSchema,
  haltReason: HaltReasonSchema.optional(),
  snapshot: RunSnapshotSchema,
  inputs: PartsByNodeIdSchema,
  /** Populated when pre-flight refused the run; the run is still recorded (FR-EXE-003). */
  preflightIssues: z.array(ValidationIssueSchema),
  totals: UsageSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
  finalOutput: PartsByNodeIdSchema.optional(),
  /**
   * `allowedRunActions(status)`, written by the engine so the UI never guesses (FR-CTL-006).
   * Optional until round 3's engine and UI have both merged; a later contracts PR requires it (D71).
   */
  allowedActions: z.array(RunActionSchema).optional(),
  pausedAt: TimestampSchema.optional(),
  /** Set on the new run a restart creates: same snapshot, same inputs (FR-CTL-004). */
  restartedFromRunId: IdSchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;

/** One row of the run history (FR-EXE-012) — everything but the snapshot and the parts. */
export const RunSummarySchema = RunSchema.pick({
  id: true,
  workflowId: true,
  status: true,
  haltReason: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  totals: true,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/* -------------------------------------------------------------------------- */
/* Node run                                                                    */
/* -------------------------------------------------------------------------- */

/** What the router actually picked, and whether it had to walk the fallback chain (FR-RTR-006). */
export const ModelUsedSchema = z.object({
  providerId: IdSchema,
  modelId: z.string().min(1),
  viaFallback: z.boolean(),
});
export type ModelUsed = z.infer<typeof ModelUsedSchema>;

/** The prompt exactly as sent, with secrets redacted, plus its version (FR-PRM-004/005). */
export const NodeRunPromptSchema = z.object({
  version: z.string().min(1),
  text: z.string(),
});
export type NodeRunPrompt = z.infer<typeof NodeRunPromptSchema>;

export const NodeRunSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  iteration: z.number().int().min(1),
  attempt: z.number().int().min(1),
  status: NodeStateSchema,
  failureReason: FailureReasonSchema.optional(),
  error: NodeErrorSchema.optional(),
  modelUsed: ModelUsedSchema.optional(),
  inputEnvelopes: z.array(EnvelopeSchema),
  output: z.array(PartSchema).optional(),
  prompt: NodeRunPromptSchema.optional(),
  usage: UsageSchema,
  /** Every guardrail verdict on this node run, stored and emitted (FR-GRD-015). */
  verdicts: z.array(VerdictSchema),
  /** `ToolCall` arrives in round 4; the list exists from now. */
  toolCalls: z.array(z.unknown()),
  /**
   * Each approval decision with its time (FR-GRD-013). Optional until round 3's engine and UI
   * have both merged; a later contracts PR requires it (D71).
   */
  approvals: z.array(ApprovalDecisionSchema).optional(),
  /** The policy, at the version, this node run was checked against (FR-GRD-002). */
  guardrailPolicy: GuardrailPolicyRefSchema.optional(),
  /** On a loop's last iteration: why the loop stopped (§2.4). */
  loopStop: LoopStopReasonSchema.optional(),
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type NodeRun = z.infer<typeof NodeRunSchema>;

/* -------------------------------------------------------------------------- */
/* Starting a run                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `POST /workflows/:id/runs`. From round 3 `startFromNodeId` is honoured: the node runs upstream
 * of it in the workflow's latest run are reused, not re-called (FR-EXE-013).
 */
export const StartRunRequestSchema = z.object({
  inputs: PartsByNodeIdSchema.optional(),
  startFromNodeId: IdSchema.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Retries (round 3 §2.1, FR-ERR-003..005, Arch §28)                           */
/* -------------------------------------------------------------------------- */

/**
 * `POST /node-runs/:id/retry` → the new `NodeRun`: attempt + 1 with the same inputs (FR-ERR-003),
 * and with `withDownstream` everything reachable after it runs again too (FR-ERR-004).
 */
export const RetryRequestSchema = z.object({ withDownstream: z.boolean() });
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

/** `POST /runs/:id/nodes/:nodeId/rerun` → that node alone, on the latest upstream outputs (FR-CTL-005). */
export const RerunRequestSchema = z.object({});
export type RerunRequest = z.infer<typeof RerunRequestSchema>;

export const AUTO_RETRY_MODES = ['backoff', 'contract_repair', 'never'] as const;
export type AutoRetryMode = (typeof AUTO_RETRY_MODES)[number];

/**
 * What the engine does by itself after a failure of each kind (§2.1, FR-ERR-005). Every automatic
 * retry is a new node run with attempt + 1. `backoff` waits `500 ms · 2^attempt`, capped at 8 s,
 * up to `execution.retries` times; `contract_repair` retries once with the validation reason
 * appended to the prompt, after which CONTRACT_VIOLATION stands. Nothing else is retried.
 */
export const AUTO_RETRY_POLICY: Readonly<Record<ErrorKind, AutoRetryMode>> = Object.freeze({
  user_cancelled: 'never',
  agent: 'contract_repair',
  provider: 'backoff',
  auth: 'never',
  network: 'backoff',
  invalid_config: 'never',
  workflow: 'never',
  guardrail: 'never',
});

export const RETRY_BACKOFF_BASE_MS = 500;
export const RETRY_BACKOFF_MAX_MS = 8_000;
export const CONTRACT_REPAIR_RETRIES = 1;
