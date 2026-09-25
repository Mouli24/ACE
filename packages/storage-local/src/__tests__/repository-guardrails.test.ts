import {
  AgentConfigSchema,
  ApprovalRequestSchema,
  DEFAULT_GUARDRAIL_POLICY_NAME,
  VerdictSchema,
  defaultGuardrailChecks,
  type ApprovalRequest,
  type GuardrailCheck,
  type Node,
  type NodeRun,
  type Run,
  type Verdict,
} from '@ace/contracts';
import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteRepository } from '../repository.js';
import { SecretWriteRejectedError } from '../secret-guard.js';
import { createTempDb, type TempDb } from './temp-db.js';
import { makeInputNode, makeProject, makeWorkflow, scope } from './fixtures.js';

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const NOW = '2026-09-26T10:00:00.000Z';
const OTHER = { workspaceId: 'other' };

/** A key-shaped string built at runtime, so no literal credential is ever in the repository. */
const FAKE_KEY = ['sk', '-', 'a'.repeat(40)].join('');

function agentNode(workflowId: string, config: Record<string, unknown> = {}): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'agent',
    name: 'Writer',
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:text`, name: 'text', dataType: 'text', multi: false }],
    outputs: [{ id: `${id}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: AgentConfigSchema.parse({
      providerId: newId(),
      modelId: 'mock-text',
      instructions: 'Write.',
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...config,
    }),
  };
}

/** A run and a node run to hang verdicts and approvals off. */
async function seedNodeRun(
  repo: SqliteRepository,
  overrides: Partial<NodeRun> = {},
): Promise<NodeRun> {
  const project = await repo.projects.create(scope, makeProject());
  const workflow = await repo.workflows.create(scope, makeWorkflow(project.id));
  const node = makeInputNode(workflow.id);

  const run: Run = {
    id: newId(),
    workflowId: workflow.id,
    projectId: project.id,
    status: 'RUNNING',
    snapshot: { version: 1, nodes: [node], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: NOW,
  };
  await repo.runs.create(scope, run);

  return repo.nodeRuns.create(scope, {
    id: newId(),
    runId: run.id,
    nodeId: node.id,
    iteration: 1,
    attempt: 1,
    status: 'RUNNING',
    inputEnvelopes: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    verdicts: [],
    toolCalls: [],
    startedAt: NOW,
    ...overrides,
  });
}

function verdict(nodeRunId: string, overrides: Partial<Verdict> = {}): Verdict {
  return VerdictSchema.parse({
    id: newId(),
    nodeRunId,
    point: 'output',
    checkType: 'pii',
    action: 'redact',
    passed: false,
    reason: 'one email address was replaced',
    redactedTypes: ['email'],
    at: NOW,
    ...overrides,
  });
}

function approvalRequest(
  runId: string,
  nodeRunId: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: newId(),
    runId,
    nodeRunId,
    nodeId: newId(),
    nodeName: 'Writer',
    point: 'output',
    checkType: 'pii',
    reason: 'the draft contains an email address',
    preview: 'Contact me at [email redacted] for details.',
    requestedAt: NOW,
    ...overrides,
  });
}

/** Compare checks ignoring the ids, which are fresh per policy by design. */
const shapeOf = (checks: readonly GuardrailCheck[]) =>
  checks.map(({ point, type, action, enabled, params }) => ({
    point,
    type,
    action,
    enabled,
    params,
  }));

/* -------------------------------------------------------------------------- */

