import { z } from 'zod';

import { GuardrailActionSchema, GuardrailPointSchema, type GuardrailPoint } from './enums.js';
import {
  AllowedCommandSchema,
  IdSchema,
  NodeNameSchema,
  TimestampSchema,
  type Id,
} from './graph.js';

/**
 * Guardrail policies, checks, verdicts and approvals (round 3 §2.2, round 5 §2.3,
 * FR-GRD-001..015 and 018, Arch §13).
 *
 * Every body in this module is strict. A key the contract does not name is exactly how an off
 * switch for a data guardrail would slip into a policy (BR-15, FR-GRD-010), or how a redacted
 * value would ride along on a verdict (FR-GRD-014) — so it is a parse error, not a silent extra.
 */

/* -------------------------------------------------------------------------- */
/* Check types and the points they belong to (§2.2)                            */
/* -------------------------------------------------------------------------- */

/**
 * The points a policy can configure: every guardrail point but `data`. Data guardrails — secret
 * redaction of stored prompts, outputs and logs, and file confinement — are always on and have no
 * policy representation at all (BR-15).
 */
export const POLICY_GUARDRAIL_POINTS = [
  'input',
  'context',
  'tool',
  'output',
  'cost',
  'loop',
] as const satisfies readonly Exclude<GuardrailPoint, 'data'>[];
export const PolicyGuardrailPointSchema = z.enum(POLICY_GUARDRAIL_POINTS, {
  error: (issue) =>
    issue.input === 'data'
      ? 'Data guardrails are always on and have no policy setting (BR-15).'
      : undefined,
});
export type PolicyGuardrailPoint = z.infer<typeof PolicyGuardrailPointSchema>;

/** The check types of §2.2, in its order. Round 5 §2.3 adds none; it files two at `context`. */
export const GUARDRAIL_CHECK_TYPES = [
  // input
  'size_limit',
  'pii',
  'prompt_injection',
  'blocked_topics',
  // output (pii is valid here too)
  'contract',
  'moderation',
  'secret_leak',
  'required_citations',
  // cost
  'max_tokens_per_node',
  'max_cost_per_run',
  'daily_budget',
  // loop
  'max_iterations',
  'max_tool_calls',
  'repeated_output',
  // context — evaluated from round 5 (pii and prompt_injection are valid here too)
  'untrusted_tagging',
  // tool — evaluated from round 4
  'tool_allowed',
  'path_confinement',
  'domain_allowlist',
  'destructive_action',
] as const;
export const GuardrailCheckTypeSchema = z.enum(GUARDRAIL_CHECK_TYPES);
export type GuardrailCheckType = z.infer<typeof GuardrailCheckTypeSchema>;

/**
 * Which check types a policy may configure at each point (§2.2). From round 5 §2.3 `pii` is filed
 * under three points and `prompt_injection` under two: at `context` they run over retrieved chunks,
 * upstream outputs, tool results and memory — and `pii` over a document's text before it is
 * chunked (Arch §21.3).
 */
export const GUARDRAIL_CHECK_TYPES_BY_POINT = {
  input: ['size_limit', 'pii', 'prompt_injection', 'blocked_topics'],
  context: ['untrusted_tagging', 'prompt_injection', 'pii'],
  tool: ['tool_allowed', 'path_confinement', 'domain_allowlist', 'destructive_action'],
  output: ['contract', 'moderation', 'secret_leak', 'required_citations', 'pii'],
  cost: ['max_tokens_per_node', 'max_cost_per_run', 'daily_budget'],
  loop: ['max_iterations', 'max_tool_calls', 'repeated_output'],
} as const satisfies Record<PolicyGuardrailPoint, readonly GuardrailCheckType[]>;

function pointsFor(type: GuardrailCheckType): PolicyGuardrailPoint[] {
  return POLICY_GUARDRAIL_POINTS.filter((point) =>
    (GUARDRAIL_CHECK_TYPES_BY_POINT[point] as readonly GuardrailCheckType[]).includes(type),
  );
}

/* -------------------------------------------------------------------------- */
/* Checks and policies (FR-GRD-001, 002, 011)                                  */
/* -------------------------------------------------------------------------- */

/**
 * One check of a policy. The point/type rule is a refinement, so Zod refuses `.pick`, `.omit` and
 * `.partial` on this schema — validate a whole check with it rather than deriving a smaller one.
 *
 * `untrusted_tagging` is always on and only tags (round 5 §2.3, BR-13). The schema still accepts it
 * disabled or with another action, because the round 3 policy editor offers every type a point
 * files with its default action; the engine tags unconditionally whatever the check says, and the
 * check exists so its verdicts have one to name (D232).
 */
