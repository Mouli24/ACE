import {
  APPROVAL_PREVIEW_MAX,
  validateAgainstContract,
  type Envelope,
  type EnvelopeContract,
  type FailureReason,
  type GuardrailAction,
  type GuardrailCheck,
  type GuardrailCheckType,
  type GuardrailPolicy,
  type Id,
  type LoopStopReason,
  type NodeError,
  type Part,
  type ToolDefinition,
  type Verdict,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Scope } from '../ports/index.js';
import type { ApprovalGate } from '../approvals/index.js';
import {
  redactArgs,
  type ToolGuardrailEvaluator,
  type ToolGuardrailTarget,
  type ToolGuardStep,
  type ToolPointInput,
} from '../runs/tool-loop.js';
import type { CheckInput, CheckOutcome, CheckRunner, LoopCheckInput, SecretMasker } from './checks.js';
import type { GuardrailVerdictRepository } from './ports.js';

/**
 * The guardrail evaluation engine (FR-GRD-003, 007, 009, 011..015, Arch §13.1–13.3).
 *
 * It owns the *order* and the *consequences*; `CheckRunner` owns the judgement. Three rules from
 * the docs are load-bearing and each has a test named after its TC:
 *
 * - **The output order is fixed** (§4 item 4): `secret_leak → pii → moderation →
 *   required_citations → contract`. Not the policy's order — a leak has to be caught before a
 *   moderation `warn` lets the text through.
 * - **A contract failure is always `CONTRACT_VIOLATION`** (D85), whatever the `contract` check's
 *   action says. The check contributes a verdict; it cannot weaken the failure.
 * - **Secrets are masked whatever the policy** (D86). The masking happens before any policy check
 *   runs, so even with `secret_leak` at `warn` the key never reaches the next envelope.
 *
 * A `block` stops evaluation at once: the checks after it have nothing left to judge, and running
 * them would put verdicts on a node run for content that never went anywhere.
 */

/** The fixed output order of §4 item 4. Any other output check runs after these, in policy order. */
export const OUTPUT_CHECK_ORDER: readonly GuardrailCheckType[] = [
  'secret_leak',
  'pii',
  'moderation',
  'required_citations',
  'contract',
];

/** Which node run is being checked, and against which policy (FR-GRD-002). */
export interface EvaluationTarget {
  runId: Id;
  workflowId: Id;
  nodeRunId: Id;
  nodeId: Id;
  nodeName: string;
  iteration: number;
  /** `null` when the project has no policy at all: nothing is checked, and the data guardrail still runs. */
  policy: GuardrailPolicy | null;
  /**
   * The run's abort signal. An `ask_user` wait listens to it, so a Stop or a shutdown ends the wait
   * instead of leaving the node WAITING on a run that is over (FR-CTL-003, D111, D-054).
   */
  signal?: AbortSignal;
}

export type GuardrailOutcome =
  | { kind: 'continue'; parts: Part[]; verdicts: Verdict[] }
  | {
      kind: 'failed';
      parts: Part[];
      verdicts: Verdict[];
      failureReason: FailureReason;
      error: NodeError;
    };

export type EnvelopeOutcome =
  | { kind: 'continue'; envelopes: Envelope[]; verdicts: Verdict[] }
  | { kind: 'failed'; verdicts: Verdict[]; failureReason: FailureReason; error: NodeError };

export interface LoopOutcome {
  /** `undefined` means the loop may run another iteration (§2.4). */
  stop?: LoopStopReason;
  verdicts: Verdict[];
}

