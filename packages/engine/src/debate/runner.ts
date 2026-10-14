import {
  DEBATE_LABELS,
  DEBATE_LIMITS,
  DebateHubConfigSchema,
  createDebateFold,
  turnIdFor,
  type DebateCallId,
  type DebateCallKind,
  type DebateHubConfig,
  type DebateLabel,
  type DebateRecord,
  type DebateStoppedBy,
  type DebateTurn,
  type DebateVerdict,
  type FailureReason,
  type NodeError,
  type Usage,
} from '@ace/contracts';
import type { z } from 'zod';

import { failureReasonFor } from '../errors/failure.js';
import { createBatcher } from '../events/batcher.js';
import type { EventBus } from '../events/index.js';
import type { RoutingNodeConfig } from '../ports/index.js';
import { changedFromOpenings, openingsMajority } from './baseline.js';
import { projectRound, type ProjectedCall } from './budget.js';
import type { DebateCaller } from './caller.js';
import {
  lastJsonBlock,
  validateTurnReply,
  validateVerdictReply,
  type Checked,
} from './contract.js';
import { createDebateControl, type AttachableDebateControl } from './control.js';
import type {
  DebateBudget,
  DebateGuardrails,
  DebateHooks,
  DebateInstruction,
  DebateReadContent,
  DebaterState,
  DebateWorkspace,
} from './ports.js';
import {
  judgePrompt,
  openingPrompt,
  rebuttalPrompt,
  repairPrompt,
  type AnswerFormat,
  type LastRoundEntry,
} from './prompts.js';

/**
 * The debate loop the hub owns (D340–D352). Openings in parallel, rebuttal rounds behind a barrier,
 * then the judge; every step is an event, and the record this returns is the fold of exactly the
 * events it wrote (D352), so a replay of the log gives the same record.
 */

export interface DebateParticipant {
  nodeId: string;
  /** For the engine's own logs; never in a prompt (D345). */
  name: string;
  route: RoutingNodeConfig;
  /** The node's `execution.timeoutMs`, per call. */
  timeoutMs: number;
  /** The node's `execution.maxTokens`, the output estimate before it has spoken (D354). */
  maxTokens: number;
}

export interface DebaterSpec extends DebateParticipant {
  stance?: string;
  /** Workspace paths, relative to the project folder (DB8). */
  reads: string[];
}

export interface DebateSpec {
  runId: string;
  workflowId: string;
  debateId: string;
  hub: DebateParticipant;
  config: z.input<typeof DebateHubConfigSchema>;
  /** The upstream envelopes' payloads, rendered and labelled untrusted by the caller. */
  material: string;
  /** In their order on the canvas: labels A–E follow it (D345). */
  debaters: DebaterSpec[];
  projectFolder?: string;
  /** The run's own stop. */
  signal: AbortSignal;
  control?: AttachableDebateControl;
}

export interface DebateDeps {
  bus: EventBus;
  caller: DebateCaller;
  workspace: DebateWorkspace;
  guardrails?: DebateGuardrails;
  budget?: DebateBudget;
  hooks?: DebateHooks;
  /** How long stream deltas are batched before they are published; 50 ms like `node.token`. */
  tokenBatchMs?: number;
}

export type DebateOutcome =
  | { kind: 'verdict'; verdict: DebateVerdict; record: DebateRecord; judgeUsage: Usage }
  | {
      kind: 'failed';
      failureReason: FailureReason;
      error: NodeError;
      record?: DebateRecord;
      judgeUsage: Usage;
    }
  | { kind: 'stopped'; record?: DebateRecord; judgeUsage: Usage };

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

const addUsage = (a: Usage, b: Usage): Usage => ({
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  costUsd: a.costUsd + b.costUsd,
});

interface Debater {
  spec: DebaterSpec;
  label: DebateLabel;
  out: boolean;
  /** The most output tokens one of its calls wrote: its next output estimate (D354). */
  maxOut?: number;
  reads: DebateReadContent[];
}

