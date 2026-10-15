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
  BudgetUsdSchema,
  EdgeSchema,
  IdSchema,
  LoopStopReasonSchema,
  NodeSchema,
  TimestampSchema,
} from './graph.js';
import {
  BlockedReasonSchema,
  MESSAGE_TEXT_MAX,
  RunDomainConfigInputSchema,
  RunDomainConfigSchema,
  TurnTriggerSchema,
  UsageSourceSchema,
  type BlockedReason,
} from './domain.js';
import { ApprovalDecisionSchema, GuardrailPolicyRefSchema, VerdictSchema } from './guardrails.js';
import { NodeRunSourceSchema } from './knowledge.js';
import { MemoryOpSchema } from './memory.js';
import { ToolCallSchema } from './tools.js';
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
  /**
   * D313: whether the token counts came from the provider's own output or were estimated
   * (characters ÷ 4). Absent on usage recorded before Domain, which was always the provider's.
   */
  source: UsageSourceSchema.optional(),
  /** D306: where `costUsd` came from — the provider's own report, or the catalog's price table. */
  costSource: z.enum(['reported', 'catalog']).optional(),
  /**
   * PG-1.4 (D359): `false` when the model has no price — an unpriced remote model, whose spend is
   * unknown and must never read as $0. Absent or `true`: `costUsd` is the cost (a local model's is 0
   * by rule).
   */
  costKnown: z.boolean().optional(),
  /** D313: the part of `tokensIn` read from a prompt cache; `tokensIn` already includes it. */
  cachedTokensIn: z.number().int().min(0).optional(),
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

export const RUN_ACTIONS = ['pause', 'resume', 'stop', 'restart', 'end'] as const;
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
export function allowedRunActions(
  status: RunState,
  context: { blockedReason?: BlockedReason | undefined; stayOpen?: boolean | undefined } = {},
): RunAction[] {
  // D305: a run blocked mid-run waits to be resumed; one blocked at pre-flight can only restart.
  const actions: RunAction[] =
    status === 'BLOCKED' && context.blockedReason !== undefined
      ? ['resume', 'stop']
      : [...ALLOWED_RUN_ACTIONS[status]];
  // D323: a run started from Domain stays open until the human ends it. D360: it can be restarted
  // while open too — the engine ends it first, then starts the new run.
  const live = status === 'RUNNING' || status === 'PAUSED' || actions.includes('resume');
  if (context.stayOpen === true && live) actions.push('restart', 'end');
  return actions;
}

/* -------------------------------------------------------------------------- */
/* Budget halts (round 3 §2.3, FR-GRD-008, D80)                                */
/* -------------------------------------------------------------------------- */

/** Which cap tripped: the project's per-run cap, or the day's budget from the settings. */
export const BUDGET_SCOPES = ['run', 'daily'] as const;
export const BudgetScopeSchema = z.enum(BUDGET_SCOPES);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

/**
 * Why a run halted `budget_exceeded`, as it stood at that moment — the cap can change afterwards —
 * so the run view can say "budget exceeded: $0.012 > $0.01 cap" and which cap to raise
 * (NFR-USE-03). `costUsd` is what was compared with the cap: the run's total for `run`, the day's
 * for `daily`, plus the next node's projected cost when `projected` (the halt came before a
 * dispatch, so the run may have spent less than `costUsd`).
 */
