import { z } from 'zod';

import {
  ErrorKindSchema,
  FailureReasonSchema,
  HaltReasonSchema,
  NodeStateSchema,
  RunStateSchema,
} from './enums.js';
import { EnvelopeSchema, PartSchema } from './envelope.js';
import { EdgeSchema, IdSchema, NodeSchema, TimestampSchema } from './graph.js';
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
  /** `Verdict` arrives in round 3 and `ToolCall` in round 4; both lists exist from now. */
  verdicts: z.array(z.unknown()),
  toolCalls: z.array(z.unknown()),
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type NodeRun = z.infer<typeof NodeRunSchema>;

/* -------------------------------------------------------------------------- */
/* Starting a run                                                              */
/* -------------------------------------------------------------------------- */

/** `POST /workflows/:id/runs`. `startFromNodeId` is honoured from round 3 (FR-EXE-013). */
export const StartRunRequestSchema = z.object({
  inputs: PartsByNodeIdSchema.optional(),
  startFromNodeId: IdSchema.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
