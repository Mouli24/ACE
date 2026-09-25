import {
  GUARDRAIL_CHECK_TYPES_BY_POINT,
  type GuardrailCheck,
  type GuardrailCheckType,
  type PolicyGuardrailPoint,
} from '@ace/contracts';

/**
 * What the editor needs to know about a point and a check type that the contract does not say:
 * the order to show them in, a sentence per point, and which params a check type takes.
 *
 * Every list here is derived from the contract rather than retyped — `checkTypesFor` reads
 * `GUARDRAIL_CHECK_TYPES_BY_POINT`, so a check type the contract adds at a point is offered without
 * a change here, and a test asserts the point order is exactly `POLICY_GUARDRAIL_POINTS`
 * rearranged.
 */

/** The order round 3 §5 item 5 lists: input, output, cost, loop, tool, context. */
export const EDITOR_POINT_ORDER = [
  'input',
  'output',
  'cost',
  'loop',
  'tool',
  'context',
] as const satisfies readonly PolicyGuardrailPoint[];

export const POINT_LABEL: Readonly<Record<PolicyGuardrailPoint, string>> = {
  input: 'Input',
  output: 'Output',
  cost: 'Cost',
  loop: 'Loop',
  tool: 'Tool',
  context: 'Context',
};

/** One line per point, from Arch §13.1's table of what is checked where. */
export const POINT_DESCRIPTION: Readonly<Record<PolicyGuardrailPoint, string>> = {
  input: 'Checked on what goes into a node.',
  output: "Checked on a node's answer before it flows downstream.",
  cost: 'Checked before and after each node; a block halts the run budget_exceeded.',
  loop: 'Checked on each iteration of a loop edge.',
  tool: 'Checked before a tool call. Evaluated from round 4.',
  context: 'Checked on retrieved and remembered text. Evaluated from round 5.',
};

/** The check types a policy may configure at a point, in the contract's order (§2.2). */
export function checkTypesFor(point: PolicyGuardrailPoint): readonly GuardrailCheckType[] {
  return GUARDRAIL_CHECK_TYPES_BY_POINT[point];
}

/** A number the check reads from `params`, or a newline-separated list of patterns. */
export type ParamField =
  | { kind: 'number'; key: string; label: string; min?: number; max?: number; hint?: string }
  | { kind: 'patterns'; key: string; label: string; hint?: string };

/**
 * The params §2.2 names, and nothing more. A check type §2.2 gives no params gets an empty list and
 * — where §2.2 or §2.3 says where its limit comes from instead — a note; inventing a field for it
 * would be inventing a behaviour the engine does not read (CLAUDE.md §1).
 */
export const CHECK_PARAM_FIELDS: Readonly<Record<GuardrailCheckType, readonly ParamField[]>> = {
  size_limit: [{ kind: 'number', key: 'maxChars', label: 'Max characters', min: 1 }],
  pii: [],
  prompt_injection: [],
  blocked_topics: [
    {
      kind: 'patterns',
      key: 'patterns',
      label: 'Patterns',
      hint: 'One per line.',
    },
  ],
  contract: [],
  moderation: [],
  secret_leak: [],
  required_citations: [],
  max_tokens_per_node: [],
  max_cost_per_run: [
    {
      kind: 'number',
      key: 'usd',
      label: 'Cap (USD)',
      min: 0,
      hint: "Empty uses the project's max cost per run (§2.3).",
    },
  ],
  daily_budget: [
    {
      kind: 'number',
      key: 'usd',
      label: 'Cap (USD)',
      min: 0,
      hint: 'Empty uses the daily budget in Settings (§2.3).',
    },
  ],
  max_iterations: [{ kind: 'number', key: 'max', label: 'Max iterations', min: 1, max: 50 }],
  max_tool_calls: [{ kind: 'number', key: 'max', label: 'Max tool calls', min: 1 }],
  repeated_output: [{ kind: 'number', key: 'times', label: 'Identical answers', min: 2 }],
  untrusted_tagging: [],
  tool_allowed: [],
  path_confinement: [],
  domain_allowlist: [],
  destructive_action: [],
};

/** Where a check with no params of its own takes its limit from, or when it starts being read. */
export const CHECK_NOTE: Partial<Readonly<Record<GuardrailCheckType, string>>> = {
  max_tokens_per_node: "The cap is the node's execution max tokens (§2.3).",
  untrusted_tagging: 'No settings; evaluated from round 5.',
  tool_allowed: 'No settings yet; evaluated from round 4.',
  path_confinement: 'No settings yet; evaluated from round 4.',
  domain_allowlist: 'No settings yet; evaluated from round 4.',
  destructive_action: 'No settings yet; evaluated from round 4.',
};

/** The params a form field does not own — kept on save so an engine-set key is never dropped. */
export function unknownParams(check: GuardrailCheck): Record<string, unknown> {
  const known = new Set(CHECK_PARAM_FIELDS[check.type].map((field) => field.key));
  return Object.fromEntries(Object.entries(check.params).filter(([key]) => !known.has(key)));
}

/** `['a', 'b']` → `"a\nb"` for the textarea; anything else shows as nothing rather than `[object]`. */
export function patternsToText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('\n') : '';
}

export function textToPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A check's number param, as a form value: absent stays absent, so a blank box is not `0`. */
export function numberToText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}