describe('FR-GRD-018 Every project gets the default policy', () => {
  it('creates it with the project, in the same transaction', async () => {
    const project = await db.repository.projects.create(scope, makeProject());

    const policies = await db.repository.guardrailPolicies.listByProject(scope, project.id);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.name).toBe(DEFAULT_GUARDRAIL_POLICY_NAME);
    expect(policies[0]?.version).toBe(1);
    expect(policies[0]?.isProjectDefault).toBe(true);
    expect(policies[0]?.projectId).toBe(project.id);
  });

  it('gives it exactly the §2.2 checks, from the one definition in @ace/contracts', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);

    expect(shapeOf(policy?.checks ?? [])).toEqual(shapeOf(defaultGuardrailChecks(newId)));
    // Spot-checks of the three §2.2 rows most easily got wrong.
    expect(policy?.checks.find((check) => check.type === 'size_limit')?.params).toEqual({
      maxChars: 200_000,
    });
    expect(policy?.checks.find((check) => check.type === 'secret_leak')?.action).toBe('block');
    expect(policy?.checks.find((check) => check.type === 'destructive_action')?.action).toBe(
      'ask_user',
    );
  });

  it('gives every check a distinct id, and two projects distinct checks', async () => {
    const first = await db.repository.projects.create(scope, makeProject());
    const second = await db.repository.projects.create(scope, makeProject());

    const a = await db.repository.guardrailPolicies.getProjectDefault(scope, first.id);
    const b = await db.repository.guardrailPolicies.getProjectDefault(scope, second.id);

    const ids = (a?.checks ?? []).map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a?.id).not.toBe(b?.id);
    expect(ids).not.toEqual((b?.checks ?? []).map((check) => check.id));
  });

  it('rolls the policy back with the project when the transaction fails', async () => {
    const project = makeProject();

    await expect(
      db.repository.transaction(async (tx) => {
        await tx.projects.create(scope, project);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(await db.repository.projects.get(scope, project.id)).toBeNull();
    expect(await db.repository.guardrailPolicies.listByProject(scope, project.id)).toEqual([]);
  });

  it('keeps one default per project: a second default row is refused by the index', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const other = await db.repository.guardrailPolicies.create(scope, {
      id: newId(),
      projectId: project.id,
      name: 'Strict',
      version: 1,
      isProjectDefault: false,
      checks: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(() =>
      db.sqlite
        .prepare(
          `UPDATE guardrail_policies SET is_project_default = 1 WHERE id = ?`,
        )
        .run(other.id),
    ).toThrow(/UNIQUE/i);
  });

  it('moves the flag on set-default rather than adding one', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const before = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    const strict = await db.repository.guardrailPolicies.create(scope, {
      id: newId(),
      projectId: project.id,
      name: 'Strict',
      version: 1,
      isProjectDefault: false,
      checks: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const promoted = await db.repository.guardrailPolicies.setDefault(scope, strict.id);

    expect(promoted?.isProjectDefault).toBe(true);
    expect(await db.repository.guardrailPolicies.getProjectDefault(scope, project.id)).toMatchObject(
      { id: strict.id },
    );
    expect((await db.repository.guardrailPolicies.get(scope, before?.id ?? ''))?.isProjectDefault)
      .toBe(false);
  });

  it('answers null for a set-default on a policy that does not exist', async () => {
    expect(await db.repository.guardrailPolicies.setDefault(scope, newId())).toBeNull();
  });
});

describe('FR-GRD-001 Policy CRUD', () => {
  it('stores the version the caller supplies, because a PATCH writes version + 1', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    const checks = defaultGuardrailChecks(newId).slice(0, 2);

    const patched = await db.repository.guardrailPolicies.update(scope, policy?.id ?? '', {
      name: 'Loose',
      version: 2,
      checks,
      updatedAt: '2026-09-26T11:00:00.000Z',
    });

    expect(patched?.name).toBe('Loose');
    expect(patched?.version).toBe(2);
    expect(patched?.checks).toHaveLength(2);
    expect(patched?.updatedAt).toBe('2026-09-26T11:00:00.000Z');
    // The flag is not a patch field: a PATCH never promotes a policy.
    expect(patched?.isProjectDefault).toBe(true);
  });

  it('leaves the row alone for an empty patch, and answers null for an unknown id', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);

    expect(await db.repository.guardrailPolicies.update(scope, policy?.id ?? '', {})).toEqual(
      policy,
    );
    expect(await db.repository.guardrailPolicies.update(scope, newId(), { version: 9 })).toBeNull();
  });

  it('deletes, and reports whether there was anything to delete', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);

    expect(await db.repository.guardrailPolicies.delete(scope, policy?.id ?? '')).toBe(true);
    expect(await db.repository.guardrailPolicies.delete(scope, policy?.id ?? '')).toBe(false);
    expect(await db.repository.guardrailPolicies.listByProject(scope, project.id)).toEqual([]);
  });

  it('keeps workspaces apart (BR-18)', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);

    expect(await db.repository.guardrailPolicies.get(OTHER, policy?.id ?? '')).toBeNull();
    expect(await db.repository.guardrailPolicies.listByProject(OTHER, project.id)).toEqual([]);
    expect(await db.repository.guardrailPolicies.getProjectDefault(OTHER, project.id)).toBeNull();
  });

  it('names the nodes that use a policy, for the 409 policy_in_use guard', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const workflow = await db.repository.workflows.create(scope, makeWorkflow(project.id));
    const policy = await db.repository.guardrailPolicies.getProjectDefault(scope, project.id);
    const policyId = policy?.id ?? '';

    const user = agentNode(workflow.id, { guardrailPolicyId: policyId });
    const bystander = agentNode(workflow.id);
    await db.repository.nodes.insert(scope, user);
    await db.repository.nodes.insert(scope, bystander);

    const using = await db.repository.guardrailPolicies.nodesUsing(scope, policyId);
    expect(using.map((node) => node.id)).toEqual([user.id]);
  });

  it('does not count a node that merely mentions the id elsewhere in its config', async () => {
    const project = await db.repository.projects.create(scope, makeProject());
    const workflow = await db.repository.workflows.create(scope, makeWorkflow(project.id));
    const policyId = newId();

    // The id appears as a knowledge base reference, not as the policy.
    await db.repository.nodes.insert(
      scope,
      agentNode(workflow.id, { knowledgeBaseIds: [policyId] }),
    );

    expect(await db.repository.guardrailPolicies.nodesUsing(scope, policyId)).toEqual([]);
  });
});

