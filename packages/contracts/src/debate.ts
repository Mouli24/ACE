import { z } from 'zod';

import { FailureReasonSchema, type FailureReason } from './enums.js';
import { IdSchema } from './graph.js';
import { UsageSchema } from './runs.js';

/**
 * Debate (D340–D359): debater nodes argue a topic over a few rounds, a judge produces the verdict,
 * and the verdict flows downstream like any node output.
 *
 * Everything a debate is lives in the run's event log (D352). `foldDebate` is the one fold over
 * those events, so the engine, Domain, the Debate drawer and the eval script read the same record.
 */

/* -------------------------------------------------------------------------- */
/* Limits and small vocabularies                                               */
/* -------------------------------------------------------------------------- */

/** DB2's 2–5 debaters, DB3's 1–4 rounds, DB9's 2–8 options, DB4's 6000 shown, DB8's 100,000 read. */
export const DEBATE_LIMITS = {
  minDebaters: 2,
  maxDebaters: 5,
  minRounds: 1,
  maxRounds: 4,
  defaultRounds: 2,
  minOptions: 2,
  maxOptions: 8,
  shownReasoningMax: 6000,
  readsMaxChars: 100_000,
} as const;

/** What reasoning shown to anyone but its author ends with when it was cut (D343). */
export const DEBATE_TRUNCATED_MARKER = '[truncated]';

export const DEBATE_TOPIC_MAX = 20_000;
export const DEBATE_OPTION_MAX = 200;
export const DEBATE_STANCE_MAX = 2_000;
export const DEBATE_READ_PATH_MAX = 1_024;
export const DEBATE_READS_PER_DEBATER_MAX = 50;
/** The same bound Domain puts on a human message (D309). */
export const DEBATE_INSTRUCTION_MAX = 8_000;

/** DB6: debaters are A–E, in their order on the canvas, fixed for the whole debate. */
export const DEBATE_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export const DebateLabelSchema = z.enum(DEBATE_LABELS);
export type DebateLabel = z.infer<typeof DebateLabelSchema>;

export const DEBATE_ANSWER_FORMATS = ['free', 'choice'] as const;
export const DebateAnswerFormatSchema = z.enum(DEBATE_ANSWER_FORMATS);
export type DebateAnswerFormat = z.infer<typeof DebateAnswerFormatSchema>;

/** DB10. */
export const DEBATE_STOPPED_BY = [
  'max_rounds',
  'converged',
  'human_end',
  'budget',
  'failures',
] as const;
export const DebateStoppedBySchema = z.enum(DEBATE_STOPPED_BY);
export type DebateStoppedBy = z.infer<typeof DebateStoppedBySchema>;

/** D358: the human's controls, each recorded in the log. */
export const DEBATE_CONTROL_ACTIONS = ['pause_after_round', 'resume', 'judge_now'] as const;
export const DebateControlActionSchema = z.enum(DEBATE_CONTROL_ACTIONS);
export type DebateControlAction = z.infer<typeof DebateControlActionSchema>;

/** D358: the judge's two calls have ids too, so their failures can be named. */
export const DEBATE_JUDGE_CALL_IDS = ['judge', 'judge-openings'] as const;
export type DebateJudgeCallId = (typeof DEBATE_JUDGE_CALL_IDS)[number];

/** How a call came about: the turn itself, its one retry after a CLI failure, its one repair (DB11). */
export const DEBATE_CALL_KINDS = ['turn', 'retry', 'repair'] as const;
export const DebateCallKindSchema = z.enum(DEBATE_CALL_KINDS);
export type DebateCallKind = z.infer<typeof DebateCallKindSchema>;

/* -------------------------------------------------------------------------- */
/* Turn ids (DB6)                                                              */
/* -------------------------------------------------------------------------- */

const TURN_ID = /^R([0-4])-([A-E])$/;

export const DebateTurnIdSchema = z.string().regex(TURN_ID, 'must be a turn id like R0-A');
export type DebateTurnId = z.infer<typeof DebateTurnIdSchema>;

