import type { RunApprovalRequest } from '../ports/index.js';
import type { NodeRun, Run } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  ApprovalNotFoundError,
  createApprovalService,
  type ApprovalService,
} from '../approvals/index.js';
import { createEventBus } from '../events/index.js';
import { guardrailStoreFor } from '../guardrails/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../ports/index.js';
import { haltActiveRuns, recoverAfterCrash, type LifecycleDeps } from '../runs/lifecycle.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * D-061 — an approval left pending by a process that is gone (FR-SYS-009, TC-SYS-010, FR-GRD-013,
 * D111, D120).
 *
 * `recoverAfterCrash` STOPs a node that was WAITING on an approval, but the approval itself stayed
 * pending: the card was still listed on a HALTED `crash` run, an Approve answered 200, and the
 * approval service's `onDecided` moved the STOPPED row back to RUNNING — a row nothing would ever
 * finish. Recovery now rejects what the dead process left pending, and a decision on a request no
 * process is suspended on moves no row at all.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-09-30T10:00:00.000Z';

async function harness(options: { failCancel?: boolean } = {}) {
  const repository = new FakeRepository();
  const bus = createEventBus({ repository, scope, pubsub: new InProcessPubSubStub<EngineEvent>() });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const store = guardrailStoreFor(repository, scope);
  /** The server's hook: an approve moves the node run to RUNNING (apps/server/src/server.ts). */
  const moved: string[] = [];
  const approvals: ApprovalService = createApprovalService({
    scope,
    approvals: store.approvals,
    nodeRuns: store.nodeRuns,
    bus,
    onDecided: async (request, decision) => {
      if (decision.decision !== 'approve') return;
      moved.push(request.nodeRunId);
      await repository.nodeRuns.update(scope, request.nodeRunId, { status: 'RUNNING' });
    },
  });

  const warnings: string[] = [];
  const deps: LifecycleDeps = {
    repository,
    scope,
    bus,
    logger: createLogger({
      level: 'warn',
      destination: {
        write: (line) => {
          warnings.push((JSON.parse(line) as { msg: string }).msg);
        },
      },
    }),
    now: () => '2026-09-30T10:05:00.000Z',
    approvals:
      options.failCancel === true
        ? {
            cancelPending: async () => {
              throw new Error('the approvals table is locked');
            },
          }
        : approvals,
  };

  /** What the last process left behind: a run it was driving and a node WAITING on a card. */
  async function stranded(status: Run['status'] = 'RUNNING', nodes: Run['snapshot']['nodes'] = []) {
    const run: Run = {
      id: newId(),
      workflowId: newId(),
      projectId: newId(),
      status,
      snapshot: { version: 1, nodes, edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      startedAt: NOW,
    };
    await repository.runs.create(scope, run);
    const nodeRun: NodeRun = {
      id: newId(),
      runId: run.id,
      nodeId: newId(),
      iteration: 1,
      attempt: 1,
      status: 'WAITING',
      inputEnvelopes: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      verdicts: [],
      toolCalls: [],
      approvals: [],
    };
    await repository.nodeRuns.create(scope, nodeRun);
    const request: RunApprovalRequest = {
      id: newId(),
      runId: run.id,
      nodeRunId: nodeRun.id,
      nodeId: nodeRun.nodeId,
      nodeName: 'Cleaner',
      point: 'tool',
      checkType: 'destructive_action',
      reason: 'Tool sandbox_delete performs a destructive action.',
      preview: 'sandbox_delete {"path":"notes.txt"}',
      requestedAt: NOW,
    };
    await repository.approvals.create(scope, request);
    return { run, nodeRun, request };
  }

  const status = async (nodeRunId: string) =>
    (await repository.nodeRuns.get(scope, nodeRunId))?.status;

  return { repository, events, approvals, deps, stranded, status, moved, warnings };
}

describe('FR-SYS-009 FR-GRD-013 D-061 recovery rejects the approvals a dead process left pending', () => {
  it('rejects the card of a node it STOPs, so a later Approve or Reject finds nothing (D120)', async () => {
    const h = await harness();
    const { run, nodeRun, request } = await h.stranded();

    await recoverAfterCrash(h.deps);

    expect(await h.approvals.listPending(run.id)).toEqual([]);
    const stored = await h.repository.approvals.get(scope, request.id);
    expect(stored?.decision).toMatchObject({ decision: 'reject' });
    expect(h.events.filter((event) => event.type === 'node.approval_decided')).toHaveLength(1);

    await expect(h.approvals.decide(nodeRun.id, 'approve')).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
    await expect(h.approvals.decide(nodeRun.id, 'reject')).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
    expect(await h.status(nodeRun.id)).toBe('STOPPED');
    expect(h.moved).toEqual([]);
    expect((await h.repository.runs.get(scope, run.id))?.haltReason).toBe('crash');
  });

  it('rejects them on a shutdown halt too — nobody will answer after the engine is gone', async () => {
    const h = await harness();
    const { run } = await h.stranded();

    await haltActiveRuns(h.deps);

    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect((await h.repository.runs.get(scope, run.id))?.haltReason).toBe('shutdown');
  });

  it('still halts the run and STOPs its node when the approvals cannot be rejected', async () => {
    const h = await harness({ failCancel: true });
    const { run, nodeRun } = await h.stranded();

    const result = await recoverAfterCrash(h.deps);

    expect(result).toEqual({ runs: [run.id], nodeRuns: [nodeRun.id], reopened: [] });
    expect(await h.status(nodeRun.id)).toBe('STOPPED');
    expect(h.warnings).toContain('could not reject the approvals of a halted run');
  });
});

describe('FR-GRD-013 D111 D-061 a decision nobody in this process is waiting on moves no row', () => {
  it('records an Approve on an orphaned request but leaves the STOPPED node where it is', async () => {
    const h = await harness();
    // A request an older engine left pending on a run it had already halted: no process waits on it.
    const { run, nodeRun } = await h.stranded('HALTED');
    await h.repository.nodeRuns.update(scope, nodeRun.id, { status: 'STOPPED' });

    const { decision } = await h.approvals.decide(nodeRun.id, 'approve');

    expect(decision.decision).toBe('approve');
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect(h.moved).toEqual([]);
    expect(await h.status(nodeRun.id)).toBe('STOPPED');
  });
});

/** A snapshot node: only `kind` and `config.workspace` matter to recovery. */
const snapshotNode = (access: 'off' | 'edit_files'): Run['snapshot']['nodes'][number] =>
  ({
    id: newId(),
    kind: 'agent',
    name: 'Worker',
    config: {
      tools: { enabled: [] },
      ...(access === 'off' ? {} : { workspace: { access, maxTurns: 10, allowedCommands: [] } }),
    },
  }) as unknown as Run['snapshot']['nodes'][number];

describe('D379 a restart leaves an agentic step BLOCKED with the reason', () => {
  async function twoRuns(h: Awaited<ReturnType<typeof harness>>) {
    const running = snapshotNode('edit_files');
    const waiting = snapshotNode('edit_files');
    const plain = snapshotNode('off');
    const { run } = await h.stranded('RUNNING', [running, waiting, plain]);
    const make = async (nodeId: string, status: NodeRun['status']) => {
      const row: NodeRun = {
        id: newId(),
        runId: run.id,
        nodeId,
        iteration: 1,
        attempt: 1,
        status,
        inputEnvelopes: [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        verdicts: [],
        toolCalls: [],
        approvals: [],
      };
      await h.repository.nodeRuns.create(scope, row);
      return row;
    };
    return {
      run,
      running: await make(running.id, 'RUNNING'),
      waiting: await make(waiting.id, 'WAITING'),
      plain: await make(plain.id, 'RUNNING'),
    };
  }

  it('BLOCKs a RUNNING and a WAITING agentic step; a non-agentic one stays STOPPED', async () => {
    const h = await harness();
    const { running, waiting, plain } = await twoRuns(h);

    await recoverAfterCrash(h.deps);

    const row = (id: string) => h.repository.nodeRuns.get(scope, id);
    expect(await row(running.id)).toMatchObject({
      status: 'BLOCKED',
      error: {
        code: 'engine_restarted',
        retryable: true,
        message: 'The engine restarted mid-step. Background commands from this run were stopped.',
      },
    });
    expect(await row(waiting.id)).toMatchObject({
      status: 'BLOCKED',
      error: {
        code: 'approval_lost',
        message:
          'The approval was lost when the engine restarted. Background commands from this run were stopped.',
      },
    });
    expect(await row(plain.id)).toMatchObject({ status: 'STOPPED' });
    expect((await row(plain.id))?.error).toBeUndefined();
  });

  it('a Domain stayOpen run also has its pending approvals rejected', async () => {
    const h = await harness();
    const { run, request } = await h.stranded();
    h.deps.keepOpen = () => true;

    const result = await recoverAfterCrash(h.deps);

    expect(result.reopened.map((r) => r.id)).toEqual([run.id]);
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect((await h.repository.approvals.get(scope, request.id))?.decision).toMatchObject({
      decision: 'reject',
    });
  });
});