export const BudgetHaltSchema = z.strictObject({
  scope: BudgetScopeSchema,
  capUsd: BudgetUsdSchema,
  costUsd: z.number().min(0),
  projected: z.boolean(),
});
export type BudgetHalt = z.infer<typeof BudgetHaltSchema>;

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
   * Optional until round 3's engine and UI have both merged; a later contracts PR requires it
   * (D71).
   */
  allowedActions: z.array(RunActionSchema).optional(),
  pausedAt: TimestampSchema.optional(),
  /** Set on the new run a restart creates: same snapshot, same inputs (FR-CTL-004). */
  restartedFromRunId: IdSchema.optional(),
  /**
   * PG-5.4: set on the new run a replay creates (`POST /runs/:id/replay`) — the run whose recorded
   * node outputs it was answered from. Same snapshot and inputs as that run, zero provider calls.
   */
  replayOf: IdSchema.optional(),
  /** Set only when `haltReason` is `budget_exceeded` (D80). */
  budgetHalt: BudgetHaltSchema.optional(),
  /** D305: why a run is BLOCKED mid-run. Absent on a run blocked at pre-flight. */
  blockedReason: BlockedReasonSchema.optional(),
  /** D312: the run's Domain settings. Absent on runs from before Domain. */
  domain: RunDomainConfigSchema.optional(),
  /** D312: the goal the run was started with — its first message, read by every node. */
  goal: z.string().optional(),
  /**
   * PG-5.6 (FR-BEN-008): set on a run ACE Bench queued — the experiment it belongs to. The normal
   * run history, the timeline and Domain leave such a run out; only the bench opens it.
   */
  benchExperimentId: IdSchema.optional(),
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
  replayOf: true,
  benchExperimentId: true,
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
  /**
   * The model the provider reports actually answered — what `modelId` (often an alias such as
   * `opus`) resolved to. Absent when the provider does not say.
   */
  resolvedModelId: z.string().min(1).optional(),
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
  /** Every tool this node run called, in order, with its verdicts (round 4 §2.2, FR-TOOL-009). */
  toolCalls: z.array(ToolCallSchema),
  /**
   * Each approval decision with its time (FR-GRD-013). Optional until round 3's engine and UI
   * have both merged; a later contracts PR requires it (D71).
   */
  approvals: z.array(ApprovalDecisionSchema).optional(),
  /** The policy, at the version, this node run was checked against (FR-GRD-002). */
  guardrailPolicy: GuardrailPolicyRefSchema.optional(),
  /** On a loop's last iteration: why the loop stopped (§2.4). */
  loopStop: LoopStopReasonSchema.optional(),
  /**
   * Round 5 §2.4: the knowledge-base chunks this node run's context used, best first
   * (FR-RAG-007). `droppedSources` are chunks the search found that did not fit the context budget
   * (§4 item 7). `memoryOps` are the `__memory` ops this node run applied, in order (§2.2,
   * FR-MEM-002). All three are optional until A5 and M5 have both merged (D71); absent reads as
   * none.
   */
  sources: z.array(NodeRunSourceSchema).optional(),
  droppedSources: z.array(NodeRunSourceSchema).optional(),
  memoryOps: z.array(MemoryOpSchema).optional(),
  /**
   * Set when Start from node copied this node run from an earlier run instead of executing it:
   * the node run whose output it carries. Usage is zero, and nothing was called (FR-EXE-013, D83).
   */
  reusedFromNodeRunId: IdSchema.optional(),
  /** D309: why this turn started — a dispatch, an envelope, or the human's instruction. */
  trigger: TurnTriggerSchema.optional(),
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
  /** D312: the run's goal. Every node reads it in `## Team goal`; it is the run's first message. */
  goal: z.string().trim().min(1).max(MESSAGE_TEXT_MAX).optional(),
  /** D312: Domain settings. Omitted, a run is supervised, has no budget and ends as it always has. */
  domain: RunDomainConfigInputSchema.optional(),
  /**
   * PG-2.4 (D361): the person chose "Run without undo" after a run was BLOCKED with
   * `checkpoint_unavailable`. One-time: only this run goes ahead when its checkpoint cannot begin,
   * and `run.started` records the choice.
   */
  withoutUndo: z.boolean().optional(),
});
/** What a caller may send: the Domain settings it leaves out take their defaults (D312). */
export type StartRunRequest = z.input<typeof StartRunRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Retries (round 3 §2.1, FR-ERR-003..005, Arch §28)                           */
/* -------------------------------------------------------------------------- */

/**
 * `POST /node-runs/:id/retry` → the new `NodeRun`: attempt + 1 with the same inputs (FR-ERR-003),
 * and with `withDownstream` everything reachable after it runs again too (FR-ERR-004).
 */
export const RetryRequestSchema = z.object({ withDownstream: z.boolean() });
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

/**
 * `POST /runs/:id/nodes/:nodeId/rerun` → the new `NodeRun`: that node alone, on the latest
 * upstream outputs (FR-CTL-005).
 */
export const RerunRequestSchema = z.object({});
export type RerunRequest = z.infer<typeof RerunRequestSchema>;

export const AUTO_RETRY_MODES = ['backoff', 'contract_repair', 'never'] as const;
export type AutoRetryMode = (typeof AUTO_RETRY_MODES)[number];

/**
 * What the engine does by itself after a failure of each kind (§2.1, FR-ERR-005). Every automatic
 * retry is a new node run with attempt + 1. `backoff` retries up to `execution.retries` times,
 * waiting from `RETRY_BACKOFF_BASE_MS` and doubling each time up to `RETRY_BACKOFF_MAX_MS` — §2.1
 * writes it `500 ms · 2^attempt`; A3 pins the exponent and any jitter in DECISIONS.md, as the round
 * 3 exit gate asks. `contract_repair` retries once with the validation reason appended to the
 * prompt, after which CONTRACT_VIOLATION stands. Nothing else is retried.
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