/** A turn id, or one of the judge's call ids. */
export const DebateCallIdSchema = z.union([DebateTurnIdSchema, z.enum(DEBATE_JUDGE_CALL_IDS)]);
export type DebateCallId = z.infer<typeof DebateCallIdSchema>;

/** The engine's turn id for one debater's turn in one round, e.g. `R2-C`. */
export function turnIdFor(round: number, label: DebateLabel): DebateTurnId {
  return `R${round}-${label}`;
}

export function parseDebateTurnId(id: string): { round: number; label: DebateLabel } | undefined {
  const match = TURN_ID.exec(id);
  if (match === null) return undefined;
  return { round: Number(match[1]), label: match[2] as DebateLabel };
}

export function isDebateTurnId(id: string): boolean {
  return TURN_ID.test(id);
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

const OptionSchema = z.string().trim().min(1).max(DEBATE_OPTION_MAX);

/** The hub's debate settings (D357). The judge is the hub's own provider. */
export const DebateHubConfigSchema = z
  .strictObject({
    topic: z.string().trim().min(1).max(DEBATE_TOPIC_MAX),
    answerFormat: DebateAnswerFormatSchema.default('free'),
    /** Required in choice mode, 2–8 options. */
    options: z
      .array(OptionSchema)
      .min(DEBATE_LIMITS.minOptions)
      .max(DEBATE_LIMITS.maxOptions)
      .optional(),
    maxRounds: z
      .number()
      .int()
      .min(DEBATE_LIMITS.minRounds)
      .max(DEBATE_LIMITS.maxRounds)
      .default(DEBATE_LIMITS.defaultRounds),
    earlyStop: z.boolean().default(true),
    /** Free mode only: the judge also runs once over the openings (DB9). */
    baselineJudge: z.boolean().default(true),
  })
  .superRefine((config, ctx) => {
    if (config.answerFormat === 'choice' && config.options === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `A choice debate needs ${DEBATE_LIMITS.minOptions}–${DEBATE_LIMITS.maxOptions} options.`,
      });
    }
    const seen = new Set<string>();
    for (const option of config.options ?? []) {
      const key = normaliseAnswer(option);
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: `"${option}" is listed twice.`,
        });
      }
      seen.add(key);
    }
  });
export type DebateHubConfig = z.infer<typeof DebateHubConfigSchema>;

/** What makes an agent node a debater (D357): an optional stance and workspace reads. */
export const DebaterConfigSchema = z.strictObject({
  stance: z.string().trim().min(1).max(DEBATE_STANCE_MAX).optional(),
  reads: z
    .array(z.string().trim().min(1).max(DEBATE_READ_PATH_MAX))
    .max(DEBATE_READS_PER_DEBATER_MAX)
    .optional(),
});
export type DebaterConfig = z.infer<typeof DebaterConfigSchema>;

/** DB9: trimmed and lower-cased, so "Yes " and "yes" are one answer. */
export function normaliseAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Turns and the verdict                                                       */
/* -------------------------------------------------------------------------- */

export const DebateRebuttalSchema = z.strictObject({
  targetTurnId: DebateTurnIdSchema,
  claim: z.string().min(1),
  response: z.string().min(1),
});
export type DebateRebuttal = z.infer<typeof DebateRebuttalSchema>;

export const DebateChangedBecauseSchema = z.strictObject({
  turnId: DebateTurnIdSchema,
  argument: z.string().min(1),
});
export type DebateChangedBecause = z.infer<typeof DebateChangedBecauseSchema>;

/** One accepted turn. `turnId`, `round` and `label` are the engine's; the rest is the model's. */
export const DebateTurnSchema = z.strictObject({
  turnId: DebateTurnIdSchema,
  round: z.number().int().min(0).max(DEBATE_LIMITS.maxRounds),
  label: DebateLabelSchema,
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** The full text; a prompt for anyone else shows at most 6000 characters of it (D343). */
  reasoning: z.string(),
  rebuttals: z.array(DebateRebuttalSchema),
  /** Choice mode: computed by the engine; free mode: what the debater said (D348). */
  positionChanged: z.boolean(),
  changedBecause: DebateChangedBecauseSchema.nullable(),
});
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