type CallOutcome<T> =
  | { kind: 'accepted'; value: T; usage: Usage; durationMs: number }
  | { kind: 'failed'; error: NodeError }
  | { kind: 'blocked'; message: string }
  | { kind: 'violation'; errors: string[] }
  | { kind: 'cancelled' };

/** Why a call was killed, in the event's words (D349, D351). */
type KillReason = 'judge_now' | 'interrupt';
const KILL_WORDS: Record<KillReason | 'stop', string> = {
  judge_now: 'Stopped by "Judge now".',
  interrupt: 'Interrupted by a message; it runs again with the message.',
  stop: 'The run was stopped.',
};

function refusal(
  code: string,
  message: string,
  kind: NodeError['kind'] = 'invalid_config',
): DebateOutcome {
  const error: NodeError = { kind, code, message, retryable: false };
  return { kind: 'failed', failureReason: failureReasonFor(error), error, judgeUsage: NO_USAGE };
}

export async function runDebate(spec: DebateSpec, deps: DebateDeps): Promise<DebateOutcome> {
  const parsed = DebateHubConfigSchema.safeParse(spec.config);
  if (!parsed.success) {
    return refusal(
      'debate_invalid_config',
      `The debate's settings are not valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const config: DebateHubConfig = parsed.data;
  if (
    spec.debaters.length < DEBATE_LIMITS.minDebaters ||
    spec.debaters.length > DEBATE_LIMITS.maxDebaters
  ) {
    return refusal(
      'debate_wrong_debater_count',
      `A debate needs ${DEBATE_LIMITS.minDebaters}–${DEBATE_LIMITS.maxDebaters} debaters; this one has ${spec.debaters.length}.`,
    );
  }
  const format: AnswerFormat = {
    answerFormat: config.answerFormat,
    ...(config.options === undefined ? {} : { options: config.options }),
  };
  const hooks = deps.hooks ?? {};
  const control = spec.control ?? createDebateControl();

  const debaters: Debater[] = spec.debaters.map((d, index) => ({
    spec: d,
    label: DEBATE_LABELS[index] as DebateLabel,
    out: false,
    reads: [],
  }));

  /* -------------------------------------------- DB8: the reads, snapshotted once */

  const wanted = debaters.flatMap((d) => d.spec.reads.map((path) => ({ debater: d, path })));
  let snapshot: { sha: string | null; dirty: boolean } = { sha: null, dirty: false };
  const contentOf = new Map<string, string>();
  if (wanted.length > 0) {
    const folder = spec.projectFolder ?? '';
    if (folder === '') {
      return refusal(
        'debate_reads_without_folder',
        'A debater reads workspace files, but this project has no folder.',
      );
    }
    try {
      const taken = await deps.workspace.snapshot(folder, [...new Set(wanted.map((w) => w.path))]);
      snapshot = { sha: taken.sha, dirty: taken.dirty };
      for (const file of taken.files) contentOf.set(file.path, file.content);
    } catch (error) {
      return refusal(
        'debate_read_failed',
        `A debater's read could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const total = wanted.reduce((sum, w) => sum + (contentOf.get(w.path)?.length ?? 0), 0);
    if (total > DEBATE_LIMITS.readsMaxChars) {
      const list = wanted
        .map(
          (w) => `${w.path} (${w.debater.label}): ${contentOf.get(w.path)?.length ?? 0} characters`,
        )
        .join('; ');
      return refusal(
        'debate_reads_too_large',
        `The debaters' reads come to ${total} characters, over the ${DEBATE_LIMITS.readsMaxChars} a debate inlines: ${list}.`,
      );
    }
  }

  /* -------------------------------------------- D355: the input point, once */

  let material = spec.material;
  if (deps.guardrails !== undefined) {
    const checked = [
      ...(material.trim() === '' ? [] : [['', material] as const]),
      ...contentOf.entries(),
    ];
    for (const [path, text] of checked) {
      const step = await deps.guardrails.checkInput(text);
      if (step.kind === 'blocked') {
        return refusal('debate_input_blocked', step.message, 'guardrail');
      }
      if (path === '') material = step.text;
      else contentOf.set(path, step.text);
    }
  }
  for (const w of wanted) {
    w.debater.reads.push({ path: w.path, content: contentOf.get(w.path) ?? '' });
  }

  /* -------------------------------------------- the log, folded as it is written */

  const fold = createDebateFold();
  let queue: Promise<unknown> = Promise.resolve();
  const emit = (type: string, payload: Record<string, unknown>): Promise<void> => {
    const next = queue.then(async () => {
      const stored = await deps.bus.emit({
        type,
        workflowId: spec.workflowId,
        runId: spec.runId,
        payload: { runId: spec.runId, debateId: spec.debateId, ...payload },
      });
      fold.apply(stored);
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const record = (): DebateRecord | undefined => fold.get(spec.debateId);
  const sendDelta = (callId: string, text: string): void => {
    void deps.bus.emitTransient({
      type: 'debate.turn_delta',
      workflowId: spec.workflowId,
      runId: spec.runId,
      payload: { runId: spec.runId, debateId: spec.debateId, callId, text },
    });
  };

  const setState = async (
    d: Debater,
    state: DebaterState,
    reason?: FailureReason,
  ): Promise<void> => {
    await hooks.debaterState?.(d.spec.nodeId, state, reason);
  };
  const takeInstructions = async (nodeId: string): Promise<DebateInstruction[]> =>
    (await hooks.takeInstructions?.(nodeId)) ?? [];

  let hubUsage: Usage = NO_USAGE;
  let hubMaxOut: number | undefined;

  /* -------------------------------------------- prompts from the record (DB4) */

  const turnsOf = (round: number): DebateTurn[] =>
    record()?.rounds.find((r) => r.round === round)?.turns ?? [];
  const latestTurn = (label: DebateLabel): DebateTurn | undefined => {
    const all = Object.values(record()?.turns ?? {}).filter((t) => t.label === label);
    return all.sort((a, b) => b.round - a.round)[0];
  };

  const promptFor = (d: Debater, round: number, instructions: readonly string[]): string => {
    const common = {
      label: d.label,
      ...(d.spec.stance === undefined ? {} : { stance: d.spec.stance }),
      topic: config.topic,
      material,
      reads: d.reads,
      instructions,
      format,
    };
    if (round === 0) return openingPrompt(common);
    const previous = turnsOf(round - 1);
    const lastRound: LastRoundEntry[] = debaters
      .filter((other) =>
        record()
          ?.rounds.find((r) => r.round === round - 1)
          ?.labels.includes(other.label),
      )
      .map((other) => {
        const turn = previous.find((t) => t.label === other.label);
        return {
          turnId: turnIdFor(round - 1, other.label),
          mine: other === d,
          ...(turn === undefined ? {} : { turn }),
        };
      });
    return rebuttalPrompt({ ...common, round, maxRounds: config.maxRounds, lastRound });
  };

  /** The judge sees each debater's latest turn in full and every earlier turn compact (D343). */
  const judgeView = (): { final: DebateTurn[]; earlier: DebateTurn[] } => {
    const all = Object.values(record()?.turns ?? {}).sort(
      (a, b) => a.round - b.round || a.label.localeCompare(b.label),
    );
    const final = debaters
      .map((d) => latestTurn(d.label))
      .filter((t): t is DebateTurn => t !== undefined);
    const finalIds = new Set(final.map((t) => t.turnId));
    return { final, earlier: all.filter((t) => !finalIds.has(t.turnId)) };
  };

  /* -------------------------------------------- calls, with retry and repair (DB11) */

  const inFlight = new Map<string, { nodeId: string; controller: AbortController }>();

  async function callWithContract<T>(args: {
    callId: DebateCallId;
    participant: DebateParticipant;
    prompt: string;
    validate: (value: unknown) => Checked<T>;
    /** A debater's turn: "Judge now" and an interrupt kill it, and a second failure puts it out. */
    debaterTurn: boolean;
  }): Promise<CallOutcome<T>> {
    const { callId, participant } = args;
    const nodeId = participant.nodeId;
    let prompt = args.prompt;
    let attempt = 0;
    let kind: DebateCallKind = 'turn';
    let retried = false;
    let repaired = false;

    for (;;) {
      attempt += 1;
      await emit('debate.turn_started', { callId, nodeId, attempt, kind });
      const controller = new AbortController();
      if (args.debaterTurn) inFlight.set(callId, { nodeId, controller });
      const deltas = createBatcher<string>({
        intervalMs: deps.tokenBatchMs ?? 50,
        flush: (items) => sendDelta(callId, items.join('')),
      });
      const scratch = await deps.workspace.scratch();
      const started = Date.now();
      let result;
      try {
        result = await deps.caller.call({
          nodeId,
          route: participant.route,
          prompt,
          turnId: `${spec.debateId}/${callId}`,
          workingDir: scratch.dir,
          timeoutMs: participant.timeoutMs,
          signal: AbortSignal.any([spec.signal, controller.signal]),
          onDelta: (text) => deltas.push(text),
        });
      } finally {
        inFlight.delete(callId);
        deltas.stop();
        await scratch.dispose().catch(() => undefined);
      }
      await hooks.usage?.(nodeId, result.usage);
      if (nodeId === spec.hub.nodeId) hubUsage = addUsage(hubUsage, result.usage);

      if (!result.ok) {
        if (result.cancelled) {
          const why = spec.signal.aborted
            ? 'stop'
            : ((controller.signal.reason as KillReason | undefined) ?? 'stop');
          await emit('debate.turn_failed', {
            callId,
            nodeId,
            reason: KILL_WORDS[why],
            cancelled: true,
            willRetry: false,
            out: false,
            usage: result.usage,
          });
          return { kind: 'cancelled' };
        }
        if (!retried) {
          retried = true;
          await emit('debate.turn_failed', {
            callId,
            nodeId,
            reason: result.error.message,
            failureReason: 'RUN_FAILED',
            willRetry: true,
            out: false,
            usage: result.usage,
          });
          kind = 'retry';
          continue;
        }
        await emit('debate.turn_failed', {
          callId,
          nodeId,
          reason: result.error.message,
          failureReason: 'RUN_FAILED',
          willRetry: false,
          out: args.debaterTurn,
          usage: result.usage,
        });
        return { kind: 'failed', error: { ...result.error, retryable: false } };
      }

      let text = result.text;
      if (deps.guardrails !== undefined) {
        const step = await deps.guardrails.checkOutput(nodeId, text);
        if (step.kind === 'blocked') {
          await emit('debate.turn_failed', {
            callId,
            nodeId,
            reason: step.message,
            failureReason: 'GUARDRAIL_VIOLATION',
            willRetry: false,
            out: false,
            usage: result.usage,
          });
          return { kind: 'blocked', message: step.message };
        }
        text = step.text;
      }

      const block = lastJsonBlock(text);
      const checked: Checked<T> = block.ok
        ? args.validate(block.value)
        : { ok: false, errors: [block.error] };
      if (checked.ok) {
        return {
          kind: 'accepted',
          value: checked.value,
          usage: result.usage,
          durationMs: Date.now() - started,
        };
      }
      await emit('debate.turn_violation', {
        callId,
        nodeId,
        errors: checked.errors,
        willRepair: !repaired,
        usage: result.usage,
      });
      if (repaired) return { kind: 'violation', errors: checked.errors };
      repaired = true;
      prompt = repairPrompt(args.prompt, text, checked.errors);
      kind = 'repair';
    }
  }

  /* -------------------------------------------- one debater's turn */

  async function runTurn(d: Debater, round: number): Promise<void> {
    const callId = turnIdFor(round, d.label);
    const instructions = await takeInstructions(d.spec.nodeId);
    for (const instruction of instructions) {
      await emit('debate.instruction_delivered', {
        nodeId: d.spec.nodeId,
        callId,
        messageId: instruction.messageId,
        text: instruction.text,
      });
    }
    const prompt = promptFor(
      d,
      round,
      instructions.map((i) => i.text),
    );
    const citable = new Set(
      turnsOf(round - 1)
        .filter((t) => t.label !== d.label)
        .map((t) => t.turnId),
    );
    const ownPrevious = latestTurn(d.label);
    await setState(d, 'RUNNING');

    const outcome = await callWithContract({
      callId,
      participant: d.spec,
      prompt,
      debaterTurn: true,
      validate: (value) =>
        validateTurnReply(value, {
          round,
          label: d.label,
          format,
          citable,
          ...(ownPrevious === undefined ? {} : { ownPrevious }),
        }),
    });

    if (outcome.kind === 'accepted') {
      await emit('debate.turn_completed', {
        nodeId: d.spec.nodeId,
        turn: outcome.value,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
      });
      d.maxOut = Math.max(d.maxOut ?? 0, outcome.usage.tokensOut);
    }
    if (outcome.kind === 'failed') {
      d.out = true;
      await setState(d, 'FAILED', 'RUN_FAILED');
      return;
    }
    if (!spec.signal.aborted) await setState(d, 'WAITING');
  }

  /* -------------------------------------------- D354: will the next round fit? */

  const expectedOut = (d: Debater): number => d.maxOut ?? d.spec.maxTokens;
  const hubOut = (): number => hubMaxOut ?? spec.hub.maxTokens;

  async function fitsBudget(round: number): Promise<boolean> {
    if (deps.budget === undefined) return true;
    const left = await deps.budget.remaining();
    if (left.tokens === null && left.usd === null) return true;
    const active = debaters.filter((d) => !d.out);
    const turns: ProjectedCall[] = active.map((d) => ({
      nodeId: d.spec.nodeId,
      prompt: promptFor(d, round, []),
      output: expectedOut(d),
    }));
    const roundOutput = turns.reduce((sum, t) => sum + t.output, 0);
    const view = judgeView();
    const judgeCalls: ProjectedCall[] = [
      {
        nodeId: spec.hub.nodeId,
        prompt: judgePrompt({ topic: config.topic, material, instructions: [], format, ...view }),
        output: hubOut(),
        extraInput: roundOutput,
      },
    ];
    if (config.answerFormat === 'free' && config.baselineJudge) {
      judgeCalls.push({
        nodeId: spec.hub.nodeId,
        prompt: judgePrompt({
          topic: config.topic,
          material,
          instructions: [],
          format,
          final: turnsOf(0),
          earlier: [],
        }),
        output: hubOut(),
        ...(round === 0 ? { extraInput: roundOutput } : {}),
      });
    }
    const projection = projectRound(
      [...turns, ...judgeCalls],
      deps.budget.costOf?.bind(deps.budget),
    );
    if (left.tokens !== null && projection.tokens > left.tokens) return false;
    if (left.usd !== null && projection.usd > left.usd) return false;
    return true;
  }

  /* -------------------------------------------- start */

  if (!(await fitsBudget(0))) {
    return refusal(
      'debate_budget_too_low',
      'The budget left would not cover the openings and the judge, so the debate did not start.',
      'workflow',
    );
  }

  await emit('debate.started', {
    hubNodeId: spec.hub.nodeId,
    config,
    debaters: debaters.map((d) => ({
      label: d.label,
      nodeId: d.spec.nodeId,
      ...(d.spec.route.providerId === undefined ? {} : { providerId: d.spec.route.providerId }),
      ...(d.spec.route.modelId === undefined ? {} : { modelId: d.spec.route.modelId }),
      ...(d.spec.stance === undefined ? {} : { stance: d.spec.stance }),
    })),
    readsSnapshot: {
      sha: snapshot.sha,
      dirty: snapshot.dirty,
      files: wanted.map((w) => ({
        label: w.debater.label,
        path: w.path,
        chars: contentOf.get(w.path)?.length ?? 0,
      })),
    },
  });

  /* -------------------------------------------- the human's controls (D349, D358) */

  let wake: () => void = () => undefined;
  const waitForWake = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
    });
  const onStop = (): void => wake();
  spec.signal.addEventListener('abort', onStop, { once: true });

  const kill = (reason: KillReason, nodeId?: string): boolean => {
    let killed = false;
    for (const [, call] of inFlight) {
      if (nodeId !== undefined && call.nodeId !== nodeId) continue;
      call.controller.abort(reason);
      killed = true;
    }
    return killed;
  };

  /** A control is recorded in order with everything else; a failed write must not crash the debate. */
  const recordControl = (action: 'judge_now' | 'pause_after_round' | 'resume'): void => {
    emit('debate.control', { action }).catch(() => undefined);
  };
  control.attach({
    onJudgeNow: () => {
      recordControl('judge_now');
      kill('judge_now');
      wake();
    },
    onPause: () => recordControl('pause_after_round'),
    onResume: () => {
      recordControl('resume');
      wake();
    },
    onInterrupt: (nodeId) => kill('interrupt', nodeId),
  });
  if (control.pauseRequested) recordControl('pause_after_round');
  if (control.judgeNowRequested) recordControl('judge_now');

  /* -------------------------------------------- the rounds (DB3, DB10) */

  async function runRounds(): Promise<DebateStoppedBy | 'stopped'> {
    for (let round = 0; round <= config.maxRounds; round += 1) {
      if (spec.signal.aborted) return 'stopped';
      if (round > 0) {
        if (control.judgeNowRequested) return 'human_end';
        while (control.pauseRequested && !control.judgeNowRequested && !spec.signal.aborted) {
          await waitForWake();
        }
        if (spec.signal.aborted) return 'stopped';
        if (control.judgeNowRequested) return 'human_end';
        if (hooks.waitDispatchable !== undefined && !(await hooks.waitDispatchable()))
          return 'stopped';
        if (!(await fitsBudget(round))) return 'budget';
      }
      const active = debaters.filter((d) => !d.out);
      if (active.length < DEBATE_LIMITS.minDebaters) return 'failures';

      await emit('debate.round_started', { round, labels: active.map((d) => d.label) });
      await Promise.all(active.map((d) => runTurn(d, round)));
      if (spec.signal.aborted) return 'stopped';
      if (control.judgeNowRequested) return 'human_end';

      const changedCount = round === 0 ? 0 : turnsOf(round).filter((t) => t.positionChanged).length;
      await emit('debate.round_completed', { round, changedCount });
      if (debaters.filter((d) => !d.out).length < DEBATE_LIMITS.minDebaters) return 'failures';
      if (round > 0 && config.earlyStop && changedCount === 0) return 'converged';
    }
    return 'max_rounds';
  }

  const finishDebaters = async (state: DebaterState): Promise<void> => {
    for (const d of debaters) if (!d.out) await setState(d, state);
  };

  const failed = async (error: NodeError): Promise<DebateOutcome> => {
    const failureReason = failureReasonFor(error);
    await emit('debate.failed', { failureReason, message: error.message });
    await finishDebaters('COMPLETED');
    return { kind: 'failed', failureReason, error, ...withRecord(), judgeUsage: hubUsage };
  };
  const withRecord = (): { record?: DebateRecord } => {
    const current = record();
    return current === undefined ? {} : { record: current };
  };
  const stopped = async (): Promise<DebateOutcome> => {
    await queue;
    await finishDebaters('STOPPED');
    return { kind: 'stopped', ...withRecord(), judgeUsage: hubUsage };
  };

  try {
    const ended = await runRounds();
    if (ended === 'stopped') return await stopped();
    await emit('debate.stopped', { stoppedBy: ended });
    if (ended === 'failures') {
      return await failed({
        kind: 'provider',
        code: 'debate_too_few_debaters',
        message: 'Fewer than two debaters are left, so the debate cannot go on.',
        retryable: false,
      });
    }

    /* ------------------------------------------ the judge (DB7) */

    const view = judgeView();
    const shown = new Set([...view.final, ...view.earlier].map((t) => t.turnId));
    const labels = new Set(debaters.map((d) => d.label));
    const hubInstructions = await takeInstructions(spec.hub.nodeId);
    for (const instruction of hubInstructions) {
      await emit('debate.instruction_delivered', {
        nodeId: spec.hub.nodeId,
        callId: 'judge',
        messageId: instruction.messageId,
        text: instruction.text,
      });
    }
    const instructionTexts = hubInstructions.map((i) => i.text);
    const judged = await callWithContract({
      callId: 'judge',
      participant: spec.hub,
      debaterTurn: false,
      prompt: judgePrompt({
        topic: config.topic,
        material,
        instructions: instructionTexts,
        format,
        ...view,
      }),
      validate: (value) => validateVerdictReply(value, { format, turnIds: shown, labels }),
    });
    if (judged.kind === 'cancelled') return await stopped();
    if (judged.kind === 'failed') return await failed(judged.error);
    if (judged.kind === 'blocked') {
      return await failed({
        kind: 'guardrail',
        code: 'debate_verdict_blocked',
        message: judged.message,
        retryable: false,
      });
    }
    if (judged.kind === 'violation') {
      return await failed({
        kind: 'agent',
        code: 'contract_violation',
        message: `The judge's verdict broke its contract twice: ${judged.errors.join('; ')}`,
        retryable: false,
      });
    }
    let verdictUsage = judged.usage;
    hubMaxOut = judged.usage.tokensOut;

    /* ------------------------------------------ DB9: the baseline */

    const openings = turnsOf(0);
    let openingsVerdict: string | undefined;
    if (config.answerFormat === 'free' && config.baselineJudge) {
      const baseline = await callWithContract({
        callId: 'judge-openings',
        participant: spec.hub,
        debaterTurn: false,
        prompt: judgePrompt({
          topic: config.topic,
          material,
          instructions: instructionTexts,
          format,
          final: openings,
          earlier: [],
        }),
        validate: (value) =>
          validateVerdictReply(value, {
            format,
            turnIds: new Set(openings.map((t) => t.turnId)),
            labels,
          }),
      });
      if (baseline.kind === 'cancelled') return await stopped();
      // A baseline that fails costs only its comparison, never the verdict (DB9 measures; it does not decide).
      if (baseline.kind === 'accepted') {
        openingsVerdict = baseline.value.answer;
        verdictUsage = addUsage(verdictUsage, baseline.usage);
      }
    }

    const current = record();
    const majority =
      config.answerFormat === 'choice'
        ? openingsMajority(
            openings.map((t) => t.answer),
            config.options ?? [],
          )
        : undefined;
    const changed =
      majority === undefined ? undefined : changedFromOpenings(judged.value.answer, majority);
    const verdict: DebateVerdict = {
      ...judged.value,
      stats: {
        debateId: spec.debateId,
        rounds: (current?.rounds ?? []).filter((r) => r.round > 0 && r.completed).length,
        stoppedBy: ended,
        turns: Object.keys(current?.turns ?? {}).length,
        violations: (current?.rounds ?? []).reduce(
          (sum, r) => sum + r.violations.filter((v) => !v.willRepair).length,
          0,
        ),
        tokens: (current?.tokens ?? 0) + verdictUsage.tokensIn + verdictUsage.tokensOut,
        ...(majority === undefined ? {} : { openingsMajority: majority }),
        ...(changed === undefined ? {} : { changedFromOpenings: changed }),
        ...(openingsVerdict === undefined ? {} : { openingsVerdict }),
      },
    };
    await emit('debate.verdict', { verdict, usage: verdictUsage });
    await finishDebaters('COMPLETED');
    const final = record();
    if (final === undefined) throw new Error('The debate record is missing after its verdict.');
    return { kind: 'verdict', verdict, record: final, judgeUsage: hubUsage };
  } finally {
    control.detach();
    spec.signal.removeEventListener('abort', onStop);
    await queue;
  }
}
