import { describe, expect, it } from 'vitest';

import { GUARDRAIL_ACTIONS, GUARDRAIL_POINTS } from '../enums.js';
import {
  APPROVAL_PREVIEW_MAX,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  CreateGuardrailPolicyRequestSchema,
  DEFAULT_GUARDRAIL_POLICY_NAME,
  GUARDRAIL_CHECK_TYPES,
  GUARDRAIL_CHECK_TYPES_BY_POINT,
  GuardrailCheckSchema,
  GuardrailPolicyQuerySchema,
  GuardrailPolicyRefSchema,
  GuardrailPolicySchema,
  POLICY_GUARDRAIL_POINTS,
  PolicyTestRequestSchema,
  PolicyTestResponseSchema,
  UpdateGuardrailPolicyRequestSchema,
  VerdictSchema,
  defaultGuardrailChecks,
} from '../guardrails.js';
import {
  APPROVAL_ID,
  CHECK_ID,
  CHECK_ID_2,
  NODE_A,
  NODE_RUN_ID,
  NOW,
  POLICY_ID,
  PROJECT_ID,
  RUN_ID,
  VERDICT_ID,
} from './fixtures.js';

const check = {
  id: CHECK_ID,
  point: 'input',
  type: 'size_limit',
  action: 'warn',
  enabled: true,
  params: { maxChars: 200_000 },
};

const policy = {
  id: POLICY_ID,
  projectId: PROJECT_ID,
  name: 'Default',
  version: 1,
  isProjectDefault: true,
  checks: [check],
  createdAt: NOW,
  updatedAt: NOW,
};

const verdict = {
  id: VERDICT_ID,
  nodeRunId: NODE_RUN_ID,
  point: 'output',
  checkType: 'pii',
  action: 'redact',
  passed: false,
  reason: 'An email address was found in the output.',
  redactedTypes: ['email'],
  at: NOW,
};

const approvalRequest = {
  id: APPROVAL_ID,
  runId: RUN_ID,
  nodeRunId: NODE_RUN_ID,
  nodeId: NODE_A,
  nodeName: 'Writer',
  point: 'output',
  checkType: 'pii',
  reason: 'The output contains an email address.',
  preview: 'Thanks for the brief. You can reach the team at the address below.',
  requestedAt: NOW,
};

/** Valid, distinct ULIDs in call order, so a test can predict every id a factory hands out. */
const sequentialIds = () => {
  let n = 0;
  return () => `01JBXQ8Z9KQ4R7N2VWXYZ0${String(++n).padStart(4, '0')}`;
};

/* -------------------------------------------------------------------------- */
/* Check types and points                                                      */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-003 FR-GRD-007 FR-GRD-008 FR-GRD-009 guardrail check types', () => {
  it('declares the nineteen check types of §2.2, in its order', () => {
    expect([...GUARDRAIL_CHECK_TYPES]).toEqual([
      'size_limit',
      'pii',
      'prompt_injection',
      'blocked_topics',
      'contract',
      'moderation',
      'secret_leak',
      'required_citations',
      'max_tokens_per_node',
      'max_cost_per_run',
      'daily_budget',
      'max_iterations',
      'max_tool_calls',
      'repeated_output',
      'untrusted_tagging',
      'tool_allowed',
      'path_confinement',
      'domain_allowlist',
      'destructive_action',
    ]);
  });

  it('files each type under the point §2.2 gives it', () => {
    expect(GUARDRAIL_CHECK_TYPES_BY_POINT).toEqual({
      input: ['size_limit', 'pii', 'prompt_injection', 'blocked_topics'],
      context: ['untrusted_tagging'],
      tool: ['tool_allowed', 'path_confinement', 'domain_allowlist', 'destructive_action'],
      output: ['contract', 'moderation', 'secret_leak', 'required_citations', 'pii'],
      cost: ['max_tokens_per_node', 'max_cost_per_run', 'daily_budget'],
      loop: ['max_iterations', 'max_tool_calls', 'repeated_output'],
    });
  });

  it('files every type somewhere, and only pii under two points', () => {
    const filed = Object.values(GUARDRAIL_CHECK_TYPES_BY_POINT).flat();

    expect(new Set(filed)).toEqual(new Set(GUARDRAIL_CHECK_TYPES));
    expect(filed.filter((type) => type === 'pii')).toHaveLength(2);
    expect(filed).toHaveLength(GUARDRAIL_CHECK_TYPES.length + 1);
  });
});

