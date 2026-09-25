import type {
  ApprovalRequest,
  GuardrailPolicy,
  NodeRun,
  PolicyTestResponse,
  Run,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createAceClient } from '../index.js';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const R = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const R2 = '01ARZ3NDEKTSV4RRFFQ69G5FB9';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const NODE_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const POLICY = '01ARZ3NDEKTSV4RRFFQ69G5FC0';
const CHECK = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
const REQUEST = '01ARZ3NDEKTSV4RRFFQ69G5FC2';
const NOW = '2026-09-26T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Like the round 2 recorder, with a status per response so a 204 delete can be exercised too. */
function recorder(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

const run: Run = {
  id: R,
  workflowId: W,
  projectId: P,
  status: 'RUNNING',
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: usage,
  startedAt: NOW,
  allowedActions: ['pause', 'stop'],
};

const paused: Run = { ...run, status: 'PAUSED', pausedAt: NOW, allowedActions: ['resume', 'stop'] };

const nodeRun: NodeRun = {
  id: NODE_RUN,
  runId: R,
  nodeId: NODE,
  iteration: 1,
  attempt: 2,
  status: 'RUNNING',
  inputEnvelopes: [],
  usage,
  verdicts: [],
  toolCalls: [],
  approvals: [],
};

const policy: GuardrailPolicy = {
  id: POLICY,
  projectId: P,
  name: 'Default',
  version: 1,
  isProjectDefault: true,
  checks: [{ id: CHECK, point: 'input', type: 'pii', action: 'warn', enabled: true, params: {} }],
  createdAt: NOW,
  updatedAt: NOW,
};

const approval: ApprovalRequest = {
  id: REQUEST,
  runId: R,
  nodeRunId: NODE_RUN,
  nodeId: NODE,
  nodeName: 'Deleter',
  point: 'tool',
  checkType: 'destructive_action',
  reason: 'the tool would delete a folder',
  preview: 'rm -rf /tmp/demo',
  requestedAt: NOW,
};

const policyTest: PolicyTestResponse = {
  verdicts: [
    {
      point: 'input',
      checkType: 'pii',
      action: 'warn',
      passed: false,
      reason: 'an email address was found',
      redactedTypes: ['email'],
      at: NOW,
    },
  ],
};

describe('TC-CTL-001..004 run controls (round 3 §2.5, FR-CTL-001..004)', () => {
  it('each control posts to its own path and answers the Run', async () => {
    const restarted: Run = { ...run, id: R2, restartedFromRunId: R };
    const { calls, client } = recorder([
      { body: paused },
      { body: run },
      { body: { ...run, status: 'HALTED', haltReason: 'stopped', allowedActions: ['restart'] } },
      { body: restarted },
    ]);

    expect(await client.pauseRun(R)).toMatchObject({ status: 'PAUSED', pausedAt: NOW });
    expect(await client.resumeRun(R)).toMatchObject({ status: 'RUNNING' });
    expect(await client.stopRun(R)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    // A restart answers the new run, not the one it was started from (FR-CTL-004).
    expect(await client.restartRun(R)).toMatchObject({ id: R2, restartedFromRunId: R });

    expect(paths(calls)).toEqual([
      `POST /runs/${R}/pause`,
      `POST /runs/${R}/resume`,
      `POST /runs/${R}/stop`,
      `POST /runs/${R}/restart`,
    ]);
    expect(calls.every((c) => c.body === undefined)).toBe(true);
  });

  it('TC-CTL-006 a control the run state forbids surfaces 409 invalid_run_state', async () => {
    const { client } = recorder([
      {
        status: 409,
        body: {
          error: {
            kind: 'workflow',
            code: 'invalid_run_state',
            message: 'A COMPLETE run cannot be paused.',
            retryable: false,
          },
        },
      },
    ]);
    const error = await client.pauseRun(R).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: 'invalid_run_state', retryable: false });
  });
});

describe('TC-ERR-003/004 and TC-CTL-005 retries and re-runs (round 3 §2.1)', () => {
  it('retry sends withDownstream and answers the new attempt', async () => {
    const { calls, client } = recorder([{ body: nodeRun }]);
    const next = await client.retryNodeRun(NODE_RUN, { withDownstream: true });
    expect(next.attempt).toBe(2);
    expect(paths(calls)).toEqual([`POST /node-runs/${NODE_RUN}/retry`]);
    expect(calls[0]?.body).toEqual({ withDownstream: true });
  });

  it('a retry of one node alone still names the flag, so the engine never has to assume', async () => {
    const { calls, client } = recorder([{ body: nodeRun }]);
    await client.retryNodeRun(NODE_RUN, { withDownstream: false });
    expect(calls[0]?.body).toEqual({ withDownstream: false });
  });

  it('rerun addresses the node through its run and posts an empty body (FR-CTL-005)', async () => {
    const { calls, client } = recorder([{ body: { ...nodeRun, attempt: 1 } }]);
    await client.rerunNode(R, NODE);
    expect(paths(calls)).toEqual([`POST /runs/${R}/nodes/${NODE}/rerun`]);
    expect(calls[0]?.body).toEqual({});
  });
});

