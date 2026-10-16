import { z } from 'zod';

import { PartSchema } from './envelope.js';
import { RunStateSchema, HaltReasonSchema } from './enums.js';
import { EntityNameSchema, IdSchema, TimestampSchema } from './graph.js';
import { ModelUsedSchema, UsageSchema } from './runs.js';

/**
 * ACE Bench (PG-5.6, FR-BEN-001..008, Arch §20.2, `docs/team-prompts/ace-bench-plan.md`).
 *
 * One question: does this workflow do better than one model doing the same job alone, with the
 * same tools? Tasks are frozen before they are measured, outputs are judged blind, and the rule
 * that turns scores into an outcome is written down before the first run and locked at start.
 *
 * The minimum has exactly two arms: `workflow` (arm A, the workflow as snapshotted at start) and
 * `baseline` (arm B, one Agent node generated from A — never saved as a workflow).
 */

/* -------------------------------------------------------------------------- */
/* Tasks (FR-BEN-001, FR-BEN-002)                                              */
/* -------------------------------------------------------------------------- */

export const BENCH_TASK_STATUSES = ['draft', 'frozen'] as const;
export const BenchTaskStatusSchema = z.enum(BENCH_TASK_STATUSES);
export type BenchTaskStatus = z.infer<typeof BenchTaskStatusSchema>;

/** A SHA-256, lower-case hex. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest');

/** The prompt a task gives every Input node, and the rubric the human judge reads. */
export const BENCH_PROMPT_MAX = 20_000;
export const BENCH_RUBRIC_MAX = 20_000;

/**
 * A benchmark task: a prompt, its input values (text and artifact references, as `Part`s) and a
 * free-text rubric for the human judge. A draft is editable; a frozen task is immutable and its
 * content hash — SHA-256 over the canonical JSON of `{ name, prompt, inputs, rubric }` — is stored
 * (FR-BEN-002, TC-BEN-001).
 */