describe('FR-GRD-015 Verdicts are stored on the node run and readable back', () => {
  it('appends in order and keeps the node run copy in step', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const first = verdict(nodeRun.id, { checkType: 'secret_leak', action: 'block', point: 'output' });
    const second = verdict(nodeRun.id);

    await db.repository.guardrailVerdicts.append(scope, first);
    await db.repository.guardrailVerdicts.append(scope, second);

    expect(await db.repository.guardrailVerdicts.listByNodeRun(scope, nodeRun.id)).toEqual([
      first,
      second,
    ]);
    // One write path, two copies that cannot drift.
    expect((await db.repository.nodeRuns.get(scope, nodeRun.id))?.verdicts).toEqual([
      first,
      second,
    ]);
  });

  it('stores a passing verdict, which has no redacted types at all', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const passed = verdict(nodeRun.id, {
      checkType: 'size_limit',
      point: 'input',
      action: 'pass',
      passed: true,
      reason: 'within 200000 characters',
      redactedTypes: undefined,
    });

    await db.repository.guardrailVerdicts.append(scope, passed);

    expect(await db.repository.guardrailVerdicts.listByNodeRun(scope, nodeRun.id)).toEqual([passed]);
    expect(passed.redactedTypes).toBeUndefined();
  });

  it('records a verdict whose node run is not stored, without inventing one', async () => {
    const orphan = verdict(newId());
    await db.repository.guardrailVerdicts.append(scope, orphan);

    expect(await db.repository.guardrailVerdicts.listByNodeRun(scope, orphan.nodeRunId)).toEqual([
      orphan,
    ]);
  });

  it('keeps workspaces apart (BR-18)', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    await db.repository.guardrailVerdicts.append(scope, verdict(nodeRun.id));

    expect(await db.repository.guardrailVerdicts.listByNodeRun(OTHER, nodeRun.id)).toEqual([]);
  });
});

