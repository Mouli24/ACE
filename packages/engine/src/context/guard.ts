import {
  GUARDRAIL_CHECK_TYPES_BY_POINT,
  HIDDEN_INSTRUCTION_TYPES,
  type GuardrailCheck,
  type GuardrailCheckType,
  type GuardrailPolicy,
  type HiddenInstructionType,
  type KbDocumentVerdict,
  type NodeError,
  type Verdict,
} from '@ace/contracts';

import type { CheckInput, CheckOutcome, CheckRunner } from '../guardrails/checks.js';
import { verdictFor, type EvaluationTarget } from '../guardrails/evaluator.js';
import type { PolicyService } from '../guardrails/policy-service.js';
import { newId } from '../ids.js';
import type { ContextTextCheck } from '../ports/index.js';

/**
 * The context point of the guardrail engine (round 5 §2.3, FR-GRD-004, TC-GRD-005, Arch §13.1).
 *
 * Everything that reaches a prompt without a person having typed it — a retrieved chunk, a memory
 * value, an upstream output, a tool result — passes through `sanitise` first. It runs the resolved
 * policy's enabled context checks through the same injected `CheckRunner` the other points use
 * (Arch §13.2: the engine never imports `@ace/guardrails`), in the contract's context order —
 * `untrusted_tagging`, `prompt_injection`, `pii` — and turns each finding into its consequence:
 *
 * - `prompt_injection` strips hidden instructions at `warn`, `redact` and `block` and only reports at
 *   `pass` (F13: §2.3's `warn` "sanitises"); `block` also fails the node.
 * - `pii` redacts at `redact`, reports at `warn` and `pass`, and fails the node at `block`.
 * - `ask_user` fails the node: there is no approval step at the context point, and content nobody
 *   approved must not reach a prompt (D10, safe by default).
 * - `untrusted_tagging` never decides anything. Tagging is unconditional (BR-13, D232) — the
 *   envelope's `trust` and the prompt manager's untrusted label do it — whatever a stored check says.
 *
 * A check that triggered makes one verdict (D114: nothing for a clean pass), naming what was
 * stripped or redacted and never the text (FR-GRD-014). `strippedTypes` is set only when something
 * was taken out — never at `pass`, which strips nothing; the reason names the kinds found by count.
 *
 * **Fail closed.** A finding the runner cannot act on — a strip or a redaction with no `sanitized`
 * text — refuses the content rather than letting the raw text through, and so does an enabled check
 * the runner does not answer at all (`context_check_unavailable`): unlike the other points, silence
 * here would let unjudged text into a prompt.
 *
 * **Residue.** The rule pack strips to a fixed point bounded at a few iterations, so text built to
 * need more can come back still hiding something. Once anything has been rewritten, the context
 * `prompt_injection` check runs once more over the result; if it still finds anything the node fails
 * `GUARDRAIL_VIOLATION` (`context_injection_residue`) whatever the configured action. That verdict
 * names no stripped kinds — nothing more was stripped — and its reason says what remained, by count.
 *
 * **Judging and recording are separate.** `inspect` judges and returns verdicts not yet stored;
 * `record` stores and emits them through the evaluator's `record` (FR-GRD-015). The context builder
 * uses the two so that only content it finally places leaves a verdict; `sanitise` is both at once.
 */

export type ContextLabel = 'retrieved' | 'memory' | 'upstream' | 'tool';

export type SanitiseResult =
  | { kind: 'continue'; text: string; verdicts: Verdict[] }
  | { kind: 'failed'; error: NodeError; verdicts: Verdict[] };

export interface SanitiseInput {
  target: EvaluationTarget;
  label: ContextLabel;
  text: string;
}

export interface ContextGuard {
  /** Judge, act and record: `inspect` followed by `record`. */
  sanitise(input: SanitiseInput): Promise<SanitiseResult>;
  /** Judge and act, recording nothing: the verdicts come back unstored. */
  inspect(input: SanitiseInput): Promise<SanitiseResult>;
  /** Store and emit verdicts `inspect` returned, in order; answers them as stored. */
  record(target: EvaluationTarget, verdicts: readonly Verdict[]): Promise<Verdict[]>;
  /**
   * The ingestion-time check (F6, Arch §21.3): the project's **default** policy's context `pii` check
   * over a document's full text before it is chunked. Hidden instructions are deliberately left for
   * retrieval time, where the node run records what was stripped (TC-GRD-005). The verdicts belong
   * to the document (`KbDocumentVerdict`, no node run), so nothing is stored or emitted here.
   */
  checkIngestText: ContextTextCheck;
}