export const BenchTaskSchema = z.strictObject({
  id: IdSchema,
  name: EntityNameSchema,
  prompt: z.string().min(1).max(BENCH_PROMPT_MAX),
  inputs: z.array(PartSchema),
  rubric: z.string().max(BENCH_RUBRIC_MAX),
  status: BenchTaskStatusSchema,
  /** Set at freeze, never after. */
  contentHash: Sha256HexSchema.optional(),
  frozenAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BenchTask = z.infer<typeof BenchTaskSchema>;

/** `POST /bench/tasks` → 201 `BenchTask` (a draft). */
export const CreateBenchTaskRequestSchema = z.strictObject({
  name: EntityNameSchema,
  prompt: z.string().trim().min(1).max(BENCH_PROMPT_MAX),
  inputs: z.array(PartSchema).default(() => []),
  rubric: z.string().max(BENCH_RUBRIC_MAX).default(''),
});
export type CreateBenchTaskRequest = z.input<typeof CreateBenchTaskRequestSchema>;

/** `PATCH /bench/tasks/:id` → `BenchTask`. A frozen task answers 409 `bench_task_frozen`. */
export const UpdateBenchTaskRequestSchema = z.strictObject({
  name: EntityNameSchema.optional(),
  prompt: z.string().trim().min(1).max(BENCH_PROMPT_MAX).optional(),
  inputs: z.array(PartSchema).optional(),
  rubric: z.string().max(BENCH_RUBRIC_MAX).optional(),
});
export type UpdateBenchTaskRequest = z.infer<typeof UpdateBenchTaskRequestSchema>;

/** `GET /bench/tasks` → `{ items }`, newest first. */
export const BenchTaskListResponseSchema = z.strictObject({
  items: z.array(BenchTaskSchema),
});
export type BenchTaskListResponse = z.infer<typeof BenchTaskListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Arms and the pre-registered rule (FR-BEN-003, FR-BEN-007)                   */
/* -------------------------------------------------------------------------- */

/** Arm A is the workflow; arm B the single-node baseline generated from it. */
export const BENCH_ARMS = ['workflow', 'baseline'] as const;
export const BenchArmSchema = z.enum(BENCH_ARMS);
export type BenchArm = z.infer<typeof BenchArmSchema>;

/** Repetitions per task and arm: 1 to 10 (owner's decision on the plan, 2026-10-16). */
export const BENCH_REPETITIONS_MIN = 1;
export const BENCH_REPETITIONS_MAX = 10;
export const BenchRepetitionsSchema = z
  .number()
  .int()
  .min(BENCH_REPETITIONS_MIN)
  .max(BENCH_REPETITIONS_MAX);

/** Arm B's model: a provider and one of its catalogued models. */
export const BenchModelRefSchema = z.strictObject({
  providerId: IdSchema,
  modelId: z.string().min(1),
});
export type BenchModelRef = z.infer<typeof BenchModelRefSchema>;

/**
 * Written at creation and locked at start (FR-BEN-007, TC-BEN-006). `notes` are the free-text
 * pre-registered expectations; `threshold` is the one number the report applies, in score units:
 * with `diff = mean(workflow) − mean(baseline)`, `diff ≥ threshold` is a **win** for the workflow,
 * `diff ≤ −threshold` a **loss**, anything between a **partial**.
 */
export const BenchRulesSchema = z.strictObject({
  notes: z.string().max(BENCH_RUBRIC_MAX),
  threshold: z.number().positive().finite(),
});
export type BenchRules = z.infer<typeof BenchRulesSchema>;

export const BENCH_OUTCOMES = ['win', 'partial', 'loss'] as const;
export const BenchOutcomeSchema = z.enum(BENCH_OUTCOMES);
export type BenchOutcome = z.infer<typeof BenchOutcomeSchema>;

/** Applies the locked rule: one function for the engine's report and anything that previews it. */
export function benchOutcome(
  meanWorkflow: number,
  meanBaseline: number,
  threshold: number,
): BenchOutcome {
  const diff = meanWorkflow - meanBaseline;
  if (diff >= threshold) return 'win';
  if (diff <= -threshold) return 'loss';
  return 'partial';
}

/* -------------------------------------------------------------------------- */
/* Bench runs (FR-BEN-004, FR-BEN-008)                                         */
/* -------------------------------------------------------------------------- */

export const BENCH_RUN_STATUSES = [
  'planned',
  'running',
  'waiting_approval',
  'done',
  'skipped',
] as const;
export const BenchRunStatusSchema = z.enum(BENCH_RUN_STATUSES);
export type BenchRunStatus = z.infer<typeof BenchRunStatusSchema>;

/** The prompt one node run sent: its version and a hash of its text (the text is on the node run). */
export const BenchPromptRecordSchema = z.strictObject({
  nodeId: IdSchema,
  version: z.string().min(1),
  textHash: Sha256HexSchema,
});
export type BenchPromptRecord = z.infer<typeof BenchPromptRecordSchema>;

/**
 * What a finished bench run recorded (FR-BEN-004, TC-BEN-003): its output, tokens, cost, time, the
 * models used, the workflow snapshot (version and hash — the snapshot itself is the run's, BR-04),
 * every prompt sent, and the engine build. Written once when the run ends.
 */
export const BenchRunRecordSchema = z.strictObject({
  runStatus: RunStateSchema,
  haltReason: HaltReasonSchema.optional(),
  output: z.array(PartSchema),
  usage: UsageSchema,
  durationMs: z.number().int().min(0),
  models: z.array(ModelUsedSchema),
  workflowSnapshot: z.strictObject({
    version: z.number().int().min(0),
    hash: Sha256HexSchema,
    nodeCount: z.number().int().min(0),
  }),
  prompts: z.array(BenchPromptRecordSchema),
  buildVersion: z.string().min(1),
});
export type BenchRunRecord = z.infer<typeof BenchRunRecordSchema>;

/** One planned run of an experiment: listed up front (FR-BEN-003), linked to its run once queued. */
export const BenchRunSchema = z.strictObject({
  id: IdSchema,
  experimentId: IdSchema,
  taskId: IdSchema,
  arm: BenchArmSchema,
  /** 1-based. */
  rep: z.number().int().min(1).max(BENCH_REPETITIONS_MAX),
  /** Position in the queue, 0-based: runs go one at a time in this order. */
  order: z.number().int().min(0),
  status: BenchRunStatusSchema,
  runId: IdSchema.optional(),
  record: BenchRunRecordSchema.optional(),
  /** The judge's score, once imported (FR-BEN-006). */
  score: z.number().finite().optional(),
  scoreNote: z.string().optional(),
});
export type BenchRun = z.infer<typeof BenchRunSchema>;

/** What `Run.benchExperimentId` points at: the link the normal run history filters out (FR-BEN-008). */
export const BenchRunLinkSchema = z.strictObject({
  experimentId: IdSchema,
  taskId: IdSchema,
  arm: BenchArmSchema,
  rep: z.number().int().min(1),
});
export type BenchRunLink = z.infer<typeof BenchRunLinkSchema>;

/* -------------------------------------------------------------------------- */
/* Experiments (FR-BEN-003, FR-BEN-007)                                        */
/* -------------------------------------------------------------------------- */

/**
 * `draft` — editable; `running` — queue going; `waiting_approval` — a bench run asked a person and
 * the queue waits for the answer (never auto-answered); `complete` — every planned run ended;
 * `interrupted` — the engine stopped while it ran (restart does not resume a bench, it reports).
 */
export const BENCH_EXPERIMENT_STATUSES = [
  'draft',
  'running',
  'waiting_approval',
  'complete',
  'interrupted',
] as const;
export const BenchExperimentStatusSchema = z.enum(BENCH_EXPERIMENT_STATUSES);
export type BenchExperimentStatus = z.infer<typeof BenchExperimentStatusSchema>;

/** The approval a bench run is waiting on, so the bench page can send the person to it. */
export const BenchPendingApprovalSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
});
export type BenchPendingApproval = z.infer<typeof BenchPendingApprovalSchema>;