export interface GuardrailEvaluator {
  /** The Input node's content, and anything else read before prompt assembly (FR-GRD-003). */
  evaluateInput(input: { target: EvaluationTarget; parts: readonly Part[] }): Promise<GuardrailOutcome>;
  /** Every envelope's reads, sanitized in place so a redaction reaches the prompt (FR-GRD-014). */
  evaluateEnvelopes(input: {
    target: EvaluationTarget;
    envelopes: readonly Envelope[];
  }): Promise<EnvelopeOutcome>;
  /** After generation, before the contract decides (FR-GRD-007, D85, D86). */
  evaluateOutput(input: {
    target: EvaluationTarget;
    parts: readonly Part[];
    contract?: EnvelopeContract;
  }): Promise<GuardrailOutcome>;
  /** After a loop body's last node completes: may this loop go round again? (FR-GRD-009) */
  evaluateLoop(input: { target: EvaluationTarget; loop: LoopCheckInput }): Promise<LoopOutcome>;
  /** Store and emit one verdict the budget service built (§2.3, FR-GRD-015). */
  record(target: EvaluationTarget, verdict: Verdict): Promise<Verdict>;
  /** A verdict, stored and emitted, for a check the budget service resolved itself. */
  recordCheck(
    target: EvaluationTarget,
    check: GuardrailCheck,
    outcome: CheckOutcome,
  ): Promise<Verdict>;
}

export interface GuardrailEvaluatorDeps {
  scope: Scope;
  checks: CheckRunner;
  masker: SecretMasker;
  verdicts: GuardrailVerdictRepository;
  bus: EventBus;
  /** Only needed for the `ask_user` action; without it `ask_user` is treated as `block` (safe by default). */
  approvals?: ApprovalGate;
  now?: () => string;
  nextId?: () => string;
}

/** Build a stored verdict from a check and what it found (FR-GRD-014: types only, never values). */
export function verdictFor(
  check: GuardrailCheck,
  outcome: CheckOutcome,
  ids: { id: Id; nodeRunId: Id; at: string },
): Verdict {
  return {
    id: ids.id,
    nodeRunId: ids.nodeRunId,
    point: check.point,
    checkType: check.type,
    action: check.action,
    passed: outcome.passed,
    reason: outcome.reason,
    ...(outcome.redactedTypes === undefined || outcome.redactedTypes.length === 0
      ? {}
      : { redactedTypes: [...outcome.redactedTypes] }),
    at: ids.at,
  };
}

/** What a check's text is: the text-bearing parts joined, so a whole-output check sees the whole. */
export function textOf(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text' || part.type === 'code') return part.text;
      if (part.type === 'json') return JSON.stringify(part.value ?? null);
      return '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** Rewrite every string a part carries. `undefined` from `transform` leaves that string alone. */
export function transformPart(part: Part, transform: (text: string) => string | undefined): Part {
  if (part.type === 'text') {
    const next = transform(part.text);
    return next === undefined ? part : { type: 'text', text: next };
  }

  if (part.type === 'code') {
    const next = transform(part.text);
    return next === undefined ? part : { ...part, text: next };
  }

  if (part.type === 'json') {
    return { type: 'json', value: transformJson(part.value, transform) };
  }

  // Image, audio, video and file parts are artifact references: there is no text in them to
  // rewrite, and the bytes behind them are round 4's problem (FR-MM-*).
  return part;
}

function transformJson(value: unknown, transform: (text: string) => string | undefined): unknown {
  if (typeof value === 'string') return transform(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => transformJson(item, transform));

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, transformJson(item, transform)]),
    );
  }

  return value;
}

/** The preview an approval card shows, never longer than the contract allows (§2.2). */
export function previewOf(text: string): string {
  return text.length <= APPROVAL_PREVIEW_MAX
    ? text
    : `${text.slice(0, APPROVAL_PREVIEW_MAX - 1)}…`;
}