describe('FR-GRD-014 A verdict cannot hold the value it redacted', () => {
  it('has no value column: the table holds exactly the contract fields', () => {
    const columns = (
      db.sqlite.prepare(`PRAGMA table_info(guardrail_verdicts)`).all() as { name: string }[]
    ).map((column) => column.name);

    expect(columns).toEqual([
      'id',
      'workspace_id',
      'node_run_id',
      'point',
      'check_type',
      'action',
      'passed',
      'reason',
      'redacted_types',
      'at',
    ]);
    expect(columns).not.toContain('value');
  });

  it('refuses a verdict that carries a value, at the contract', () => {
    expect(
      VerdictSchema.safeParse({ ...verdict(newId()), value: 'ada@example.com' }).success,
    ).toBe(false);
  });

  it('stores the redacted types and nothing else about what was found', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const redaction = verdict(nodeRun.id, { redactedTypes: ['email', 'credit_card'] });

    await db.repository.guardrailVerdicts.append(scope, redaction);

    const row = db.sqlite
      .prepare(`SELECT redacted_types AS types, reason FROM guardrail_verdicts WHERE id = ?`)
      .get(redaction.id) as { types: string; reason: string };
    expect(JSON.parse(row.types)).toEqual(['email', 'credit_card']);
    expect(row.reason).not.toMatch(/@/);
  });

  it('refuses a reason that quotes a live credential (BR-07)', async () => {
    const nodeRun = await seedNodeRun(db.repository);

    await expect(
      db.repository.guardrailVerdicts.append(
        scope,
        verdict(nodeRun.id, {
          checkType: 'secret_leak',
          action: 'block',
          reason: `the output contained ${FAKE_KEY}`,
        }),
      ),
    ).rejects.toThrow(SecretWriteRejectedError);

    expect(await db.repository.guardrailVerdicts.listByNodeRun(scope, nodeRun.id)).toEqual([]);
  });

  it('accepts the same reason once the key is redacted', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const redacted = verdict(nodeRun.id, {
      checkType: 'secret_leak',
      action: 'redact',
      reason: 'the output contained [api_key redacted]',
      redactedTypes: ['api_key'],
    });

    await expect(
      db.repository.guardrailVerdicts.append(scope, redacted),
    ).resolves.toEqual(redacted);
  });
});