export const DebateRationalePointSchema = z.strictObject({
  point: z.string().min(1),
  /** Turn ids, or `judge` for a point no debater made (D346). */
  supportedBy: z.array(z.string().min(1)).min(1),
});
export type DebateRationalePoint = z.infer<typeof DebateRationalePointSchema>;

export const DebateDissentSchema = z.strictObject({
  label: DebateLabelSchema,
  answer: z.string().min(1),
  strongestArgument: z.string().min(1),
  turnId: DebateTurnIdSchema,
});
export type DebateDissent = z.infer<typeof DebateDissentSchema>;

/** Filled by the engine only; anything the model writes here is ignored (D346). */
export const DebateStatsSchema = z.strictObject({
  debateId: IdSchema,
  /** Rebuttal rounds that ran to their end. */
  rounds: z.number().int().min(0).max(DEBATE_LIMITS.maxRounds),
  stoppedBy: DebateStoppedBySchema,
  /** Accepted turns. */
  turns: z.number().int().min(0),
  /** Turns recorded as CONTRACT_VIOLATION. */
  violations: z.number().int().min(0),
  /** Input + output tokens of every call the debate made, its judge calls included. */
  tokens: z.number().int().min(0),
  /** Choice mode: the openings' majority answer, or `tie` (DB9). */
  openingsMajority: z.string().min(1).optional(),
  /** Choice mode, when the openings had a majority: does the verdict differ from it? */
  changedFromOpenings: z.boolean().optional(),
  /** Free mode with `baselineJudge`: the judge's answer over the openings alone. */
  openingsVerdict: z.string().min(1).optional(),
});
export type DebateStats = z.infer<typeof DebateStatsSchema>;

export const DebateVerdictSchema = z.strictObject({
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.array(DebateRationalePointSchema).min(1),
  dissent: z.array(DebateDissentSchema),
  openQuestions: z.array(z.string().min(1)),
  stats: DebateStatsSchema,
});
export type DebateVerdict = z.infer<typeof DebateVerdictSchema>;

/* -------------------------------------------------------------------------- */
/* Events (D352, D357, D358)                                                   */
/* -------------------------------------------------------------------------- */

export const DEBATE_EVENT_TYPES = [
  'debate.started',
  'debate.round_started',
  'debate.turn_started',
  'debate.turn_delta',
  'debate.turn_completed',
  'debate.turn_failed',
  'debate.turn_violation',
  'debate.instruction_delivered',
  'debate.round_completed',
  'debate.control',
  'debate.stopped',
  'debate.verdict',
  'debate.failed',
] as const;
export type DebateEventType = (typeof DEBATE_EVENT_TYPES)[number];

const base = { runId: IdSchema, debateId: IdSchema };

export const DebateStartedDebaterSchema = z.strictObject({
  label: DebateLabelSchema,
  nodeId: IdSchema,
  providerId: IdSchema.optional(),
  modelId: z.string().min(1).optional(),
  stance: z.string().min(1).optional(),
});
export type DebateStartedDebater = z.infer<typeof DebateStartedDebaterSchema>;

export const DebateReadFileSchema = z.strictObject({
  label: DebateLabelSchema,
  path: z.string().min(1),
  chars: z.number().int().min(0),
});
export type DebateReadFile = z.infer<typeof DebateReadFileSchema>;

/** DB8: what the reads were, once, at debate start. */
export const DebateReadsSnapshotSchema = z.strictObject({
  /** The workspace's commit, or null when it is not a git repository. */
  sha: z.string().min(1).nullable(),
  dirty: z.boolean(),
  files: z.array(DebateReadFileSchema),
});
export type DebateReadsSnapshot = z.infer<typeof DebateReadsSnapshotSchema>;