export interface ContextGuardDeps {
  /** Resolves the project default for ingestion; a run's policy arrives on its `EvaluationTarget`. */
  policies: Pick<PolicyService, 'resolve'>;
  /** The check runner every guardrail point uses — `@ace/guardrails`, wired by the server. */
  evaluator: CheckRunner;
  /** Stores and emits a node-run verdict: the guardrail evaluator's own `record` (FR-GRD-015). */
  record: (target: EvaluationTarget, verdict: Verdict) => Promise<Verdict>;
  now?: () => string;
  nextId?: () => string;
}

/** What a verdict's reason says about where the finding was, so the inspector can tell them apart. */
const WHERE: Record<ContextLabel, string> = {
  retrieved: 'a retrieved chunk',
  memory: 'a memory value',
  upstream: 'an upstream output',
  tool: 'a tool result',
};

const INGESTED = 'a document being ingested';

/** The contract's order for the context point (D232). */
const CONTEXT_ORDER: readonly GuardrailCheckType[] = GUARDRAIL_CHECK_TYPES_BY_POINT.context;

/** The enabled context checks of a policy, in `CONTEXT_ORDER`, policy order within a type. */
function contextChecksOf(policy: GuardrailPolicy | null): GuardrailCheck[] {
  const rank = (type: GuardrailCheckType): number => {
    const index = CONTEXT_ORDER.indexOf(type);
    return index === -1 ? CONTEXT_ORDER.length : index;
  };
  return (policy?.checks ?? [])
    .filter((check) => check.enabled && check.point === 'context')
    .map((check, position) => ({ check, position }))
    .sort((a, b) => rank(a.check.type) - rank(b.check.type) || a.position - b.position)
    .map(({ check }) => check);
}

const isHiddenInstructionType = (value: unknown): value is HiddenInstructionType =>
  typeof value === 'string' && (HIDDEN_INSTRUCTION_TYPES as readonly string[]).includes(value);

/**
 * The kinds a context `prompt_injection` check stripped. The rule pack answers them beside the
 * outcome the runner interface declares; only names from the closed contract list survive, so a
 * verdict can never carry anything but a type (FR-GRD-014, D232).
 */
function strippedTypesOf(outcome: CheckOutcome): HiddenInstructionType[] {
  if (!('strippedTypes' in outcome) || !Array.isArray(outcome.strippedTypes)) return [];
  return [...new Set(outcome.strippedTypes.filter(isHiddenInstructionType))];
}

const inputFor = (text: string): CheckInput => ({
  point: 'context',
  text,
  parts: [{ type: 'text', text }],
});

const blocked = (check: GuardrailCheck, message: string): NodeError => ({
  kind: 'guardrail',
  code: `guardrail_${check.type}`,
  message,
  retryable: false,
  details: { point: check.point, checkType: check.type, action: check.action },
});

type Consequence = { kind: 'continue'; text?: string } | { kind: 'failed'; error: NodeError };

/** One finding's consequence under its check's action. `text` is set when the content is rewritten. */
function consequenceOf(check: GuardrailCheck, outcome: CheckOutcome, reason: string): Consequence {
  switch (check.action) {
    case 'pass':
      return { kind: 'continue' };
    case 'warn':
      // F13: at the context point `warn` strips hidden instructions; for any other check it reports.
      if (check.type !== 'prompt_injection') return { kind: 'continue' };
      return outcome.sanitized === undefined
        ? {
            kind: 'failed',
            error: blocked(check, `${reason} It could not be removed, so it was blocked.`),
          }
        : { kind: 'continue', text: outcome.sanitized };
    case 'redact':
      return outcome.sanitized === undefined
        ? {
            kind: 'failed',
            error: blocked(check, `${reason} It could not be redacted, so it was blocked.`),
          }
        : { kind: 'continue', text: outcome.sanitized };
    case 'ask_user':
      return {
        kind: 'failed',
        error: blocked(
          check,
          `${reason} The context point has no approval step, so it was blocked.`,
        ),
      };
    case 'block':
      return { kind: 'failed', error: blocked(check, reason) };
  }
}

/** An enabled check the runner did not answer: refused, because silence would let unjudged text in. */
const unavailable = (check: GuardrailCheck, where: string): NodeError => ({
  kind: 'guardrail',
  code: 'context_check_unavailable',
  message: `The ${check.type} check at the context point could not be evaluated, so ${where} was refused.`,
  retryable: false,
  details: { point: check.point, checkType: check.type, action: check.action },
});