export const GuardrailCheckSchema = z
  .strictObject({
    id: IdSchema,
    point: PolicyGuardrailPointSchema,
    type: GuardrailCheckTypeSchema,
    action: GuardrailActionSchema,
    enabled: z.boolean(),
    /** Open, as §2.2 types it: `size_limit { maxChars }`, `blocked_topics { patterns }`, … */
    params: z.record(z.string(), z.unknown()),
  })
  .superRefine((check, ctx) => {
    const points = pointsFor(check.type);
    if (points.includes(check.point)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['point'],
      message: `A ${check.type} check belongs at ${points.join(' or ')}, not at ${check.point}.`,
    });
  });
export type GuardrailCheck = z.infer<typeof GuardrailCheckSchema>;

/** A policy's checks. The ids are what keep a check recognisable from one version to the next. */
const GuardrailChecksSchema = z.array(GuardrailCheckSchema).superRefine((checks, ctx) => {
  const seen = new Set<Id>();
  checks.forEach((check, index) => {
    if (seen.has(check.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `Check ${check.id} appears twice in one policy.`,
      });
    }
    seen.add(check.id);
  });
});

export const GuardrailPolicyNameSchema = z.string().min(1).max(80);

export const GuardrailPolicySchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  name: GuardrailPolicyNameSchema,
  /** Starts at 1. A PATCH never edits in place: it writes version + 1 (FR-GRD-001, Arch §13.4). */
  version: z.number().int().min(1),
  isProjectDefault: z.boolean(),
  checks: GuardrailChecksSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GuardrailPolicy = z.infer<typeof GuardrailPolicySchema>;

/** The policy, and the version of it, a node run was checked against (FR-GRD-002, Arch §13.4). */
export const GuardrailPolicyRefSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1),
});
export type GuardrailPolicyRef = z.infer<typeof GuardrailPolicyRefSchema>;

/**
 * `POST /guardrail-policies` → `GuardrailPolicy`. The engine numbers the versions and owns the
 * default flag (`POST /guardrail-policies/:id/set-default`).
 */
export const CreateGuardrailPolicyRequestSchema = z.strictObject({
  projectId: IdSchema,
  name: GuardrailPolicyNameSchema,
  checks: GuardrailChecksSchema,
});
export type CreateGuardrailPolicyRequest = z.infer<typeof CreateGuardrailPolicyRequestSchema>;

/** `PATCH /guardrail-policies/:id` → `GuardrailPolicy` at version + 1. */
export const UpdateGuardrailPolicyRequestSchema = z.strictObject({
  name: GuardrailPolicyNameSchema.optional(),
  checks: GuardrailChecksSchema.optional(),
});
export type UpdateGuardrailPolicyRequest = z.infer<typeof UpdateGuardrailPolicyRequestSchema>;

/** `GET /guardrail-policies?projectId` → `{ items: GuardrailPolicy[] }` (D64). */
export const GuardrailPolicyQuerySchema = z.object({ projectId: IdSchema.optional() });
export type GuardrailPolicyQuery = z.infer<typeof GuardrailPolicyQuerySchema>;

/* -------------------------------------------------------------------------- */
/* The default policy (FR-GRD-018, D10)                                        */
/* -------------------------------------------------------------------------- */

export const DEFAULT_GUARDRAIL_POLICY_NAME = 'Default';

type DefaultCheck = Pick<GuardrailCheck, 'point' | 'type' | 'action' | 'params'>;

/**
 * §2.2's default policy, in its order, then round 5 §2.3's three context checks: warn on content
 * issues, block secret leaks and tool abuse (D10), tag every untrusted piece of context, neutralise
 * the hidden instructions in it with a warning, and redact the personal data in it (D232).
 *
 * At the cost point a check's action decides (D79): `block` halts the run `budget_exceeded`, so
 * `max_cost_per_run` is `block` here where §2.2 wrote `warn` — the §1 demo, TC-GRD-012 and
 * FR-GRD-008 all halt on the default policy. The two cost checks carry no params: their caps are
 * the project's `maxCostPerRunUsd` and the settings' `dailyBudgetUsd` (§2.3) unless a policy sets
 * `params.usd`. Tool checks are declared now and evaluated from round 4.
 */
