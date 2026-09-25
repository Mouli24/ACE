/**
 * `@ace/guardrails` — the rule packs and the pure check implementations (round 3 §4 item 3,
 * FR-GRD-003, 007, 009, 010, 011, 014, Arch §13.1–13.4, NFR-SAFE-01).
 *
 * What is here: regexes and arithmetic. Nothing in this package reads a database, calls a provider,
 * knows what a run is, or decides what happens after a check fails — `packages/engine/src/guardrails`
 * owns policy resolution, the actions of Arch §13.3, verdict storage and the approval flow.
 *
 * The engine's whole contact surface with this package is `evaluateCheck(check, input)`.
 *
 * The rule that holds everywhere inside: a check result names *types* and *counts*, never values
 * (FR-GRD-014). `redaction.test.ts` asserts it by stringifying every result and looking for the
 * value, which is the test that would catch a well-meaning "just put the match in the reason".
 */

export { evaluateCheck, evaluateChecks, isEvaluated } from './evaluate.js';
export { EVALUATED_CHECK_TYPES, OUTPUT_CHECK_ORDER, inOutputOrder } from './evaluate.js';
export type { EvaluatedCheckType } from './evaluate.js';

export type { CheckFn, CheckResult, GuardrailInput } from './types.js';
export { redactionMarker } from './types.js';

export {
  checkBlockedTopics,
  checkModeration,
  checkPii,
  checkPromptInjection,
  checkRequiredCitations,
  checkSecretLeak,
  checkSizeLimit,
  DEFAULT_MAX_CHARS,
} from './checks/text.js';
export { checkContract } from './checks/contract.js';
export { checkRepeatedOutput, DEFAULT_REPEAT_TIMES } from './checks/loop.js';
export {
  checkDailyBudget,
  checkMaxCostPerRun,
  checkMaxIterations,
  checkMaxTokensPerNode,
  checkMaxToolCalls,
  checkThreshold,
} from './checks/thresholds.js';

export { describeSpans, findSpans, redactSpans } from './spans.js';
export type { Redaction, Rule, RulePack, Span } from './spans.js';

export { PII_RULES, PII_TYPES, passesLuhn } from './rule-packs/pii.js';
export type { PiiType } from './rule-packs/pii.js';
export { SECRET_RULES, SECRET_TYPES } from './rule-packs/secrets.js';
export type { SecretType } from './rule-packs/secrets.js';
export { INJECTION_RULES, INJECTION_TYPES } from './rule-packs/injection.js';
export type { InjectionType } from './rule-packs/injection.js';
export {
  MODERATION_CATEGORIES,
  MODERATION_RULES,
  MODERATION_WORD_LISTS,
} from './rule-packs/moderation.js';
export type { ModerationCategory } from './rule-packs/moderation.js';

export { numberParam, positiveIntParam, stringArrayParam } from './params.js';