export const DebateStartedPayloadSchema = z.strictObject({
  ...base,
  hubNodeId: IdSchema,
  config: DebateHubConfigSchema,
  debaters: z
    .array(DebateStartedDebaterSchema)
    .min(DEBATE_LIMITS.minDebaters)
    .max(DEBATE_LIMITS.maxDebaters),
  readsSnapshot: DebateReadsSnapshotSchema,
});
export type DebateStartedPayload = z.infer<typeof DebateStartedPayloadSchema>;

export const DebateRoundStartedPayloadSchema = z.strictObject({
  ...base,
  round: z.number().int().min(0).max(DEBATE_LIMITS.maxRounds),
  /** The debaters taking part in this round. */
  labels: z.array(DebateLabelSchema),
});
export type DebateRoundStartedPayload = z.infer<typeof DebateRoundStartedPayloadSchema>;

export const DebateTurnStartedPayloadSchema = z.strictObject({
  ...base,
  callId: DebateCallIdSchema,
  nodeId: IdSchema,
  attempt: z.number().int().min(1),
  kind: DebateCallKindSchema,
});
export type DebateTurnStartedPayload = z.infer<typeof DebateTurnStartedPayloadSchema>;

/** Transient (D358), like `node.token`: never in the log. */
export const DebateTurnDeltaPayloadSchema = z.strictObject({
  ...base,
  callId: DebateCallIdSchema,
  text: z.string(),
});
export type DebateTurnDeltaPayload = z.infer<typeof DebateTurnDeltaPayloadSchema>;

export const DebateTurnCompletedPayloadSchema = z.strictObject({
  ...base,
  nodeId: IdSchema,
  turn: DebateTurnSchema,
  /** The accepted call's usage; failed and repaired calls carry their own. */
  usage: UsageSchema,
  durationMs: z.number().int().min(0),
});
export type DebateTurnCompletedPayload = z.infer<typeof DebateTurnCompletedPayloadSchema>;

export const DebateTurnFailedPayloadSchema = z.strictObject({
  ...base,
  callId: DebateCallIdSchema,
  nodeId: IdSchema,
  /** What went wrong, in words; never a secret (the error's message is already masked). */
  reason: z.string().min(1),
  /** RUN_FAILED for a CLI failure, GUARDRAIL_VIOLATION for a block (D355); absent when cancelled. */
  failureReason: FailureReasonSchema.optional(),
  /** Killed, not failed: "Judge now", an interrupt or a stop (D349, D351). */
  cancelled: z.boolean().optional(),
  willRetry: z.boolean(),
  /** The debater is out for the rest of the debate (DB11). */
  out: z.boolean(),
  usage: UsageSchema,
});
export type DebateTurnFailedPayload = z.infer<typeof DebateTurnFailedPayloadSchema>;

export const DebateTurnViolationPayloadSchema = z.strictObject({
  ...base,
  callId: DebateCallIdSchema,
  nodeId: IdSchema,
  errors: z.array(z.string().min(1)).min(1),
  /** False: the turn is recorded as CONTRACT_VIOLATION and the debater sits out this round. */
  willRepair: z.boolean(),
  usage: UsageSchema,
});
export type DebateTurnViolationPayload = z.infer<typeof DebateTurnViolationPayloadSchema>;

export const DebateInstructionDeliveredPayloadSchema = z.strictObject({
  ...base,
  nodeId: IdSchema,
  callId: DebateCallIdSchema,
  messageId: IdSchema,
  text: z.string().min(1).max(DEBATE_INSTRUCTION_MAX),
});
export type DebateInstructionDeliveredPayload = z.infer<
  typeof DebateInstructionDeliveredPayloadSchema
>;

export const DebateRoundCompletedPayloadSchema = z.strictObject({
  ...base,
  round: z.number().int().min(0).max(DEBATE_LIMITS.maxRounds),
  changedCount: z.number().int().min(0),
});
export type DebateRoundCompletedPayload = z.infer<typeof DebateRoundCompletedPayloadSchema>;