describe('FR-GRD-013 Approvals', () => {
  it('creates a pending request and answers it on GET /runs/:id/approvals', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const request = approvalRequest(nodeRun.runId, nodeRun.id);

    await db.repository.approvals.create(scope, request);

    expect(await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).toEqual([request]);
    expect(await db.repository.approvals.findPendingByNodeRun(scope, nodeRun.id)).toEqual(request);
    expect(await db.repository.approvals.get(scope, request.id)).toEqual({ request });
  });

  it('records the decision, its note and its time, and leaves the run with nothing pending', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const request = approvalRequest(nodeRun.runId, nodeRun.id);
    await db.repository.approvals.create(scope, request);

    const decided = await db.repository.approvals.decide(scope, {
      requestId: request.id,
      decision: 'approve',
      note: 'fine to send',
      decidedAt: '2026-09-26T10:05:00.000Z',
    });

    expect(decided?.decision).toEqual({
      requestId: request.id,
      decision: 'approve',
      note: 'fine to send',
      decidedAt: '2026-09-26T10:05:00.000Z',
    });
    expect(await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).toEqual([]);
    expect(await db.repository.approvals.findPendingByNodeRun(scope, nodeRun.id)).toBeNull();
    // Mirrored onto the node run, so `NodeRun.approvals` and the table cannot drift.
    expect((await db.repository.nodeRuns.get(scope, nodeRun.id))?.approvals).toEqual([
      decided?.decision,
    ]);
  });

  it('appends a second decision on the same node run rather than replacing the first', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const first = approvalRequest(nodeRun.runId, nodeRun.id);
    const second = approvalRequest(nodeRun.runId, nodeRun.id, {
      checkType: 'destructive_action',
      point: 'tool',
      reason: 'the tool would delete a file',
      preview: 'rm -rf ./out',
    });
    await db.repository.approvals.create(scope, first);
    await db.repository.approvals.create(scope, second);

    await db.repository.approvals.decide(scope, {
      requestId: first.id,
      decision: 'approve',
      decidedAt: '2026-09-26T10:05:00.000Z',
    });
    await db.repository.approvals.decide(scope, {
      requestId: second.id,
      decision: 'reject',
      decidedAt: '2026-09-26T10:06:00.000Z',
    });

    expect((await db.repository.nodeRuns.get(scope, nodeRun.id))?.approvals).toEqual([
      { requestId: first.id, decision: 'approve', decidedAt: '2026-09-26T10:05:00.000Z' },
      { requestId: second.id, decision: 'reject', decidedAt: '2026-09-26T10:06:00.000Z' },
    ]);
    expect(await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).toEqual([]);
  });

  it('records a reject the same way, without a note', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const request = approvalRequest(nodeRun.runId, nodeRun.id);
    await db.repository.approvals.create(scope, request);

    const decided = await db.repository.approvals.decide(scope, {
      requestId: request.id,
      decision: 'reject',
      decidedAt: '2026-09-26T10:06:00.000Z',
    });

    expect(decided?.decision?.decision).toBe('reject');
    expect(decided?.decision?.note).toBeUndefined();
  });

  it('keeps the first decision and answers null for an unknown request', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const request = approvalRequest(nodeRun.runId, nodeRun.id);
    await db.repository.approvals.create(scope, request);

    await db.repository.approvals.decide(scope, {
      requestId: request.id,
      decision: 'approve',
      decidedAt: '2026-09-26T10:05:00.000Z',
    });
    const again = await db.repository.approvals.decide(scope, {
      requestId: request.id,
      decision: 'reject',
      decidedAt: '2026-09-26T10:07:00.000Z',
    });

    expect(again?.decision?.decision).toBe('approve');
    expect((await db.repository.nodeRuns.get(scope, nodeRun.id))?.approvals).toHaveLength(1);
    expect(
      await db.repository.approvals.decide(scope, {
        requestId: newId(),
        decision: 'approve',
        decidedAt: NOW,
      }),
    ).toBeNull();
  });

  it('lists only this run, oldest first, and keeps workspaces apart (BR-18)', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const first = approvalRequest(nodeRun.runId, nodeRun.id);
    const second = approvalRequest(nodeRun.runId, newId());
    const elsewhere = approvalRequest(newId(), newId());
    await db.repository.approvals.create(scope, first);
    await db.repository.approvals.create(scope, second);
    await db.repository.approvals.create(scope, elsewhere);

    expect(
      (await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).map((row) => row.id),
    ).toEqual([first.id, second.id]);
    expect(await db.repository.approvals.listPendingByRun(OTHER, nodeRun.runId)).toEqual([]);
    expect(await db.repository.approvals.get(OTHER, first.id)).toBeNull();
  });

  it('refuses a preview that carries a live credential and accepts a redacted one (BR-07)', async () => {
    const nodeRun = await seedNodeRun(db.repository);

    await expect(
      db.repository.approvals.create(
        scope,
        approvalRequest(nodeRun.runId, nodeRun.id, {
          checkType: 'secret_leak',
          preview: `the draft ends with ${FAKE_KEY}`,
        }),
      ),
    ).rejects.toThrow(SecretWriteRejectedError);

    const redacted = approvalRequest(nodeRun.runId, nodeRun.id, {
      checkType: 'secret_leak',
      preview: 'the draft ends with [api_key redacted]',
    });
    await expect(db.repository.approvals.create(scope, redacted)).resolves.toEqual(redacted);
    expect(await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).toEqual([redacted]);
  });

  it('refuses a decision note that carries a credential (BR-07)', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const request = approvalRequest(nodeRun.runId, nodeRun.id);
    await db.repository.approvals.create(scope, request);

    await expect(
      db.repository.approvals.decide(scope, {
        requestId: request.id,
        decision: 'approve',
        note: `use ${FAKE_KEY} instead`,
        decidedAt: NOW,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);

    expect(await db.repository.approvals.listPendingByRun(scope, nodeRun.runId)).toEqual([request]);
  });
});