export function createContextGuard(deps: ContextGuardDeps): ContextGuard {
  const { evaluator: runner } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /**
   * A verdict for a finding: types only. `strippedTypes` only when the action took something out —
   * at `pass` nothing was, and the reason already names what was found by kind and count.
   */
  function verdictOf(
    check: GuardrailCheck,
    outcome: CheckOutcome,
    reason: string,
    nodeRunId: string,
  ): Verdict {
    const verdict = verdictFor(
      check,
      { ...outcome, reason },
      { id: nextId(), nodeRunId, at: now() },
    );
    const stripped = check.action === 'pass' ? [] : strippedTypesOf(outcome);
    return stripped.length === 0 ? verdict : { ...verdict, strippedTypes: stripped };
  }

  /** The once-only re-check after a rewrite; a failure names the residue's kinds, never its text. */
  function residueOf(
    target: EvaluationTarget,
    checks: readonly GuardrailCheck[],
    text: string,
    where: string,
    verdicts: Verdict[],
  ): NodeError | undefined {
    // With `prompt_injection` at `pass` (or off) hidden content is allowed through, so there is no
    // residue to judge; at `block`/`ask_user` a finding has already failed the node.
    const injection = checks.find(
      (check) => check.type === 'prompt_injection' && check.action !== 'pass',
    );
    if (injection === undefined) return undefined;

    const again = runner.evaluate(injection, inputFor(text));
    if (again === undefined) return unavailable(injection, where);
    if (again.passed) return undefined;

    // Nothing more was stripped, so the verdict carries no `strippedTypes`: the runner's reason
    // names what remained by kind and count (the rule pack never quotes, FR-GRD-014).
    const reason = `Hidden instructions remained after stripping (${again.reason}), so ${where} was refused.`;
    const { strippedTypes: _notStripped, ...verdict } = verdictOf(
      injection,
      again,
      reason,
      target.nodeRunId,
    );
    verdicts.push({ ...verdict, action: 'block' });
    return {
      kind: 'guardrail',
      code: 'context_injection_residue',
      message: reason,
      retryable: false,
      details: { point: 'context', checkType: 'prompt_injection', action: 'block' },
    };
  }

  /** Judge `text` against the target's context checks and act on each finding; record nothing. */
  async function inspect({ target, label, text }: SanitiseInput): Promise<SanitiseResult> {
    const where = WHERE[label];
    const checks = contextChecksOf(target.policy);
    const verdicts: Verdict[] = [];
    let current = text;
    let rewritten = false;

    for (const check of checks) {
      const outcome = runner.evaluate(check, inputFor(current));
      if (outcome === undefined) {
        return { kind: 'failed', error: unavailable(check, where), verdicts };
      }
      // A clean pass records nothing (D114).
      if (outcome.passed) continue;

      const reason = `${outcome.reason} (in ${where})`;
      verdicts.push(verdictOf(check, outcome, reason, target.nodeRunId));

      // D232: tagging is unconditional and only tags; its stored action decides nothing.
      if (check.type === 'untrusted_tagging') continue;

      const consequence = consequenceOf(check, outcome, reason);
      if (consequence.kind === 'failed') {
        return { kind: 'failed', error: consequence.error, verdicts };
      }
      if (consequence.text !== undefined) {
        current = consequence.text;
        rewritten = true;
      }
    }

    if (rewritten) {
      const residue = residueOf(target, checks, current, where, verdicts);
      if (residue !== undefined) return { kind: 'failed', error: residue, verdicts };
    }

    return { kind: 'continue', text: current, verdicts };
  }

  async function record(
    target: EvaluationTarget,
    verdicts: readonly Verdict[],
  ): Promise<Verdict[]> {
    const stored: Verdict[] = [];
    for (const verdict of verdicts) stored.push(await deps.record(target, verdict));
    return stored;
  }

  return {
    inspect,
    record,

    async sanitise(input) {
      const result = await inspect(input);
      const verdicts = await record(input.target, result.verdicts);
      return { ...result, verdicts };
    },

    async checkIngestText({ projectId, text }) {
      // F6: no node exists at ingestion, so no agent override either — the project default decides.
      const policy = await deps.policies.resolve(projectId);
      const pii = contextChecksOf(policy).find((check) => check.type === 'pii');
      if (pii === undefined) return { text, verdicts: [] };

      const outcome = runner.evaluate(pii, inputFor(text));
      if (outcome === undefined) {
        return { text, verdicts: [], blocked: unavailable(pii, INGESTED).message };
      }
      if (outcome.passed) return { text, verdicts: [] };

      const reason = `${outcome.reason} (in ${INGESTED})`;
      const { nodeRunId: _nodeRunId, ...verdict } = verdictOf(pii, outcome, reason, '');
      const documentVerdict: KbDocumentVerdict = verdict;

      const consequence = consequenceOf(pii, outcome, reason);
      if (consequence.kind === 'failed') {
        return { text, verdicts: [documentVerdict], blocked: consequence.error.message };
      }
      return { text: consequence.text ?? text, verdicts: [documentVerdict] };
    },
  };
}
