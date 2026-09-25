import {
  type GuardrailCheck,
  type PolicyGuardrailPoint,
  type PolicyTestVerdict,
} from '@ace/contracts';

/**
 * The mock engine's guardrail checks (round 3 §2.2, FR-GRD-003/010/011/014). The real packs live in
 * `packages/guardrails`; these exist so the policy editor's Test panel, the verdict list and the
 * scenarios can be built and tested before A3 lands, and so both sides agree on the shape of a
 * verdict: a reason a person can read, and for a redaction the *types* that were removed and never
 * the value (FR-GRD-014).
 *
 * The patterns are deliberately the ones §4 item 3 of the round file names, kept simple enough to
 * read: this is a stand-in, not the engine's rule pack.
 */

/** What one check decided about one piece of text. */
export interface CheckOutcome {
  passed: boolean;
  reason: string;
  /** Type names such as `email` — never the matched value (FR-GRD-014). */
  redactedTypes?: string[];
  /** The text as it would flow on when the action is `redact`. */
  sanitized?: string;
}

interface Pattern {
  /** A lower-case type name, so it can go on a verdict as it stands. */
  type: string;
  regex: RegExp;
  replacement?: string;
}

const PII_PATTERNS: readonly Pattern[] = [
  { type: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { type: 'phone', regex: /(?:\+\d{1,3}[ -]?)?(?:\(?\d{3}\)?[ -]?)\d{3}[ -]?\d{4}/g },
  { type: 'credit_card', regex: /\b(?:\d[ -]?){13,16}\b/g },
  { type: 'iban', regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,26}\b/g },
];

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above) instructions/i,
  /disregard the system prompt/i,
  /you are now/i,
  /print your system prompt/i,
  new RegExp('[\u200b-\u200f\u2060\ufeff]'),
];

/** Key *shapes*, never a key: the prefixes are what a leak looks like (BR-07, FR-GRD-010). */
const SECRET_PATTERNS: readonly Pattern[] = [
  { type: 'api_key', regex: new RegExp(`${['sk', 'ant'].join('-')}-[A-Za-z0-9_-]{8,}`, 'g') },
  { type: 'api_key', regex: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { type: 'api_key', regex: /\bAIza[A-Za-z0-9_-]{8,}/g },
  { type: 'api_key', regex: /\bghp_[A-Za-z0-9]{8,}/g },
  { type: 'aws_access_key', regex: /\bAKIA[A-Z0-9]{8,}/g },
  { type: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const MODERATION_WORDS: readonly string[] = ['hate', 'kill', 'slur', 'weapon'];

const CITATION_MARKER = '[source:';

const pass = (reason: string): CheckOutcome => ({ passed: true, reason });

/** Replace every match with `[<type> redacted]`, and report which types were hit. */
function redactAll(text: string, patterns: readonly Pattern[]): CheckOutcome | undefined {
  const types = new Set<string>();
  let sanitized = text;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(new RegExp(pattern.regex.source, 'g'), (match) => {
      // a phone pattern can swallow a bare number inside a longer id; only count real matches
      if (match.trim() === '') return match;
      types.add(pattern.type);
      return `[${pattern.type} redacted]`;
    });
  }
  if (types.size === 0) return undefined;
  return {
    passed: false,
    reason: `Found ${[...types].join(', ')}.`,
    redactedTypes: [...types].sort(),
    sanitized,
  };
}

/**
 * Run one check over one piece of text. `undefined` means the check has nothing to say at this
 * point — a cost or loop check, which the scheduler decides, not a text pack.
 */
export function evaluateCheck(check: GuardrailCheck, text: string): CheckOutcome | undefined {
  switch (check.type) {
    case 'size_limit': {
      const maxChars = typeof check.params.maxChars === 'number' ? check.params.maxChars : 200_000;
      return text.length > maxChars
        ? {
            passed: false,
            reason: `${text.length} characters is over the ${maxChars}-character limit.`,
            sanitized: text.slice(0, maxChars),
          }
        : pass(`${text.length} characters is within the ${maxChars}-character limit.`);
    }
    case 'pii':
      return redactAll(text, PII_PATTERNS) ?? pass('No personal data found.');
    case 'prompt_injection': {
      const hit = INJECTION_PATTERNS.find((pattern) => pattern.test(text));
      return hit === undefined
        ? pass('No injection pattern found.')
        : { passed: false, reason: 'The text tries to override the instructions.' };
    }
    case 'blocked_topics': {
      const patterns = Array.isArray(check.params.patterns)
        ? check.params.patterns.filter((p): p is string => typeof p === 'string')
        : [];
      const hit = patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
      return hit === undefined
        ? pass('No blocked topic found.')
        : { passed: false, reason: `Mentions the blocked topic "${hit}".` };
    }
    case 'secret_leak':
      return redactAll(text, SECRET_PATTERNS) ?? pass('No key-shaped string found.');
    case 'moderation': {
      const hit = MODERATION_WORDS.find((word) => new RegExp(`\\b${word}`, 'i').test(text));
      return hit === undefined
        ? pass('Nothing to flag.')
        : { passed: false, reason: `Flagged wording: "${hit}".` };
    }
    case 'required_citations':
      return text.includes(CITATION_MARKER)
        ? pass('Sources are cited.')
        : { passed: false, reason: `No ${CITATION_MARKER} marker in the output.` };
    case 'contract':
      // the contract check needs the node's schema, which a pasted string does not have
      return undefined;
    default:
      // cost and loop checks are the scheduler's, and tool/context checks arrive in rounds 4–5
      return undefined;
  }
}

/**
 * Every enabled check of this policy at this point, in policy order (§2.2). A check that has
 * nothing to say about pasted text is left out rather than reported as a pass it did not make.
 * A tested verdict belongs to no node run, so it is a `PolicyTestVerdict` — the same shape as a
 * stored one, minus the two ids (FR-GRD-001).
 */
export function testPolicy(
  checks: readonly GuardrailCheck[],
  point: PolicyGuardrailPoint,
  text: string,
  at = new Date().toISOString(),
): PolicyTestVerdict[] {
  const verdicts: PolicyTestVerdict[] = [];
  for (const check of checks) {
    if (!check.enabled || check.point !== point) continue;
    const outcome = evaluateCheck(check, text);
    if (outcome === undefined) continue;
    verdicts.push({
      point: check.point,
      checkType: check.type,
      action: check.action,
      passed: outcome.passed,
      reason: outcome.reason,
      ...(outcome.redactedTypes === undefined ? {} : { redactedTypes: outcome.redactedTypes }),
      at,
    });
  }
  return verdicts;
}