describe('TC-GRD-008/009 approvals (round 3 §2.5, FR-GRD-013)', () => {
  it('approve and reject are separate routes and carry the optional note', async () => {
    const { calls, client } = recorder([
      { body: nodeRun },
      { body: { ...nodeRun, status: 'FAILED', failureReason: 'GUARDRAIL_VIOLATION' } },
      { body: nodeRun },
    ]);

    await client.approveNodeRun(NODE_RUN, { note: 'looks safe' });
    const rejected = await client.rejectNodeRun(NODE_RUN, { note: 'not that folder' });
    await client.approveNodeRun(NODE_RUN);

    expect(rejected.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(paths(calls)).toEqual([
      `POST /node-runs/${NODE_RUN}/approve`,
      `POST /node-runs/${NODE_RUN}/reject`,
      `POST /node-runs/${NODE_RUN}/approve`,
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { note: 'looks safe' },
      { note: 'not that folder' },
      {},
    ]);
  });

  it('the pending approvals of a run come back as a bare array (§2.5, D78)', async () => {
    const { calls, client } = recorder([{ body: [approval] }]);
    const pending = await client.listApprovals(R);
    expect(pending).toEqual([approval]);
    expect(paths(calls)).toEqual([`GET /runs/${R}/approvals`]);
  });

  it('a preview longer than the contract allows is a defect, not a screen full of text', async () => {
    const { client } = recorder([{ body: [{ ...approval, preview: 'x'.repeat(501) }] }]);
    const error = await client.listApprovals(R).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid_response' });
  });
});

describe('TC-GRD-001 guardrail policy lifecycle (round 3 §2.5, FR-GRD-001, 002, 011)', () => {
  it('lists, creates, reads, patches to version + 1, tests and sets the default', async () => {
    const { calls, client } = recorder([
      { body: { items: [policy] } },
      { body: policy },
      { body: policy },
      { body: { ...policy, version: 2, name: 'Strict' } },
      { body: policyTest },
      { body: policy },
    ]);

    const list = await client.listGuardrailPolicies({ projectId: P });
    await client.createGuardrailPolicy({ projectId: P, name: 'Strict', checks: policy.checks });
    await client.getGuardrailPolicy(POLICY);
    const patched = await client.updateGuardrailPolicy(POLICY, { name: 'Strict' });
    const tested = await client.testGuardrailPolicy(POLICY, {
      text: 'mail me at a@b.com',
      point: 'input',
    });
    const madeDefault = await client.setDefaultGuardrailPolicy(POLICY);

    expect(list.items).toEqual([policy]);
    expect(patched.version).toBe(2);
    expect(tested.verdicts[0]).toMatchObject({ action: 'warn', redactedTypes: ['email'] });
    expect(madeDefault.isProjectDefault).toBe(true);
    expect(paths(calls)).toEqual([
      `GET /guardrail-policies?projectId=${P}`,
      'POST /guardrail-policies',
      `GET /guardrail-policies/${POLICY}`,
      `PATCH /guardrail-policies/${POLICY}`,
      `POST /guardrail-policies/${POLICY}/test`,
      `POST /guardrail-policies/${POLICY}/set-default`,
    ]);
    expect(calls[1]?.body).toEqual({ projectId: P, name: 'Strict', checks: policy.checks });
    expect(calls[4]?.body).toEqual({ text: 'mail me at a@b.com', point: 'input' });
  });

  it('a policy with no project filter asks for all of them', async () => {
    const { calls, client } = recorder([{ body: { items: [] } }]);
    await client.listGuardrailPolicies();
    expect(paths(calls)).toEqual(['GET /guardrail-policies']);
  });

  it('delete asks for confirmation only when told to, and 409 policy_in_use names the nodes', async () => {
    const { calls, client } = recorder([
      {
        status: 409,
        body: {
          error: {
            kind: 'workflow',
            code: 'policy_in_use',
            message: 'two nodes still use it',
            details: { nodeIds: [NODE] },
            retryable: false,
          },
        },
      },
      { status: 204 },
    ]);

    const error = await client.deleteGuardrailPolicy(POLICY).catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      code: 'policy_in_use',
      details: { nodeIds: [NODE] },
    });
    await expect(client.deleteGuardrailPolicy(POLICY, { confirm: true })).resolves.toBeUndefined();
    expect(paths(calls)).toEqual([
      `DELETE /guardrail-policies/${POLICY}`,
      `DELETE /guardrail-policies/${POLICY}?confirm=true`,
    ]);
  });

  it('TC-GRD-015 a check at the data point never leaves the client (BR-15)', async () => {
    const { client } = recorder([{ body: policy }]);
    const error = await client
      .createGuardrailPolicy({
        projectId: P,
        name: 'No redaction',
        // `data` is not a policy point at all: the body is refused before it is sent.
        checks: [
          {
            id: CHECK,
            point: 'data' as unknown as 'input',
            type: 'secret_leak',
            action: 'pass',
            enabled: false,
            params: {},
          },
        ],
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'validation_failed', status: 0 });
  });
});
