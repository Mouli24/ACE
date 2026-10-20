import { API_BASE_PATH, type ApprovalCommand, type ApprovalDecision } from '@ace/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { toApiError } from '../../gateway/errors.js';
import { FakeGuardrailStore, RecordingBus, id } from '../../guardrails/__tests__/fakes.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import {
  ApprovalAlwaysRefusedError,
  createApprovalService,
  type ApprovalRequestInput,
} from '../index.js';
import { createApprovalRoutes } from '../routes.js';

/**
 * D376 at the approval service's own seam (FR-GRD-013, FR-GRD-006): `always: true` on an approve
 * records the request's `command.allowPrefix` with the decision and hands it to `onAlways` before
 * the paused node resumes; a request with nothing to always-allow is refused and stays pending. The
 * run-level behaviour — the next identical command runs with no card, the workflow's node lists the
 * prefix — is `always-allow-routes.test.ts`.
 */

function harness() {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();
  const order: string[] = [];
  const always: { runId: string; nodeId: string; prefix: string }[] = [];
  const approvals = createApprovalService({
    scope: LOCAL_SCOPE,
    approvals: store.approvals,
    nodeRuns: store.nodeRuns,
    bus,
    onDecided: async () => {
      order.push('decided');
    },
    onAlways: async (runId, nodeId, prefix) => {
      order.push('always');
      always.push({ runId, nodeId, prefix });
    },
  });
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  const api = new Hono();
  api.route('/', createApprovalRoutes(approvals));
  app.route(API_BASE_PATH, api);
  const post = (nodeRunId: string, kind: 'approve' | 'reject', body: unknown) =>
    app.request(`http://127.0.0.1:4747${API_BASE_PATH}/node-runs/${nodeRunId}/${kind}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  return { store, bus, approvals, order, always, post };
}

const ask = (command?: ApprovalCommand): ApprovalRequestInput => ({
  runId: id(),
  workflowId: id(),
  nodeRunId: id(),
  nodeId: id(),
  nodeName: 'Builder',
  point: 'tool',
  checkType: 'destructive_action',
  reason: 'Tool run_command performs a destructive action.',
  preview: 'run_command {"command":"npm run build"}',
  ...(command === undefined ? {} : { command }),
});

const BUILD: ApprovalCommand = {
  text: 'npm run build',
  allowPrefix: 'npm run build',
  denylisted: false,
};

/** Resolves once the request is stored, so a decision has something to find. */
async function asked(h: ReturnType<typeof harness>, input: ApprovalRequestInput) {
  const wait = h.approvals.request(input);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [pending] = await h.approvals.listPending(input.runId);
    if (pending !== undefined) return { wait, pending };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('no approval was requested');
}

describe('D376 the approval service and Always allow', () => {
  it('stores the command on the request it announces', async () => {
    const h = harness();
    const { pending } = await asked(h, ask(BUILD));
    expect(pending.command).toEqual(BUILD);
    const [event] = h.bus.ofType('node.approval_required');
    expect((event?.payload as { request: { command?: unknown } }).request.command).toEqual(BUILD);
  });

  it('approve with always records the prefix and saves it before the node resumes', async () => {
    const h = harness();
    const input = ask(BUILD);
    const { wait } = await asked(h, input);
    let resumedAfter: string[] = [];
    const resumed = wait.then((decision) => {
      resumedAfter = [...h.order];
      return decision;
    });

    const { decision } = await h.approvals.decide(input.nodeRunId, 'approve', { always: true });

    expect(decision).toMatchObject({ decision: 'approve', always: true, prefix: 'npm run build' });
    expect(h.always).toEqual([
      { runId: input.runId, nodeId: input.nodeId, prefix: 'npm run build' },
    ]);
    expect(await resumed).toEqual(decision);
    expect(resumedAfter).toEqual(['always', 'decided']);
    const [decided] = h.bus.ofType('node.approval_decided');
    expect((decided?.payload as { decision: ApprovalDecision }).decision).toMatchObject({
      always: true,
      prefix: 'npm run build',
    });
  });

  it('approve without always saves nothing', async () => {
    const h = harness();
    const input = ask(BUILD);
    await asked(h, input);
    const { decision } = await h.approvals.decide(input.nodeRunId, 'approve', { note: 'once' });
    expect(decision).not.toHaveProperty('always');
    expect(decision).not.toHaveProperty('prefix');
    expect(decision.note).toBe('once');
    expect(h.always).toEqual([]);
  });

  it.each([
    ['no command', undefined],
    ['a command with no prefix', { text: 'pnpm install && pnpm test', denylisted: false }],
    ['a denylisted command', { text: 'git push --force', denylisted: true }],
  ])('refuses always on a request with %s, and leaves it pending', async (_label, command) => {
    const h = harness();
    const input = ask(command);
    await asked(h, input);

    await expect(
      h.approvals.decide(input.nodeRunId, 'approve', { always: true }),
    ).rejects.toBeInstanceOf(ApprovalAlwaysRefusedError);

    expect(await h.approvals.listPending(input.runId)).toHaveLength(1);
    expect(h.always).toEqual([]);
  });

  it('refuses always on a reject', async () => {
    const h = harness();
    const input = ask(BUILD);
    await asked(h, input);
    await expect(
      h.approvals.decide(input.nodeRunId, 'reject', { always: true }),
    ).rejects.toBeInstanceOf(ApprovalAlwaysRefusedError);
    expect(await h.approvals.listPending(input.runId)).toHaveLength(1);
  });
});

describe('D376 POST /node-runs/:id/approve with always', () => {
  it('answers 400 validation_failed when the request offers no prefix', async () => {
    const h = harness();
    const input = ask({ text: 'echo $(whoami)', denylisted: false });
    await asked(h, input);

    const response = await h.post(input.nodeRunId, 'approve', { always: true });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe("This command can't be always-allowed.");
    expect(await h.approvals.listPending(input.runId)).toHaveLength(1);
  });

  it('answers 400 for always on a request with no command at all', async () => {
    const h = harness();
    const input = ask();
    await asked(h, input);
    const response = await h.post(input.nodeRunId, 'approve', { always: true });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "This command can't be always-allowed.",
    );
  });

  it('answers 400 for always on /reject', async () => {
    const h = harness();
    const input = ask(BUILD);
    await asked(h, input);
    const response = await h.post(input.nodeRunId, 'reject', { always: true });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );
  });

  it('refuses always: false as an invalid body', async () => {
    const h = harness();
    const input = ask(BUILD);
    await asked(h, input);
    const response = await h.post(input.nodeRunId, 'approve', { always: false });
    expect(response.status).toBe(400);
  });
});