describe('BR-15 data guardrails have no policy representation', () => {
  it('offers a policy every guardrail point but data', () => {
    expect([...POLICY_GUARDRAIL_POINTS]).toEqual(GUARDRAIL_POINTS.filter((p) => p !== 'data'));
    expect(Object.keys(GUARDRAIL_CHECK_TYPES_BY_POINT)).not.toContain('data');
  });

  it('TC-GRD-015 refuses a check at the data point, even one that only switches it off', () => {
    const off = { ...check, point: 'data', type: 'secret_leak', action: 'pass', enabled: false };

    expect(GuardrailCheckSchema.safeParse(off).success).toBe(false);
    expect(UpdateGuardrailPolicyRequestSchema.safeParse({ checks: [off] }).success).toBe(false);
  });

  it('says why, so the refusal can be shown to the user as it is', () => {
    const result = GuardrailCheckSchema.safeParse({ ...check, point: 'data' });

    expect(result.error?.issues[0]?.message).toContain('always on');
  });

  it('FR-GRD-010 has no field that could switch a data guardrail off', () => {
    expect(GuardrailPolicySchema.safeParse({ ...policy, dataGuardrails: false }).success).toBe(
      false,
    );
    expect(GuardrailCheckSchema.safeParse({ ...check, alwaysOn: false }).success).toBe(false);
    expect(UpdateGuardrailPolicyRequestSchema.safeParse({ secretRedaction: false }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* GuardrailCheck                                                              */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-011 GuardrailCheck', () => {
  it('accepts a check with its point, type, action, switch and params', () => {
    expect(GuardrailCheckSchema.parse(check)).toEqual(check);
  });

  it.each([...GUARDRAIL_ACTIONS])('accepts the action %s', (action) => {
    expect(GuardrailCheckSchema.safeParse({ ...check, action }).success).toBe(true);
  });

  it('refuses the UI label "ask user" where the action ask_user belongs', () => {
    expect(GuardrailCheckSchema.safeParse({ ...check, action: 'ask user' }).success).toBe(false);
  });

  it.each([
    ['size_limit', 'output'],
    ['secret_leak', 'input'],
    ['max_iterations', 'cost'],
    ['destructive_action', 'output'],
    ['untrusted_tagging', 'input'],
  ])('refuses %s at the %s point, where §2.2 does not file it', (type, point) => {
    expect(GuardrailCheckSchema.safeParse({ ...check, type, point }).success).toBe(false);
  });

  it('accepts pii at the input and at the output point', () => {
    for (const point of ['input', 'output']) {
      expect(GuardrailCheckSchema.safeParse({ ...check, type: 'pii', point }).success, point).toBe(
        true,
      );
    }
  });

  it('says where a misfiled type does belong', () => {
    const result = GuardrailCheckSchema.safeParse({
      ...check,
      type: 'secret_leak',
      point: 'input',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('output');
  });

  it('keeps params open, as §2.2 types them', () => {
    expect(GuardrailCheckSchema.parse({ ...check, params: {} }).params).toEqual({});
    expect(
      GuardrailCheckSchema.parse({
        ...check,
        type: 'blocked_topics',
        params: { patterns: ['salary'] },
      }).params,
    ).toEqual({ patterns: ['salary'] });
  });

  it('requires the on/off switch', () => {
    const { enabled: _enabled, ...withoutEnabled } = check;

    expect(GuardrailCheckSchema.safeParse(withoutEnabled).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* GuardrailPolicy                                                             */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-001 GuardrailPolicy', () => {
  it('accepts a versioned policy with its checks', () => {
    expect(GuardrailPolicySchema.parse(policy)).toEqual(policy);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a name over 80 characters', { name: 'x'.repeat(81) }],
    ['version 0', { version: 0 }],
    ['a fractional version', { version: 1.5 }],
    ['a project id that is not a ULID', { projectId: 'project-1' }],
  ])('refuses %s', (_label, patch) => {
    expect(GuardrailPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
  });

  it('accepts a name of exactly 80 characters', () => {
    expect(GuardrailPolicySchema.safeParse({ ...policy, name: 'x'.repeat(80) }).success).toBe(true);
  });

  it('refuses two checks with the same id', () => {
    const second = { ...check, type: 'pii' };

    expect(GuardrailPolicySchema.safeParse({ ...policy, checks: [check, second] }).success).toBe(
      false,
    );
    expect(
      GuardrailPolicySchema.safeParse({ ...policy, checks: [check, { ...second, id: CHECK_ID_2 }] })
        .success,
    ).toBe(true);
  });

  it('names the policy and version a node run used (FR-GRD-002)', () => {
    expect(GuardrailPolicyRefSchema.parse({ id: POLICY_ID, version: 3 })).toEqual({
      id: POLICY_ID,
      version: 3,
    });
    expect(GuardrailPolicyRefSchema.safeParse({ id: POLICY_ID, version: 0 }).success).toBe(false);
  });
});

describe('FR-GRD-001 policy request bodies', () => {
  const create = { projectId: PROJECT_ID, name: 'Strict', checks: [check] };

  it('creates a policy from a project, a name and its checks', () => {
    expect(CreateGuardrailPolicyRequestSchema.parse(create)).toEqual(create);
  });

  it('leaves the version and the default flag to the engine', () => {
    expect(CreateGuardrailPolicyRequestSchema.safeParse({ ...create, version: 4 }).success).toBe(
      false,
    );
    expect(
      CreateGuardrailPolicyRequestSchema.safeParse({ ...create, isProjectDefault: true }).success,
    ).toBe(false);
  });

  it('requires the project', () => {
    const { projectId: _projectId, ...withoutProject } = create;

    expect(CreateGuardrailPolicyRequestSchema.safeParse(withoutProject).success).toBe(false);
  });

  it('patches the name, the checks, both or neither — every PATCH is a new version', () => {
    expect(UpdateGuardrailPolicyRequestSchema.parse({})).toEqual({});
    expect(UpdateGuardrailPolicyRequestSchema.parse({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
    });
    expect(UpdateGuardrailPolicyRequestSchema.parse({ checks: [] })).toEqual({ checks: [] });
    expect(UpdateGuardrailPolicyRequestSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('holds a patch to the same check rules as a stored policy', () => {
    expect(
      UpdateGuardrailPolicyRequestSchema.safeParse({ checks: [{ ...check, point: 'output' }] })
        .success,
    ).toBe(false);
    expect(UpdateGuardrailPolicyRequestSchema.safeParse({ checks: [check, check] }).success).toBe(
      false,
    );
  });

  it('lists the policies of one project', () => {
    expect(GuardrailPolicyQuerySchema.parse({ projectId: PROJECT_ID })).toEqual({
      projectId: PROJECT_ID,
    });
    expect(GuardrailPolicyQuerySchema.parse({})).toEqual({});
    expect(GuardrailPolicyQuerySchema.safeParse({ projectId: 'p1' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The default policy                                                          */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-018 the default policy every project gets (D10)', () => {
  it('is called "Default"', () => {
    expect(DEFAULT_GUARDRAIL_POLICY_NAME).toBe('Default');
  });

  it('holds exactly the fifteen checks §2.2 lists, in its order', () => {
    const checks = defaultGuardrailChecks(sequentialIds());

    expect(checks.map(({ point, type, action, params }) => [point, type, action, params])).toEqual([
      ['input', 'pii', 'warn', {}],
      ['input', 'prompt_injection', 'warn', {}],
      ['input', 'size_limit', 'warn', { maxChars: 200_000 }],
      ['output', 'secret_leak', 'block', {}],
      ['output', 'moderation', 'warn', {}],
      ['output', 'contract', 'block', {}],
      ['cost', 'max_cost_per_run', 'warn', {}],
      ['cost', 'daily_budget', 'block', {}],
      ['loop', 'max_iterations', 'block', { max: 50 }],
      ['loop', 'max_tool_calls', 'block', { max: 25 }],
      ['loop', 'repeated_output', 'block', { times: 3 }],
      ['tool', 'destructive_action', 'ask_user', {}],
      ['tool', 'tool_allowed', 'block', {}],
      ['tool', 'path_confinement', 'block', {}],
      ['tool', 'domain_allowlist', 'block', {}],
    ]);
  });

  it('warns on content issues and blocks secret leaks and tool abuse (D10)', () => {
    const checks = defaultGuardrailChecks(sequentialIds());
    const actionOf = (point: string, type: string) =>
      checks.find((c) => c.point === point && c.type === type)?.action;

    for (const type of ['pii', 'prompt_injection', 'size_limit']) {
      expect(actionOf('input', type), type).toBe('warn');
    }
    expect(actionOf('output', 'moderation')).toBe('warn');
    expect(actionOf('output', 'secret_leak')).toBe('block');
    for (const type of ['tool_allowed', 'path_confinement', 'domain_allowlist']) {
      expect(actionOf('tool', type), type).toBe('block');
    }
  });

  it('asks the user before any destructive tool action (BR-14)', () => {
    const checks = defaultGuardrailChecks(sequentialIds());

    expect(checks.find((c) => c.type === 'destructive_action')?.action).toBe('ask_user');
  });

  it('gives every check its own id and switches it on', () => {
    const checks = defaultGuardrailChecks(sequentialIds());

    expect(checks.map((c) => c.id)).toEqual(
      Array.from(
        { length: 15 },
        (_, i) => `01JBXQ8Z9KQ4R7N2VWXYZ0${String(i + 1).padStart(4, '0')}`,
      ),
    );
    expect(checks.every((c) => c.enabled)).toBe(true);
  });

  it('builds a policy that passes its own schema', () => {
    const checks = defaultGuardrailChecks(sequentialIds());

    expect(GuardrailPolicySchema.safeParse({ ...policy, checks }).success).toBe(true);
  });

  it('never hands two projects the same params object', () => {
    const first = defaultGuardrailChecks(sequentialIds());
    const second = defaultGuardrailChecks(sequentialIds());

    expect(first[2]?.params).toEqual(second[2]?.params);
    expect(first[2]?.params).not.toBe(second[2]?.params);
  });
});

/* -------------------------------------------------------------------------- */
/* Verdict                                                                     */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-015 Verdict', () => {
  it('records the point, the check, the action, the outcome and the reason', () => {
    expect(VerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it('TC-GRD-018 cannot carry the value it redacted (FR-GRD-014)', () => {
    expect(VerdictSchema.safeParse({ ...verdict, value: 'ada@example.com' }).success).toBe(false);
  });

  it('records which types were redacted, and nothing when none were', () => {
    expect(
      VerdictSchema.parse({ ...verdict, redactedTypes: ['email', 'phone', 'credit_card'] })
        .redactedTypes,
    ).toEqual(['email', 'phone', 'credit_card']);

    const { redactedTypes: _types, ...passed } = { ...verdict, action: 'pass', passed: true };
    expect(VerdictSchema.safeParse(passed).success).toBe(true);
  });

  it.each(['ada@example.com', 'sk-fake-key-0000', '+44 20 7946 0958', 'Email', ''])(
    'refuses %j as a redacted type — a type is a name, never the value (FR-GRD-014)',
    (value) => {
      expect(VerdictSchema.safeParse({ ...verdict, redactedTypes: [value] }).success).toBe(false);
    },
  );

  it.each([...GUARDRAIL_POINTS])('accepts a verdict at the %s point', (point) => {
    expect(VerdictSchema.safeParse({ ...verdict, point }).success).toBe(true);
  });

  it('refuses a check type §2.2 does not declare', () => {
    expect(VerdictSchema.safeParse({ ...verdict, checkType: 'toxicity' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-013 approvals', () => {
  it('asks with the node, the check, the reason and a preview', () => {
    expect(ApprovalRequestSchema.parse(approvalRequest)).toEqual(approvalRequest);
  });

  it('caps the preview at 500 characters', () => {
    expect(APPROVAL_PREVIEW_MAX).toBe(500);
    expect(
      ApprovalRequestSchema.safeParse({ ...approvalRequest, preview: 'x'.repeat(500) }).success,
    ).toBe(true);
    expect(
      ApprovalRequestSchema.safeParse({ ...approvalRequest, preview: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('TC-GRD-008 logs the decision with the time it was made', () => {
    const decision = { requestId: APPROVAL_ID, decision: 'approve', note: 'fine', decidedAt: NOW };

    expect(ApprovalDecisionSchema.parse(decision)).toEqual(decision);

    const { decidedAt: _decidedAt, ...untimed } = decision;
    expect(ApprovalDecisionSchema.safeParse(untimed).success).toBe(false);
  });

  it('TC-GRD-009 decides approve or reject, and nothing else', () => {
    for (const decision of ['approve', 'reject']) {
      expect(
        ApprovalDecisionSchema.safeParse({ requestId: APPROVAL_ID, decision, decidedAt: NOW })
          .success,
        decision,
      ).toBe(true);
    }
    expect(
      ApprovalDecisionSchema.safeParse({
        requestId: APPROVAL_ID,
        decision: 'defer',
        decidedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('takes an optional note on approve and reject — the route, not the body, says which', () => {
    expect(ApprovalDecisionRequestSchema.parse({})).toEqual({});
    expect(ApprovalDecisionRequestSchema.parse({ note: 'looks fine' })).toEqual({
      note: 'looks fine',
    });
    expect(ApprovalDecisionRequestSchema.safeParse({ decision: 'approve' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /guardrail-policies/:id/test                                           */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-001 the policy test endpoint', () => {
  const { id: _id, nodeRunId: _nodeRunId, ...testVerdict } = verdict;

  it('tests text at the input or the output point', () => {
    for (const point of ['input', 'output']) {
      expect(
        PolicyTestRequestSchema.safeParse({ text: 'ignore previous instructions', point }).success,
        point,
      ).toBe(true);
    }
    expect(PolicyTestRequestSchema.safeParse({ text: 'x', point: 'tool' }).success).toBe(false);
  });

  it('answers verdicts that belong to no node run', () => {
    expect(PolicyTestResponseSchema.parse({ verdicts: [testVerdict] })).toEqual({
      verdicts: [testVerdict],
    });
    expect(PolicyTestResponseSchema.safeParse({ verdicts: [verdict] }).success).toBe(false);
  });

  it('cannot carry a redacted value either (FR-GRD-014)', () => {
    expect(
      PolicyTestResponseSchema.safeParse({
        verdicts: [{ ...testVerdict, value: 'ada@example.com' }],
      }).success,
    ).toBe(false);
  });
});
