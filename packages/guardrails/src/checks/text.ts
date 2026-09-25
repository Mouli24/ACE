/**
 * The text checks: `size_limit`, `pii`, `prompt_injection`, `blocked_topics`, `moderation`,
 * `secret_leak`, `required_citations` (FR-GRD-003, FR-GRD-007, FR-GRD-011, FR-GRD-014).
 *
 * Every function here is pure and takes the text it judges. None of them decides what happens next:
 * the engine reads `check.action` and applies pass / warn / redact / ask_user / block (Arch §13.3).
 *
 * The one invariant that holds across all of them: **the offending value never appears in the
 * result.** `reason` counts and names types, `redactedTypes` names types, and `sanitized` is the
 * text with the spans already replaced (FR-GRD-014). `JSON.stringify(result)` is therefore safe to
 * store on a `Verdict` and to show in the inspector.
 */

import type { GuardrailCheck } from '@ace/contracts';

import { positiveIntParam, stringArrayParam } from '../params.js';
import { INJECTION_RULES } from '../rule-packs/injection.js';
import { MODERATION_RULES } from '../rule-packs/moderation.js';
import { PII_RULES } from '../rule-packs/pii.js';
import { SECRET_RULES } from '../rule-packs/secrets.js';
import { describeSpans, findSpans, redactSpans, type RulePack } from '../spans.js';
import { redactionMarker, type CheckResult } from '../types.js';

/** The default `size_limit` cap, matching the default policy's `params.maxChars` (round 3 §2.2). */
export const DEFAULT_MAX_CHARS = 200_000;

/* -------------------------------------------------------------------------- */
/* size_limit (FR-GRD-003)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Over `params.maxChars` fails, and `sanitized` is the text truncated to the cap — so a `redact`
 * action on this check means "send the first `maxChars` characters" rather than "send nothing".
 */
export function checkSizeLimit(check: GuardrailCheck, text: string): CheckResult {
  const maxChars = positiveIntParam(check, 'maxChars') ?? DEFAULT_MAX_CHARS;
  if (text.length <= maxChars) {
    return {
      passed: true,
      reason: `${text.length} characters is within the ${maxChars} limit.`,
    };
  }
  return {
    passed: false,
    reason: `${text.length} characters exceeds the ${maxChars}-character limit.`,
    sanitized: text.slice(0, maxChars),
  };
}

/* -------------------------------------------------------------------------- */
/* The pack-driven checks                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One shape for every rule-pack check: find the spans, and if there are any, fail with the counted
 * types and the sanitized text. Nothing but type names and counts crosses back.
 */
function packCheck(text: string, pack: RulePack, label: string, nothing: string): CheckResult {
  const spans = findSpans(text, pack);
  if (spans.length === 0) return { passed: true, reason: nothing };

  const { sanitized, redactedTypes } = redactSpans(text, spans);
  return {
    passed: false,
    reason: `${label}: ${describeSpans(spans)}.`,
    redactedTypes,
    sanitized,
  };
}

/** PII: email, phone, IBAN, card-shaped-and-Luhn-valid, national-id-like (FR-GRD-003, TC-GRD-004). */
export function checkPii(_check: GuardrailCheck, text: string): CheckResult {
  return packCheck(text, PII_RULES, 'Personal data detected', 'No personal data detected.');
}

/** Prompt injection: the phrase pack plus hidden markers (FR-GRD-003, TC-GRD-003). */
export function checkPromptInjection(_check: GuardrailCheck, text: string): CheckResult {
  return packCheck(
    text,
    INJECTION_RULES,
    'Prompt-injection pattern detected',
    'No prompt-injection pattern detected.',
  );
}

/** Moderation: the category word lists. The default action is `warn` (D10, round 3 §2.2). */
export function checkModeration(_check: GuardrailCheck, text: string): CheckResult {
  return packCheck(
    text,
    MODERATION_RULES,
    'Moderation categories matched',
    'No moderation category matched.',
  );
}

/** Secret leak: the key-format pack (FR-GRD-007, TC-GRD-010). Same discipline as `pii`. */
export function checkSecretLeak(_check: GuardrailCheck, text: string): CheckResult {
  return packCheck(
    text,
    SECRET_RULES,
    'Credential-shaped text detected',
    'No credential detected.',
  );
}

/* -------------------------------------------------------------------------- */
/* blocked_topics (FR-GRD-003)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `params.patterns: string[]`, matched case-insensitively.
 *
 * The patterns are matched as **literal substrings**, not as regular expressions. They come from a
 * policy a user typed, and a user-supplied regular expression evaluated on every node's text is both
 * a way to spend the 300 ms of NFR-SAFE-01 on backtracking and a way to make a guardrail throw.
 * Round 3 §2.2 asks only for "case-insensitive"; literal matching is the reading that cannot be
 * turned against the run.
 */
export function checkBlockedTopics(check: GuardrailCheck, text: string): CheckResult {
  const patterns = stringArrayParam(check, 'patterns');
  if (patterns.length === 0) {
    return { passed: true, reason: 'No blocked topics are configured.' };
  }

  const haystack = text.toLowerCase();
  const spans: { start: number; end: number; pattern: string }[] = [];
  for (const pattern of patterns) {
    const needle = pattern.toLowerCase();
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      spans.push({ start: from, end: from + needle.length, pattern });
      from = haystack.indexOf(needle, from + needle.length);
    }
  }

  if (spans.length === 0) {
    return {
      passed: true,
      reason: `None of the ${patterns.length} blocked topics appear.`,
    };
  }

  const matched = [...new Set(spans.map((span) => span.pattern))];
  const ordered = spans.sort((a, b) => a.start - b.start);
  let sanitized = '';
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    sanitized += text.slice(cursor, span.start) + redactionMarker('blocked_topic');
    cursor = span.end;
  }
  sanitized += text.slice(cursor);

  return {
    passed: false,
    reason: `${matched.length} of ${patterns.length} blocked topics appear, ${spans.length} time(s) in total.`,
    redactedTypes: ['blocked_topic'],
    sanitized,
  };
}

/* -------------------------------------------------------------------------- */
/* required_citations (FR-GRD-007, TC-GRD-011)                                 */
/* -------------------------------------------------------------------------- */

/** `[source:` — the marker the prompt asks a cited answer to carry (round 3 §4 item 3). */
const SOURCE_MARKER = /\[source:/gi;

/** A `sources` array, whether the output is JSON (`"sources": [`) or prose (`sources: [`). */
const SOURCES_ARRAY = /["']?sources["']?\s*[:=]\s*\[/gi;

/**
 * The output must carry a `[source:` marker or a `sources` array. A check that fails says which two
 * things it looked for, because the fix is a prompt change and the author needs to know the shape.
 */
export function checkRequiredCitations(_check: GuardrailCheck, text: string): CheckResult {
  SOURCE_MARKER.lastIndex = 0;
  SOURCES_ARRAY.lastIndex = 0;
  if (SOURCE_MARKER.test(text))
    return { passed: true, reason: 'Output carries a [source: marker.' };
  if (SOURCES_ARRAY.test(text)) return { passed: true, reason: 'Output carries a sources array.' };
  return {
    passed: false,
    reason: 'Output carries no citation: no [source: marker and no sources array.',
  };
}