export function createGuardrailEvaluator(deps: GuardrailEvaluatorDeps): GuardrailEvaluator {
  const { scope, checks: runner, masker, verdicts: store, bus } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /**
   * Store the verdict, then announce it (FR-GRD-015).
   *
   * Everything but `pass` is emitted. A `pass` action on a check that triggered is configured to do
   * nothing, so emitting `guardrail.verdict` for it would put a warning in front of a user who
   * asked for silence — §4 item 4 draws that line at exactly this point ("warn → continue and emit").
   * It is still *stored*, so the inspector can show it (FR-GRD-015).
   */
  async function record(target: EvaluationTarget, verdict: Verdict): Promise<Verdict> {
    const stored = await store.append(scope, verdict);

    if (stored.action !== 'pass') {
      await bus.emit({
        type: 'guardrail.verdict',
        workflowId: target.workflowId,
        runId: target.runId,
        payload: { runId: target.runId, nodeRunId: target.nodeRunId, verdict: stored },
      });
    }

    return stored;
  }

  function recordCheck(
    target: EvaluationTarget,
    check: GuardrailCheck,
    outcome: CheckOutcome,
  ): Promise<Verdict> {
    return record(
      target,
      verdictFor(check, outcome, { id: nextId(), nodeRunId: target.nodeRunId, at: now() }),
    );
  }

  const blocked = (check: GuardrailCheck, reason: string): NodeError => ({
    kind: 'guardrail',
    code: `guardrail_${check.type}`,
    message: reason,
    retryable: false,
    details: { point: check.point, checkType: check.type, action: check.action },
  });

  /** The checks of a policy that apply at one point, enabled only, in the order given. */
  function checksAt(
    policy: GuardrailPolicy | null,
    point: 'input' | 'output',
    order?: readonly GuardrailCheckType[],
  ): GuardrailCheck[] {
    const applicable = (policy?.checks ?? []).filter(
      (check) => check.enabled && check.point === point,
    );
    if (order === undefined) return applicable;

    const ranked = [...applicable].sort((a, b) => {
      const ia = order.indexOf(a.type);
      const ib = order.indexOf(b.type);
      // A type the order does not name sorts last, keeping its position among its own kind.
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });
    return ranked;
  }

  /**
   * Apply one check's action to the text flowing through.
   *
   * Returns the parts to carry on with, or a failure. This is the only place an action becomes a
   * consequence, which is what keeps `pass | warn | redact | ask_user | block` from being
   * re-interpreted differently at each point (FR-GRD-011, TC-GRD-016).
   *
   * A check that **passed** records nothing. During a run a verdict is a record of something that
   * happened, and fifteen "nothing found" rows per node would bury the one that matters; the policy
   * test endpoint is where a user asks "did my check pass?" and gets every row (FR-GRD-001).
   */
  async function apply(
    target: EvaluationTarget,
    check: GuardrailCheck,
    outcome: CheckOutcome,
    parts: Part[],
    collected: Verdict[],
  ): Promise<{ kind: 'continue'; parts: Part[] } | { kind: 'failed'; error: NodeError }> {
    if (outcome.passed) return { kind: 'continue', parts };

    collected.push(await recordCheck(target, check, outcome));

    let action: GuardrailAction = check.action;

    if (action === 'ask_user') {
      if (deps.approvals === undefined) {
        // No gate wired means nobody could ever answer, and a node waiting forever is worse than a
        // refusal the user can see (D10, safe by default).
        return {
          kind: 'failed',
          error: blocked(check, `${outcome.reason} No approver is available, so it was blocked.`),
        };
      }

      const decision = await deps.approvals.request({
        runId: target.runId,
        workflowId: target.workflowId,
        nodeRunId: target.nodeRunId,
        nodeId: target.nodeId,
        nodeName: target.nodeName,
        point: check.point,
        checkType: check.type,
        reason: outcome.reason,
        preview: previewOf(textOf(parts)),
        ...(target.signal === undefined ? {} : { signal: target.signal }),
      });

      if (decision.decision === 'reject') {
        const note = decision.note === undefined ? '' : ` (${decision.note})`;
        return {
          kind: 'failed',
          error: {
            kind: 'guardrail',
            code: 'approval_rejected',
            message: `A reviewer rejected this output${note}: ${outcome.reason}`,
            retryable: false,
            details: { point: check.point, checkType: check.type, action: 'ask_user' },
          },
        };
      }

      // Approved: carry on from exactly here, with the remaining checks still to run (FR-GRD-013).
      return { kind: 'continue', parts };
    }

    if (action === 'redact') {
      // A check that cannot offer a sanitized text cannot be honoured as `redact`. Letting the raw
      // text through would be the one thing `redact` was configured to prevent, so it blocks.
      if (outcome.sanitized === undefined) {
        action = 'block';
      } else {
        const redacted = parts.map((part) =>
          transformPart(part, (text) => {
            const per = runner.evaluate(check, { point: check.point, text, parts: [part] });
            return per?.sanitized;
          }),
        );
        return { kind: 'continue', parts: redacted };
      }
    }

    if (action === 'block') {
      return { kind: 'failed', error: blocked(check, outcome.reason) };
    }

    // `pass` and `warn` both continue; the difference is the event, and `record` drew it already.
    return { kind: 'continue', parts };
  }

  /** The data guardrail: unconditional, un-configurable, and first (FR-GRD-010, BR-15, D86). */
  async function maskSecrets(
    target: EvaluationTarget,
    parts: readonly Part[],
    collected: Verdict[],
  ): Promise<Part[]> {
    const found = new Set<string>();

    const masked = parts.map((part) =>
      transformPart(part, (text) => {
        const result = masker.mask(text);
        if (result.types.length === 0) return undefined;
        for (const type of result.types) found.add(type);
        return result.text;
      }),
    );

    if (found.size === 0) return [...parts];

    // A silent mask would leave `[api_key redacted]` in an output with nothing to explain it, and
    // `VerdictSchema.point` accepts `data` precisely so this can be recorded (FR-GRD-014/015).
    collected.push(
      await record(target, {
        id: nextId(),
        nodeRunId: target.nodeRunId,
        point: 'data',
        checkType: 'secret_leak',
        action: 'redact',
        passed: false,
        reason: 'Credential-shaped values were masked before this output was stored or passed on.',
        redactedTypes: [...found],
        at: now(),
      }),
    );

    return masked;
  }

  async function runPoint(
    target: EvaluationTarget,
    ordered: GuardrailCheck[],
    initial: Part[],
    collected: Verdict[],
    baseInput: Omit<CheckInput, 'point' | 'text' | 'parts'>,
  ): Promise<GuardrailOutcome> {
    let parts = initial;

    for (const check of ordered) {
      const outcome = runner.evaluate(check, {
        ...baseInput,
        point: check.point,
        text: textOf(parts),
        parts,
      });
      // A check this build has no implementation for (rounds 4–5) records nothing: a verdict the
      // engine cannot justify is worse than no verdict.
      if (outcome === undefined) continue;

      const applied = await apply(target, check, outcome, parts, collected);
      if (applied.kind === 'failed') {
        return {
          kind: 'failed',
          parts,
          verdicts: collected,
          failureReason: 'GUARDRAIL_VIOLATION',
          error: applied.error,
        };
      }
      parts = applied.parts;
    }

    return { kind: 'continue', parts, verdicts: collected };
  }

  return {
    record,
    recordCheck,

    async evaluateInput({ target, parts }) {
      const collected: Verdict[] = [];
      return runPoint(target, checksAt(target.policy, 'input'), [...parts], collected, {});
    },

    async evaluateEnvelopes({ target, envelopes }) {
      const collected: Verdict[] = [];
      const ordered = checksAt(target.policy, 'input');
      const sanitized: Envelope[] = [];

      for (const envelope of envelopes) {
        const outcome = await runPoint(target, ordered, [...envelope.reads], collected, {});
        if (outcome.kind === 'failed') {
          return {
            kind: 'failed',
            verdicts: collected,
            failureReason: outcome.failureReason,
            error: outcome.error,
          };
        }
        sanitized.push({ ...envelope, reads: outcome.parts });
      }

      return { kind: 'continue', envelopes: sanitized, verdicts: collected };
    },

    async evaluateOutput({ target, parts, contract }) {
      const collected: Verdict[] = [];
      const ordered = checksAt(target.policy, 'output', OUTPUT_CHECK_ORDER).filter(
        // The contract is decided below, once, so its action cannot change the outcome (D85).
        (check) => check.type !== 'contract',
      );

      /*
       * `secret_leak` runs on the text the model actually produced, *before* the data guardrail
       * masks it. The order matters and is not cosmetic: masking first would leave the check looking
       * at `[api_key redacted]`, it would pass, and a policy set to `block` would never block —
       * which is TC-GRD-010's whole point. D86 says the mask happens whatever the policy, not that
       * it happens instead of the check.
       */
      const leakCheck = ordered.find((check) => check.type === 'secret_leak');
      let flowing = [...parts];

      if (leakCheck !== undefined) {
        const leak = runner.evaluate(leakCheck, {
          point: 'output',
          text: textOf(flowing),
          parts: flowing,
        });

        if (leak !== undefined) {
          const applied = await apply(target, leakCheck, leak, flowing, collected);
          if (applied.kind === 'failed') {
            return {
              kind: 'failed',
              parts: flowing,
              verdicts: collected,
              failureReason: 'GUARDRAIL_VIOLATION',
              error: applied.error,
            };
          }
          flowing = applied.parts;
        }
      }

      // D86: whatever the policy said above, and even with no policy at all.
      const masked = await maskSecrets(target, flowing, collected);

      const outcome = await runPoint(
        target,
        ordered.filter((check) => check.type !== 'secret_leak'),
        masked,
        collected,
        { ...(contract === undefined ? {} : { contract }) },
      );
      if (outcome.kind === 'failed') return outcome;

      if (contract === undefined) return outcome;

      /* The contract, last and on the sanitized parts (§4 item 4). */
      const check = validateAgainstContract(outcome.parts, contract);
      const declared = (target.policy?.checks ?? []).find(
        (candidate) =>
          candidate.point === 'output' && candidate.type === 'contract' && candidate.enabled,
      );

      if (!check.ok && declared !== undefined) {
        collected.push(await recordCheck(target, declared, { passed: false, reason: check.reason }));
      }

      if (check.ok) return { kind: 'continue', parts: outcome.parts, verdicts: collected };

      // D85: CONTRACT_VIOLATION, never GUARDRAIL_VIOLATION, and never softened to a warning. The
      // error kind is `agent` because the model answered — it just answered wrongly (Arch §28).
      return {
        kind: 'failed',
        parts: outcome.parts,
        verdicts: collected,
        failureReason: 'CONTRACT_VIOLATION',
        error: {
          kind: 'agent',
          code: 'contract_violation',
          message: check.reason,
          retryable: false,
        },
      };
    },

    async evaluateLoop({ target, loop }) {
      const collected: Verdict[] = [];
      let stop: LoopStopReason | undefined;

      for (const check of target.policy?.checks ?? []) {
        if (!check.enabled || check.point !== 'loop') continue;

        const outcome = runner.evaluate(check, {
          point: 'loop',
          text: '',
          loop,
        });
        if (outcome === undefined) continue;

        if (outcome.passed) continue;
        collected.push(await recordCheck(target, check, outcome));

        // `pass` and `warn` record the verdict and let the loop turn again; anything stronger stops
        // it. There is no node to put in WAITING here — the decision is about the loop, not an
        // output — so `ask_user` stops it too, with the reason the check gave (§2.4).
        if (check.action === 'pass' || check.action === 'warn') continue;

        stop ??= loopStopFor(check.type);
      }

      return { ...(stop === undefined ? {} : { stop }), verdicts: collected };
    },
  };
}