export const DebateControlPayloadSchema = z.strictObject({
  ...base,
  action: DebateControlActionSchema,
});
export type DebateControlPayload = z.infer<typeof DebateControlPayloadSchema>;

export const DebateStoppedPayloadSchema = z.strictObject({
  ...base,
  stoppedBy: DebateStoppedBySchema,
});
export type DebateStoppedPayload = z.infer<typeof DebateStoppedPayloadSchema>;

export const DebateVerdictPayloadSchema = z.strictObject({
  ...base,
  verdict: DebateVerdictSchema,
  /** The judge's accepted calls (and the baseline judge's, in free mode). */
  usage: UsageSchema,
});
export type DebateVerdictPayload = z.infer<typeof DebateVerdictPayloadSchema>;

/** The hub ended without a verdict (D350, D353): the partial record stays. */
export const DebateFailedPayloadSchema = z.strictObject({
  ...base,
  failureReason: FailureReasonSchema,
  message: z.string().min(1),
});
export type DebateFailedPayload = z.infer<typeof DebateFailedPayloadSchema>;

/* -------------------------------------------------------------------------- */
/* The fold (D352)                                                             */
/* -------------------------------------------------------------------------- */

/** An event as the log or a stream hands it over; only the debate types are read. */
export interface DebateFoldEvent {
  type: string;
  payload: unknown;
  seq?: number;
}

export interface DebateRecordDebater {
  label: DebateLabel;
  nodeId: string;
  providerId?: string;
  modelId?: string;
  stance?: string;
  reads: { path: string; chars: number }[];
  status: 'active' | 'out';
  /** Input + output tokens of every call this debater made. */
  tokens: number;
}

export interface DebateRecordFailure {
  callId: DebateCallId;
  nodeId: string;
  reason: string;
  failureReason?: FailureReason;
  cancelled?: boolean;
  willRetry: boolean;
  out: boolean;
}

export interface DebateRecordViolation {
  callId: DebateCallId;
  nodeId: string;
  errors: string[];
  willRepair: boolean;
}

export interface DebateRecordRound {
  round: number;
  labels: DebateLabel[];
  turns: DebateTurn[];
  failures: DebateRecordFailure[];
  violations: DebateRecordViolation[];
  completed: boolean;
  changedCount?: number;
}

export interface DebateRecordCall {
  callId: DebateCallId;
  nodeId: string;
  attempt: number;
  kind: DebateCallKind;
}

export interface DebateRecord {
  debateId: string;
  runId: string;
  hubNodeId: string;
  config: DebateHubConfig;
  debaters: DebateRecordDebater[];
  readsSnapshot: DebateReadsSnapshot;
  rounds: DebateRecordRound[];
  /** Every accepted turn by id, for citations. */
  turns: Record<string, DebateTurn>;
  /** Calls started and not yet ended, in the order they started. */
  inFlight: DebateRecordCall[];
  /** The judge's own failures and violations (calls `judge` and `judge-openings`). */
  judgeFailures: DebateRecordFailure[];
  judgeViolations: DebateRecordViolation[];
  instructions: { nodeId: string; callId: DebateCallId; messageId: string; text: string }[];
  controls: { action: DebateControlAction; seq: number }[];
  /** "Pause after this round" was asked for and not yet resumed. */
  pauseRequested: boolean;
  status: 'running' | 'judging' | 'done' | 'failed';
  stoppedBy?: DebateStoppedBy;
  verdict?: DebateVerdict;
  failure?: { failureReason: FailureReason; message: string };
  tokens: number;
  lastSeq: number;
}

type Usage = z.infer<typeof UsageSchema>;
const tokensOf = (usage: Usage): number => usage.tokensIn + usage.tokensOut;

/**
 * An incremental fold: `apply` each event as it arrives, `records()` at any moment. An event whose
 * seq was already applied, a transient one, another type or a payload that does not parse changes
 * nothing, so a replay over a live fold is harmless.
 */