export const BenchExperimentSchema = z.strictObject({
  id: IdSchema,
  name: EntityNameSchema,
  /** Arm A: this workflow, snapshotted at start. */
  workflowId: IdSchema,
  projectId: IdSchema,
  taskIds: z.array(IdSchema).min(1),
  repetitions: BenchRepetitionsSchema,
  /**
   * Arm B's model. Defaults at creation to the strongest model arm A uses; the person may change it
   * until start. Absent only when arm A names no model at all (start then refuses).
   */
  baselineModel: BenchModelRefSchema.optional(),
  rules: BenchRulesSchema,
  status: BenchExperimentStatusSchema,
  /** Every planned run, tasks × arms × repetitions, in queue order (FR-BEN-003, TC-BEN-002). */
  runs: z.array(BenchRunSchema),
  pendingApproval: BenchPendingApprovalSchema.optional(),
  /** Set at start: from then on the rules and the plan are locked (FR-BEN-007). */
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BenchExperiment = z.infer<typeof BenchExperimentSchema>;

/** `POST /bench/experiments` → 201 `BenchExperiment`. Every task must be frozen. */
export const CreateBenchExperimentRequestSchema = z.strictObject({
  name: EntityNameSchema,
  workflowId: IdSchema,
  taskIds: z.array(IdSchema).min(1),
  repetitions: BenchRepetitionsSchema,
  baselineModel: BenchModelRefSchema.optional(),
  rules: BenchRulesSchema,
});
export type CreateBenchExperimentRequest = z.infer<typeof CreateBenchExperimentRequestSchema>;

/**
 * `PATCH /bench/experiments/:id` → `BenchExperiment`, while `draft` only. After start every edit —
 * the rules above all — answers 409 `bench_experiment_locked` (FR-BEN-007, TC-BEN-006).
 */
export const UpdateBenchExperimentRequestSchema = z.strictObject({
  name: EntityNameSchema.optional(),
  taskIds: z.array(IdSchema).min(1).optional(),
  repetitions: BenchRepetitionsSchema.optional(),
  baselineModel: BenchModelRefSchema.optional(),
  rules: BenchRulesSchema.optional(),
});
export type UpdateBenchExperimentRequest = z.infer<typeof UpdateBenchExperimentRequestSchema>;

/** `GET /bench/experiments` → `{ items }`, newest first. */
export const BenchExperimentListResponseSchema = z.strictObject({
  items: z.array(BenchExperimentSchema),
});
export type BenchExperimentListResponse = z.infer<typeof BenchExperimentListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Blind export and scores (FR-BEN-005, FR-BEN-006)                            */
/* -------------------------------------------------------------------------- */

/** A random label: what the judge sees in place of the arm, node, model and provider. */
export const BenchLabelSchema = z.string().regex(/^[A-Z2-9]{8}$/, 'must be an 8-character label');

/**
 * `GET /bench/experiments/:id/blind-export`. Only finished runs with an output are in it, shuffled,
 * each under a random label; arm, node, model, provider and run ids are stripped. The label → run
 * key stays in the engine (TC-BEN-004).
 */
export const BlindExportSchema = z.strictObject({
  exportedAt: TimestampSchema,
  experimentName: EntityNameSchema,
  tasks: z.array(
    z.strictObject({
      taskId: IdSchema,
      name: EntityNameSchema,
      prompt: z.string(),
      inputs: z.array(PartSchema),
      rubric: z.string(),
    }),
  ),
  items: z.array(
    z.strictObject({
      label: BenchLabelSchema,
      taskId: IdSchema,
      output: z.array(PartSchema),
    }),
  ),
});
export type BlindExport = z.infer<typeof BlindExportSchema>;

export const BenchScoreSchema = z.strictObject({
  label: BenchLabelSchema,
  score: z.number().finite(),
  note: z.string().max(BENCH_RUBRIC_MAX).optional(),
});
export type BenchScore = z.infer<typeof BenchScoreSchema>;

/**
 * `POST /bench/experiments/:id/scores`: the judge's scores as JSON rows, or as CSV text with a
 * `label,score,note` header. A label imported again replaces its earlier score.
 */
export const ImportBenchScoresRequestSchema = z.union([
  z.strictObject({ scores: z.array(BenchScoreSchema).min(1) }),
  z.strictObject({ csv: z.string().min(1).max(1_000_000) }),
]);
export type ImportBenchScoresRequest = z.infer<typeof ImportBenchScoresRequestSchema>;

export const ImportBenchScoresResponseSchema = z.strictObject({
  imported: z.number().int().min(0),
  /** Labels in the import that this experiment never exported. Nothing is stored for them. */
  unknownLabels: z.array(z.string()),
});
export type ImportBenchScoresResponse = z.infer<typeof ImportBenchScoresResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Report (FR-BEN-007)                                                         */
/* -------------------------------------------------------------------------- */

export const BenchArmReportSchema = z.strictObject({
  arm: BenchArmSchema,
  runs: z.number().int().min(0),
  scored: z.number().int().min(0),
  /** Absent until at least one of the arm's runs on this task is scored. */
  meanScore: z.number().finite().optional(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: z.number().min(0),
  /** Mean wall time per finished run. */
  meanDurationMs: z.number().min(0).optional(),
});
export type BenchArmReport = z.infer<typeof BenchArmReportSchema>;

export const BenchTaskReportSchema = z.strictObject({
  taskId: IdSchema,
  taskName: EntityNameSchema,
  arms: z.array(BenchArmReportSchema),
  /** mean(workflow) − mean(baseline), once both are scored. */
  difference: z.number().finite().optional(),
  /** The locked rule applied, once both arms are scored. */
  outcome: BenchOutcomeSchema.optional(),
});
export type BenchTaskReport = z.infer<typeof BenchTaskReportSchema>;

/** `GET /bench/experiments/:id/report`: computed on read from the stored scores and locked rules. */
export const BenchReportSchema = z.strictObject({
  experimentId: IdSchema,
  generatedAt: TimestampSchema,
  rules: BenchRulesSchema,
  baselineModel: BenchModelRefSchema.optional(),
  tasks: z.array(BenchTaskReportSchema),
  summary: z.strictObject({
    win: z.number().int().min(0),
    partial: z.number().int().min(0),
    loss: z.number().int().min(0),
    /** Tasks without scores on both arms yet. */
    pending: z.number().int().min(0),
  }),
});
export type BenchReport = z.infer<typeof BenchReportSchema>;