/** Which of §2.4's stop reasons a loop check maps to. */
function loopStopFor(type: GuardrailCheckType): LoopStopReason {
  // `max_tool_calls` has no stop reason of its own in §2.4; a node that has spent its tool budget
  // has nothing left to do differently, so the loop stops the way a spent iteration budget does.
  return type === 'repeated_output' ? 'repeated_output' : 'max_iterations';
}

/* -------------------------------------------------------------------------- */
/* The tool point (round 4 §2.2, FR-GRD-005/006, FR-TOOL-002)                  */
/* -------------------------------------------------------------------------- */

/**
 * The order the tool point runs its checks in. `tool_allowed` first (a call to a tool the agent
 * never switched on is judged before its arguments are looked at); then arguments (`checkToolArgs`,
 * D217 — see the evaluator); then the confinement checks; then `destructive_action` last, because
 * it is the one that may put the node in front of a person, and there is no point asking for
 * approval of a call that a cheaper check would have blocked anyway.
 */
export const TOOL_CHECK_ORDER = [
  'tool_allowed',
  'path_confinement',
  'domain_allowlist',
  'destructive_action',
] as const satisfies readonly GuardrailCheckType[];

/** Validates a tool call's arguments against its `inputSchema` (D217) — `@ace/guardrails`' checkToolArgs. */
export type ToolArgsValidator = (
  definition: ToolDefinition,
  args: unknown,
) => CheckOutcome | undefined;