export function createDebateFold(): {
  apply(event: DebateFoldEvent): boolean;
  records(): DebateRecord[];
  get(debateId: string): DebateRecord | undefined;
} {
  const records = new Map<string, DebateRecord>();
  const applied = new Set<number>();

  const roundOf = (record: DebateRecord, round: number): DebateRecordRound => {
    let found = record.rounds.find((r) => r.round === round);
    if (found === undefined) {
      found = { round, labels: [], turns: [], failures: [], violations: [], completed: false };
      record.rounds.push(found);
      record.rounds.sort((a, b) => a.round - b.round);
    }
    return found;
  };
  const endCall = (record: DebateRecord, callId: string): void => {
    const index = record.inFlight.findIndex((call) => call.callId === callId);
    if (index >= 0) record.inFlight.splice(index, 1);
  };
  const spend = (record: DebateRecord, nodeId: string | undefined, usage: Usage): void => {
    record.tokens += tokensOf(usage);
    const debater = record.debaters.find((d) => d.nodeId === nodeId);
    if (debater !== undefined) debater.tokens += tokensOf(usage);
  };
  const roundOfCall = (callId: string): number | undefined => parseDebateTurnId(callId)?.round;

  const handlers: Record<string, (payload: unknown, seq: number) => boolean> = {
    'debate.started': (raw) => {
      const parsed = DebateStartedPayloadSchema.safeParse(raw);
      if (!parsed.success) return false;
      const p = parsed.data;
      records.set(p.debateId, {
        debateId: p.debateId,
        runId: p.runId,
        hubNodeId: p.hubNodeId,
        config: p.config,
        debaters: p.debaters.map((d) => ({
          label: d.label,
          nodeId: d.nodeId,
          ...(d.providerId === undefined ? {} : { providerId: d.providerId }),
          ...(d.modelId === undefined ? {} : { modelId: d.modelId }),
          ...(d.stance === undefined ? {} : { stance: d.stance }),
          reads: p.readsSnapshot.files
            .filter((f) => f.label === d.label)
            .map((f) => ({ path: f.path, chars: f.chars })),
          status: 'active',
          tokens: 0,
        })),
        readsSnapshot: p.readsSnapshot,
        rounds: [],
        turns: {},
        inFlight: [],
        judgeFailures: [],
        judgeViolations: [],
        instructions: [],
        controls: [],
        pauseRequested: false,
        status: 'running',
        tokens: 0,
        lastSeq: 0,
      });
      return true;
    },
    'debate.round_started': (raw) =>
      withRecord(DebateRoundStartedPayloadSchema, raw, (record, p) => {
        roundOf(record, p.round).labels = [...p.labels];
      }),
    'debate.turn_started': (raw) =>
      withRecord(DebateTurnStartedPayloadSchema, raw, (record, p) => {
        endCall(record, p.callId);
        record.inFlight.push({
          callId: p.callId,
          nodeId: p.nodeId,
          attempt: p.attempt,
          kind: p.kind,
        });
      }),
    'debate.turn_completed': (raw) =>
      withRecord(DebateTurnCompletedPayloadSchema, raw, (record, p) => {
        endCall(record, p.turn.turnId);
        spend(record, p.nodeId, p.usage);
        roundOf(record, p.turn.round).turns.push(p.turn);
        record.turns[p.turn.turnId] = p.turn;
      }),
    'debate.turn_failed': (raw) =>
      withRecord(DebateTurnFailedPayloadSchema, raw, (record, p) => {
        endCall(record, p.callId);
        spend(record, p.nodeId, p.usage);
        const failure: DebateRecordFailure = {
          callId: p.callId,
          nodeId: p.nodeId,
          reason: p.reason,
          ...(p.failureReason === undefined ? {} : { failureReason: p.failureReason }),
          ...(p.cancelled === true ? { cancelled: true } : {}),
          willRetry: p.willRetry,
          out: p.out,
        };
        const round = roundOfCall(p.callId);
        if (round === undefined) record.judgeFailures.push(failure);
        else roundOf(record, round).failures.push(failure);
        if (p.out) {
          const debater = record.debaters.find((d) => d.nodeId === p.nodeId);
          if (debater !== undefined) debater.status = 'out';
        }
      }),
    'debate.turn_violation': (raw) =>
      withRecord(DebateTurnViolationPayloadSchema, raw, (record, p) => {
        endCall(record, p.callId);
        spend(record, p.nodeId, p.usage);
        const violation: DebateRecordViolation = {
          callId: p.callId,
          nodeId: p.nodeId,
          errors: [...p.errors],
          willRepair: p.willRepair,
        };
        const round = roundOfCall(p.callId);
        if (round === undefined) record.judgeViolations.push(violation);
        else roundOf(record, round).violations.push(violation);
      }),
    'debate.instruction_delivered': (raw) =>
      withRecord(DebateInstructionDeliveredPayloadSchema, raw, (record, p) => {
        record.instructions.push({
          nodeId: p.nodeId,
          callId: p.callId,
          messageId: p.messageId,
          text: p.text,
        });
      }),
    'debate.round_completed': (raw) =>
      withRecord(DebateRoundCompletedPayloadSchema, raw, (record, p) => {
        const round = roundOf(record, p.round);
        round.completed = true;
        round.changedCount = p.changedCount;
      }),
    'debate.control': (raw, seq) =>
      withRecord(DebateControlPayloadSchema, raw, (record, p) => {
        record.controls.push({ action: p.action, seq });
        if (p.action === 'pause_after_round') record.pauseRequested = true;
        else record.pauseRequested = false;
      }),
    'debate.stopped': (raw) =>
      withRecord(DebateStoppedPayloadSchema, raw, (record, p) => {
        record.stoppedBy = p.stoppedBy;
        record.pauseRequested = false;
        if (record.status === 'running') record.status = 'judging';
      }),
    'debate.verdict': (raw) =>
      withRecord(DebateVerdictPayloadSchema, raw, (record, p) => {
        // The judge's calls are not a debater's, so they count only toward the debate's total.
        spend(record, undefined, p.usage);
        record.verdict = p.verdict;
        record.status = 'done';
        record.inFlight = [];
      }),
    'debate.failed': (raw) =>
      withRecord(DebateFailedPayloadSchema, raw, (record, p) => {
        record.failure = { failureReason: p.failureReason, message: p.message };
        record.status = 'failed';
        record.inFlight = [];
      }),
  };

  function withRecord<S extends z.ZodType<{ debateId: string }>>(
    schema: S,
    raw: unknown,
    apply: (record: DebateRecord, payload: z.infer<S>) => void,
  ): boolean {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return false;
    const record = records.get(parsed.data.debateId);
    if (record === undefined) return false;
    apply(record, parsed.data);
    return true;
  }

  return {
    apply(event) {
      const handler = handlers[event.type];
      if (handler === undefined) return false;
      const seq = event.seq;
      // Transient frames (no seq, or seq 0) never reach the record (D358).
      if (seq === undefined || seq <= 0 || applied.has(seq)) return false;
      const changed = handler(event.payload, seq);
      if (!changed) return false;
      applied.add(seq);
      const debateId = (event.payload as { debateId?: unknown }).debateId;
      const record = typeof debateId === 'string' ? records.get(debateId) : undefined;
      if (record !== undefined) record.lastSeq = Math.max(record.lastSeq, seq);
      return true;
    },
    records: () => [...records.values()],
    get: (debateId) => records.get(debateId),
  };
}

/** Every debate in a log, in the order they started (a re-run hub starts a new one, D340). */
export function foldDebates(events: readonly DebateFoldEvent[]): DebateRecord[] {
  const fold = createDebateFold();
  const ordered = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const event of ordered) fold.apply(event);
  return fold.records();
}

/** One debate of a log: the one named, or else the last one started. */
export function foldDebate(
  events: readonly DebateFoldEvent[],
  debateId?: string,
): DebateRecord | undefined {
  const records = foldDebates(events);
  return debateId === undefined ? records.at(-1) : records.find((r) => r.debateId === debateId);
}
