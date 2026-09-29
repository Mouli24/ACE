import type {
  ChatVerdict,
  GuardrailCheck,
  GuardrailCheckType,
  GuardrailPolicy,
  Part,
} from '@ace/contracts';

import type { CheckOutcome, CheckRunner, SecretMasker } from '../guardrails/checks.js';
import { OUTPUT_CHECK_ORDER, textOf, transformPart } from '../guardrails/evaluator.js';

/**
 * The guardrail evaluation a direct chat runs (FR-CHAT-008, FR-GRD-011, D10, D86).
 *
 * It is the run evaluator's logic without a node run: a direct chat touches no `runs`/`node_runs`
 * (FR-CHAT-005), so it stores no `Verdict` (which carries a `nodeRunId`) — it produces `ChatVerdict`s
 * that ride the `ChatMessage` instead. The consequences are the run's: a `block` (or an `ask_user`,
 * which no reviewer is watching a chat to answer, so it is treated as `block` — safe by default)
 * stops the turn; a `redact` rewrites the text; `warn`/`pass` let it through with a verdict recorded.
 * The data guardrail masks credential-shaped values from a reply whatever the policy says (BR-15).
 */

export interface ChatGuardrailDeps {
  checks: CheckRunner;
  masker: SecretMasker;
  now: () => string;
  nextId: () => string;
}

/** The chat input or reply passed the policy — carry on with these (possibly redacted) parts. */
export interface ChatGuardrailOk {
  kind: 'ok';
  parts: Part[];
  verdicts: ChatVerdict[];
}

/** A `block` fired: the input is refused (422), or the reply becomes `[blocked by guardrail: …]`. */
export interface ChatGuardrailBlocked {
  kind: 'blocked';
  reason: string;
  verdicts: ChatVerdict[];
}

export type ChatGuardrailResult = ChatGuardrailOk | ChatGuardrailBlocked;

/** A stored chat verdict — a `Verdict` without its `nodeRunId` (round 3 §2.2, FR-CHAT-005). */
function chatVerdict(
  check: GuardrailCheck,
  outcome: CheckOutcome,
  deps: ChatGuardrailDeps,
): ChatVerdict {
  return {
    id: deps.nextId(),
    point: check.point,
    checkType: check.type,
    action: check.action,
    passed: outcome.passed,
    reason: outcome.reason,
    ...(outcome.redactedTypes === undefined || outcome.redactedTypes.length === 0
      ? {}
      : { redactedTypes: [...outcome.redactedTypes] }),
    at: deps.now(),
  };
}

/** The enabled checks of a policy at one point, optionally ranked by a fixed order (§4 item 4). */
function checksAt(
  policy: GuardrailPolicy | null,
  point: 'input' | 'output',
  order?: readonly GuardrailCheckType[],
): GuardrailCheck[] {
  const applicable = (policy?.checks ?? []).filter(
    (check) => check.enabled && check.point === point,
  );
  if (order === undefined) return applicable;

  return [...applicable].sort((a, b) => {
    const ia = order.indexOf(a.type);
    const ib = order.indexOf(b.type);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
}

/**
 * Apply one triggered check's action to the parts flowing through, mirroring the run evaluator: a
 * `block`/`ask_user` fails, a `redact` sanitizes every part, `warn`/`pass` continue. `undefined`
 * from the runner means it has no implementation for this check type, so nothing happens.
 */
function applyCheck(
  check: GuardrailCheck,
  parts: Part[],
  deps: ChatGuardrailDeps,
  verdicts: ChatVerdict[],
): { kind: 'continue'; parts: Part[] } | { kind: 'blocked'; reason: string } {
  const outcome = deps.checks.evaluate(check, {
    point: check.point,
    text: textOf(parts),
    parts,
  });
  if (outcome === undefined || outcome.passed) return { kind: 'continue', parts };

  verdicts.push(chatVerdict(check, outcome, deps));

  if (check.action === 'block' || check.action === 'ask_user') {
    return { kind: 'blocked', reason: outcome.reason };
  }

  if (check.action === 'redact') {
    if (outcome.sanitized === undefined) return { kind: 'blocked', reason: outcome.reason };
    const redacted = parts.map((part) =>
      transformPart(part, (text) => {
        const per = deps.checks.evaluate(check, { point: check.point, text, parts: [part] });
        return per?.sanitized;
      }),
    );
    return { kind: 'continue', parts: redacted };
  }

  // `warn` and `pass` both continue; the verdict above is the only difference.
  return { kind: 'continue', parts };
}

/** The data guardrail, unconditional (FR-GRD-010, BR-15, D86): mask every credential-shaped value. */
function maskSecrets(parts: Part[], deps: ChatGuardrailDeps, verdicts: ChatVerdict[]): Part[] {
  const found = new Set<string>();
  const masked = parts.map((part) =>
    transformPart(part, (text) => {
      const result = deps.masker.mask(text);
      if (result.types.length === 0) return undefined;
      for (const type of result.types) found.add(type);
      return result.text;
    }),
  );

  if (found.size === 0) return parts;

  verdicts.push({
    id: deps.nextId(),
    point: 'data',
    checkType: 'secret_leak',
    action: 'redact',
    passed: false,
    reason: 'Credential-shaped values were masked before this reply was stored or shown.',
    redactedTypes: [...found],
    at: deps.now(),
  });
  return masked;
}

/**
 * The input point of a direct chat (FR-CHAT-008). A `block` returns `blocked`, which the service
 * turns into the 422 `guardrail_blocked` with these verdicts; otherwise the (possibly redacted)
 * user parts flow into the prompt.
 */
export function evaluateChatInput(
  policy: GuardrailPolicy | null,
  parts: readonly Part[],
  deps: ChatGuardrailDeps,
): ChatGuardrailResult {
  const verdicts: ChatVerdict[] = [];
  let flowing = [...parts];

  for (const check of checksAt(policy, 'input')) {
    const applied = applyCheck(check, flowing, deps, verdicts);
    if (applied.kind === 'blocked') return { kind: 'blocked', reason: applied.reason, verdicts };
    flowing = applied.parts;
  }

  return { kind: 'ok', parts: flowing, verdicts };
}

/**
 * The output point of a direct chat (FR-CHAT-008, D85, D86). `secret_leak` runs on what the model
 * produced *before* the data guardrail masks it — masking first would leave a `block` policy nothing
 * to block (TC-GRD-010) — then the mask happens whatever the policy said, then the remaining output
 * checks in their fixed order. There is no output contract in a chat, so `contract` never runs here.
 */
export function evaluateChatReply(
  policy: GuardrailPolicy | null,
  parts: readonly Part[],
  deps: ChatGuardrailDeps,
): ChatGuardrailResult {
  const verdicts: ChatVerdict[] = [];
  const ordered = checksAt(policy, 'output', OUTPUT_CHECK_ORDER).filter(
    (check) => check.type !== 'contract',
  );
  let flowing = [...parts];

  const leak = ordered.find((check) => check.type === 'secret_leak');
  if (leak !== undefined) {
    const applied = applyCheck(leak, flowing, deps, verdicts);
    if (applied.kind === 'blocked') return { kind: 'blocked', reason: applied.reason, verdicts };
    flowing = applied.parts;
  }

  flowing = maskSecrets(flowing, deps, verdicts);

  for (const check of ordered.filter((check) => check.type !== 'secret_leak')) {
    const applied = applyCheck(check, flowing, deps, verdicts);
    if (applied.kind === 'blocked') return { kind: 'blocked', reason: applied.reason, verdicts };
    flowing = applied.parts;
  }

  return { kind: 'ok', parts: flowing, verdicts };
}