export interface ToolGuardrailEvaluatorDeps {
  scope: Scope;
  /** The pure tool-point checks, reached through the same runner the other points use (Arch §13.2). */
  checks: CheckRunner;
  verdicts: GuardrailVerdictRepository;
  bus: EventBus;
  /**
   * Args validation, an always-on precondition rather than a policy check (D217). Absent → the tool
   * itself re-parses its arguments and args are not pre-checked here; the gateway wires
   * `@ace/guardrails`' `checkToolArgs`.
   */
  validateArgs?: ToolArgsValidator;
  /** For a destructive tool's `ask_user`. Absent → `ask_user` is a block (safe by default, D10). */
  approvals?: ApprovalGate;
  now?: () => string;
  nextId?: () => string;
}

/** Read a policy's `max_tool_calls` cap: a positive integer under `params.max` / `params.maxToolCalls`. */
function toolCallCapOf(policy: GuardrailPolicy | null): number | undefined {
  const check = (policy?.checks ?? []).find(
    (candidate) =>
      candidate.enabled && candidate.point === 'loop' && candidate.type === 'max_tool_calls',
  );
  if (check === undefined) return undefined;
  const raw = check.params['max'] ?? check.params['maxToolCalls'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined;
}

/**
 * The tool point of the guardrail engine (round 4 §2.2, FR-GRD-005/006, FR-TOOL-002).
 *
 * It runs `checkToolArgs` (D217) and the four tool-point policy checks through the same
 * `CheckRunner` the other points use, records a verdict for every check that triggered, and turns
 * each `action` into a consequence: a `block` (or any non-`warn` action other than a destructive
 * `ask_user`) stops the call as a `block` step; a destructive tool's `ask_user` opens the Round 3
 * approval card and a reject stops the call as a `reject` step. It never runs a tool and never
 * imports `@ace/guardrails` — the checks arrive through the runner, args validation as an injected
 * function — so the executor only ever sees the `ToolGuardStep` it returns.
 */
export function createToolGuardrailEvaluator(
  deps: ToolGuardrailEvaluatorDeps,
): ToolGuardrailEvaluator {
  const { scope, checks: runner, verdicts: store, bus } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function record(target: ToolGuardrailTarget, verdict: Verdict): Promise<Verdict> {
    const stored = await store.append(scope, verdict);
    if (stored.action !== 'pass') {
      await bus.emit({
        type: 'guardrail.verdict',
        workflowId: target.workflowId,
        runId: target.runId,
        payload: { runId: target.runId, nodeRunId: target.nodeRunId, verdict: stored },
      });
    }
    return stored;
  }

  function recordCheck(
    target: ToolGuardrailTarget,
    check: GuardrailCheck,
    outcome: CheckOutcome,
  ): Promise<Verdict> {
    return record(
      target,
      verdictFor(check, outcome, { id: nextId(), nodeRunId: target.nodeRunId, at: now() }),
    );
  }

  /** The checks of the resolved policy at the tool point, enabled only, in `TOOL_CHECK_ORDER`. */
  function toolChecks(policy: GuardrailPolicy | null): GuardrailCheck[] {
    const applicable = (policy?.checks ?? []).filter(
      (check) => check.enabled && check.point === 'tool',
    );
    const rank = (type: GuardrailCheckType): number => {
      const index = (TOOL_CHECK_ORDER as readonly GuardrailCheckType[]).indexOf(type);
      return index === -1 ? TOOL_CHECK_ORDER.length : index;
    };
    return [...applicable].sort((a, b) => rank(a.type) - rank(b.type));
  }

  return {
    toolCallCap: toolCallCapOf,

    async evaluateTool({ target, ...bag }) {
      const verdicts: Verdict[] = [];
      const input: CheckInput = { point: 'tool', text: '', tool: bag };

      for (const check of toolChecks(target.policy)) {
        // `destructive_action` is the approval; the other three are plain block/warn checks.
        const step =
          check.type === 'destructive_action'
            ? await runDestructive(target, check, input, bag, verdicts)
            : await runToolCheck(target, check, input, verdicts);
        if (step !== undefined) return step;

        // Arguments are validated right after `tool_allowed` (D217): a precondition, not a policy
        // check, so it records no verdict and a failure is always a `block` (FR-GRD-012).
        if (check.type === 'tool_allowed' && deps.validateArgs !== undefined) {
          const argsStep = validateArgsStep(bag, verdicts);
          if (argsStep !== undefined) return argsStep;
        }
      }

      // No `tool_allowed` check in the policy? Still validate arguments (D217, safe by default).
      if (
        deps.validateArgs !== undefined &&
        !toolChecks(target.policy).some((check) => check.type === 'tool_allowed')
      ) {
        const argsStep = validateArgsStep(bag, verdicts);
        if (argsStep !== undefined) return argsStep;
      }

      return { kind: 'allow', verdicts };
    },
  };

  function validateArgsStep(bag: ToolPointInput, verdicts: Verdict[]): ToolGuardStep | undefined {
    const outcome = deps.validateArgs?.(bag.definition, bag.args);
    if (outcome === undefined || outcome.passed) return undefined;
    return { kind: 'block', reason: outcome.reason, verdicts: [...verdicts] };
  }

  /** A `tool_allowed`, `path_confinement` or `domain_allowlist` check. */
  async function runToolCheck(
    target: ToolGuardrailTarget,
    check: GuardrailCheck,
    input: CheckInput,
    verdicts: Verdict[],
  ): Promise<ToolGuardStep | undefined> {
    const outcome = runner.evaluate(check, input);
    if (outcome === undefined || outcome.passed) return undefined;

    verdicts.push(await recordCheck(target, check, outcome));

    // Only `warn` (and the never-used `pass`) let a failing tool call proceed; everything else
    // stops it. A tool point has no text to sanitize, so `redact` cannot be honoured and blocks,
    // and a non-destructive `ask_user` has no approval card of its own, so it blocks too (D10).
    if (check.action === 'pass' || check.action === 'warn') return undefined;
    return { kind: 'block', reason: outcome.reason, verdicts: [...verdicts] };
  }

  /** `destructive_action`: the one tool check whose `ask_user` opens an approval card (BR-14). */
  async function runDestructive(
    target: ToolGuardrailTarget,
    check: GuardrailCheck,
    input: CheckInput,
    bag: ToolPointInput,
    verdicts: Verdict[],
  ): Promise<ToolGuardStep | undefined> {
    const outcome = runner.evaluate(check, input);
    // A passing check means the call is not destructive — nothing to approve.
    if (outcome === undefined || outcome.passed) return undefined;

    verdicts.push(await recordCheck(target, check, outcome));

    if (check.action === 'pass' || check.action === 'warn') return undefined;
    if (check.action !== 'ask_user') {
      return { kind: 'block', reason: outcome.reason, verdicts: [...verdicts] };
    }

    if (deps.approvals === undefined) {
      return {
        kind: 'block',
        reason: `${outcome.reason} No approver is available, so it was blocked.`,
        verdicts: [...verdicts],
      };
    }

    const decision = await deps.approvals.request({
      runId: target.runId,
      workflowId: target.workflowId,
      nodeRunId: target.nodeRunId,
      nodeId: target.nodeId,
      nodeName: target.nodeName,
      point: 'tool',
      checkType: 'destructive_action',
      reason: outcome.reason,
      // The card shows the tool and its arguments with secret-shaped values masked (BR-07).
      preview: previewOf(`${bag.definition.name} ${JSON.stringify(redactArgs(bag.args))}`),
      ...(target.signal === undefined ? {} : { signal: target.signal }),
    });

    if (decision.decision === 'reject') {
      const note = decision.note === undefined ? '' : ` (${decision.note})`;
      return {
        kind: 'reject',
        reason: `A reviewer rejected this tool call${note}: ${outcome.reason}`,
        verdicts: [...verdicts],
      };
    }

    // Approved: the call runs (FR-GRD-013).
    return undefined;
  }
}