const DEFAULT_CHECKS: readonly DefaultCheck[] = [
  { point: 'input', type: 'pii', action: 'warn', params: {} },
  { point: 'input', type: 'prompt_injection', action: 'warn', params: {} },
  { point: 'input', type: 'size_limit', action: 'warn', params: { maxChars: 200_000 } },
  { point: 'output', type: 'secret_leak', action: 'block', params: {} },
  { point: 'output', type: 'moderation', action: 'warn', params: {} },
  { point: 'output', type: 'contract', action: 'block', params: {} },
  { point: 'cost', type: 'max_cost_per_run', action: 'block', params: {} },
  { point: 'cost', type: 'daily_budget', action: 'block', params: {} },
  { point: 'loop', type: 'max_iterations', action: 'block', params: { max: 50 } },
  { point: 'loop', type: 'max_tool_calls', action: 'block', params: { max: 25 } },
  { point: 'loop', type: 'repeated_output', action: 'block', params: { times: 3 } },
  { point: 'tool', type: 'destructive_action', action: 'ask_user', params: {} },
  { point: 'tool', type: 'tool_allowed', action: 'block', params: {} },
  { point: 'tool', type: 'path_confinement', action: 'block', params: {} },
  { point: 'tool', type: 'domain_allowlist', action: 'block', params: {} },
  { point: 'context', type: 'untrusted_tagging', action: 'pass', params: {} },
  { point: 'context', type: 'prompt_injection', action: 'warn', params: {} },
  { point: 'context', type: 'pii', action: 'redact', params: {} },
];

/**
 * The checks of a new project's default policy, each with a fresh id from `newId` and switched on.
 * One definition for the engine's migration and for the web app's mocks, so the two cannot drift
 * (the same reasoning as D52). Every call builds new objects — no two policies share a `params`.
 */
export function defaultGuardrailChecks(newId: () => Id): GuardrailCheck[] {
  return DEFAULT_CHECKS.map(({ point, type, action, params }) => ({
    id: newId(),
    point,
    type,
    action,
    enabled: true,
    params: { ...params },
  }));
}

/* -------------------------------------------------------------------------- */
/* Verdicts (FR-GRD-014, 015)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A redacted type is a name such as `email` or `credit_card`. The shape refuses anything that
 * looks like the value itself — an address, a dashed key, a phone number (FR-GRD-014).
 */
export const REDACTED_TYPE_REGEX = /^[a-z][a-z0-9_]*$/;
export const RedactedTypeSchema = z
  .string()
  .regex(REDACTED_TYPE_REGEX, 'must be a type name such as email — never the value');

/**
 * The kinds of hidden instruction `prompt_injection` strips at the context point (round 5 §2.3):
 * `<!-- -->` comments, `[//]: #` Markdown comments, zero-width characters, "ignore previous
 * instructions"-class sentences, and base64-looking instruction payloads over 200 characters.
 */
export const HIDDEN_INSTRUCTION_TYPES = [
  'html_comment',
  'markdown_comment',
  'zero_width',
  'instruction_override',
  'base64_payload',
] as const;
export const HiddenInstructionTypeSchema = z.enum(HIDDEN_INSTRUCTION_TYPES);
export type HiddenInstructionType = z.infer<typeof HiddenInstructionTypeSchema>;

/**
 * One check's outcome on one node run. Stored on the node run and emitted (FR-GRD-015). Like
 * `redactedTypes`, `strippedTypes` names what was taken out and never the text itself (§2.3,
 * FR-GRD-014) — a poisoned chunk's payload must not survive in its own verdict (TC-GRD-005).
 */