describe('FR-GRD-008 Budgets', () => {
  it("sums today's node runs and ignores other days, other workspaces and unstarted runs", async () => {
    const nodeRun = await seedNodeRun(db.repository, {
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.004 },
    });
    await db.repository.nodeRuns.create(scope, {
      ...nodeRun,
      id: newId(),
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.006 },
      startedAt: '2026-09-26T23:59:59.999Z',
    });
    await db.repository.nodeRuns.create(scope, {
      ...nodeRun,
      id: newId(),
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 5 },
      startedAt: '2026-09-25T10:00:00.000Z',
    });
    const { startedAt: _unused, ...never } = nodeRun;
    await db.repository.nodeRuns.create(scope, {
      ...never,
      id: newId(),
      status: 'READY',
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 9 },
    });

    expect(await db.repository.nodeRuns.dailyCostUsd(scope, '2026-09-26')).toBeCloseTo(0.01, 10);
    expect(await db.repository.nodeRuns.dailyCostUsd(scope, '2026-09-25')).toBe(5);
    expect(await db.repository.nodeRuns.dailyCostUsd(OTHER, '2026-09-26')).toBe(0);
  });

  it('answers 0 for a day with no node runs', async () => {
    expect(await db.repository.nodeRuns.dailyCostUsd(scope, '2026-01-01')).toBe(0);
  });

  it('keeps the project cost cap, and lets a patch remove it (§2.3, D72)', async () => {
    const created = await db.repository.projects.create(
      scope,
      makeProject({ maxCostPerRunUsd: 0.01 }),
    );
    expect((await db.repository.projects.get(scope, created.id))?.maxCostPerRunUsd).toBe(0.01);

    const raised = await db.repository.projects.update(scope, created.id, {
      maxCostPerRunUsd: 2.5,
      updatedAt: NOW,
    });
    expect(raised?.maxCostPerRunUsd).toBe(2.5);

    // A patch that does not mention the cap leaves it alone.
    const renamed = await db.repository.projects.update(scope, created.id, {
      name: 'Renamed',
      updatedAt: NOW,
    });
    expect(renamed?.maxCostPerRunUsd).toBe(2.5);

    const cleared = await db.repository.projects.update(scope, created.id, {
      maxCostPerRunUsd: null,
      updatedAt: NOW,
    });
    expect(cleared?.maxCostPerRunUsd).toBeUndefined();
  });
});

describe('Round 3 NodeRun columns', () => {
  it('keeps the guardrail policy ref, the loop stop reason and the reuse marker', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const policy = { id: newId(), version: 3 };

    const patched = await db.repository.nodeRuns.update(scope, nodeRun.id, {
      guardrailPolicy: policy,
      loopStop: 'max_iterations',
      reusedFromNodeRunId: nodeRun.id,
    });

    expect(patched?.guardrailPolicy).toEqual(policy);
    expect(patched?.loopStop).toBe('max_iterations');
    expect(patched?.reusedFromNodeRunId).toBe(nodeRun.id);
    expect(await db.repository.nodeRuns.get(scope, nodeRun.id)).toEqual(patched);
  });

  it('writes them with the row when create is given them', async () => {
    const nodeRun = await seedNodeRun(db.repository);
    const created = await db.repository.nodeRuns.create(scope, {
      ...nodeRun,
      id: newId(),
      guardrailPolicy: { id: newId(), version: 1 },
      approvals: [{ requestId: newId(), decision: 'approve', decidedAt: NOW }],
      loopStop: 'exit_condition',
      reusedFromNodeRunId: nodeRun.id,
    });

    expect(await db.repository.nodeRuns.get(scope, created.id)).toEqual(created);
  });
});