export const VerdictSchema = z.strictObject({
  id: IdSchema,
  nodeRunId: IdSchema,
  point: GuardrailPointSchema,
  checkType: GuardrailCheckTypeSchema,
  action: GuardrailActionSchema,
  passed: z.boolean(),
  reason: z.string(),
  redactedTypes: z.array(RedactedTypeSchema).optional(),
  strippedTypes: z.array(HiddenInstructionTypeSchema).optional(),
  at: TimestampSchema,
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A verdict from a direct chat (round 4 §2.3, FR-CHAT-008). The same shape without `nodeRunId`,
 * because a chat never reads or writes `runs`/`node_runs` (FR-CHAT-005) — the same reasoning as
 * `PolicyTestVerdict`, which keeps its `id` only where there is a row to be stored with. These are
 * stored on the `ChatMessage` and returned in the `details.verdicts` of a 422 `guardrail_blocked`.
 */
export const ChatVerdictSchema = VerdictSchema.omit({ nodeRunId: true });
export type ChatVerdict = z.infer<typeof ChatVerdictSchema>;

/* -------------------------------------------------------------------------- */
/* Approvals (FR-GRD-013, Arch §21.2)                                          */
/* -------------------------------------------------------------------------- */

export const APPROVAL_PREVIEW_MAX = 500;
/** The longest command an approval card carries — `run_command`'s own limit (D376). */
export const APPROVAL_COMMAND_MAX = 8_000;

/**
 * D376 (agentic nodes, FR-GRD-006): the command an agentic node's `run_command` asks to run, on the
 * card. `text` is the command line with secret-shaped values masked. `allowPrefix` is offered only
 * when one prefix covers the whole line and nothing about it is denied or uncoverable; approving
 * with `always: true` allows it for the rest of the run and asks for it to be saved on the node.
 * `denylisted` says a denylist rule matched: the card asks every time.
 */
export const ApprovalCommandSchema = z.strictObject({
  text: z.string().max(APPROVAL_COMMAND_MAX),
  allowPrefix: AllowedCommandSchema.optional(),
  denylisted: z.boolean(),
});
export type ApprovalCommand = z.infer<typeof ApprovalCommandSchema>;

/**
 * What an `ask_user` action puts in front of the user while the node is WAITING. Emitted as
 * `node.approval_required`; `GET /runs/:id/approvals` answers the pending ones as a plain
 * `ApprovalRequest[]`, the way §2.5 writes it.
 *
 * PG-2.2 (D359): a direct chat's tool call asks through the same request. A chat belongs to no run
 * (FR-CHAT-005), so its request names the `threadId` instead; a run's request names `runId` and
 * `nodeRunId`. Exactly one of the two is present. A chat request is announced on its thread as
 * `chat.approval_required` and decided at `POST /chat/threads/:id/approvals/:requestId/approve`.
 */
export const ApprovalRequestSchema = z
  .strictObject({
    id: IdSchema,
    runId: IdSchema.optional(),
    nodeRunId: IdSchema.optional(),
    /** PG-2.2 (D359): the chat thread whose turn is waiting. */
    threadId: IdSchema.optional(),
    nodeId: IdSchema,
    nodeName: NodeNameSchema,
    point: GuardrailPointSchema,
    checkType: GuardrailCheckTypeSchema,
    reason: z.string(),
    preview: z.string().max(APPROVAL_PREVIEW_MAX),
    /** D376: present only for an agentic node's `run_command`. */
    command: ApprovalCommandSchema.optional(),
    requestedAt: TimestampSchema,
  })
  .refine(
    (request) => {
      const anyRun = request.runId !== undefined || request.nodeRunId !== undefined;
      if (request.threadId !== undefined) return !anyRun;
      return request.runId !== undefined && request.nodeRunId !== undefined;
    },
    { message: 'An approval request names either runId and nodeRunId, or threadId.' },
  );
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const APPROVAL_DECISION_KINDS = ['approve', 'reject'] as const;
export const ApprovalDecisionKindSchema = z.enum(APPROVAL_DECISION_KINDS);
export type ApprovalDecisionKind = z.infer<typeof ApprovalDecisionKindSchema>;

/** The decision, logged with its time (FR-GRD-013). A reject fails the node GUARDRAIL_VIOLATION. */
export const ApprovalDecisionSchema = z.strictObject({
  requestId: IdSchema,
  decision: ApprovalDecisionKindSchema,
  note: z.string().optional(),
  /**
   * D376: approved with Always allow; `prefix` is the prefix the person chose to always allow. It
   * is allowed for the rest of the run; saving it on the node is best-effort, and a failed save is
   * logged, not recorded here.
   */
  always: z.literal(true).optional(),
  prefix: AllowedCommandSchema.optional(),
  decidedAt: TimestampSchema,
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * `POST /node-runs/:id/approve` and `/reject` → `NodeRun`. The route is the decision. D376:
 * `always: true` on an approve always-allows the request's `command.allowPrefix` — for the rest of
 * the run, and on the node once the save succeeds; a request without one answers 400
 * `validation_failed`.
 */
export const ApprovalDecisionRequestSchema = z.strictObject({
  note: z.string().optional(),
  always: z.literal(true).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

/* -------------------------------------------------------------------------- */
/* POST /guardrail-policies/:id/test (FR-GRD-001)                              */
/* -------------------------------------------------------------------------- */

export const POLICY_TEST_POINTS = [
  'input',
  'output',
] as const satisfies readonly PolicyGuardrailPoint[];

export const PolicyTestRequestSchema = z.strictObject({
  text: z.string(),
  point: z.enum(POLICY_TEST_POINTS),
});
export type PolicyTestRequest = z.infer<typeof PolicyTestRequestSchema>;

/** A tested verdict belongs to no node run, so it has neither id; it is still strict. */
export const PolicyTestVerdictSchema = VerdictSchema.omit({ id: true, nodeRunId: true });
export type PolicyTestVerdict = z.infer<typeof PolicyTestVerdictSchema>;

export const PolicyTestResponseSchema = z.strictObject({
  verdicts: z.array(PolicyTestVerdictSchema),
});
export type PolicyTestResponse = z.infer<typeof PolicyTestResponseSchema>;
