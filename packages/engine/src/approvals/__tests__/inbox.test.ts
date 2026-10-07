import { PendingApprovalListResponseSchema, type ApprovalRequest, type Run } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { routeApp, send } from '../../__tests__/route-app.js';
import { newId } from '../../ids.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { InMemoryTaskRepos } from '../../tasks/__tests__/harness.js';
import { createApprovalInbox } from '../inbox.js';
import { createApprovalRoutes } from '../routes.js';

/*
 * ACE parity P1 (D270): the approvals inbox — every pending approval across runs, oldest first,
 * with the run's workflow and project, and its task when a task started the run.
 */

const scope = LOCAL_SCOPE;
const T0 = Date.parse('2026-10-07T09:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

async function run(repository: FakeRepository, projectId = newId()): Promise<Run> {
  return repository.runs.create(scope, {
    id: newId(),
    workflowId: newId(),
    projectId,
    status: 'RUNNING',
    snapshot: { version: 1, nodes: [], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: at(0),
  });
}

async function ask(
  repository: FakeRepository,
  runId: string,
  minutes: number,
  nodeName = 'Writer',
): Promise<ApprovalRequest> {
  return repository.approvals.create(scope, {
    id: newId(),
    runId,
    nodeRunId: newId(),
    nodeId: newId(),
    nodeName,
    point: 'tool',
    checkType: 'destructive_action',
    reason: 'run_command is destructive',
    preview: 'run_command {"command":"rm -rf build"}',
    requestedAt: at(minutes),
  });
}

describe('D270 the approvals inbox', () => {
  it('lists every pending approval across runs, oldest first, with run, project and task', async () => {
    const repository = new FakeRepository();
    const repos = new InMemoryTaskRepos();
    Object.assign(repository, { taskExecutions: repos.taskExecutions });

    const taskRun = await run(repository);
    const plainRun = await run(repository);
    const taskId = newId();
    await repos.taskExecutions.create(scope, {
      id: newId(),
      taskId,
      kind: 'work',
      sequence: 1,
      workflowId: taskRun.workflowId,
      runId: taskRun.id,
      status: 'running',
      request: 'Add search',
      startedAt: at(0),
    });

    const later = await ask(repository, plainRun.id, 5, 'Cleaner');
    const first = await ask(repository, taskRun.id, 1, 'Builder');
    const second = await ask(repository, taskRun.id, 3, 'Builder');
    const decided = await ask(repository, plainRun.id, 0, 'Done already');
    await repository.approvals.decide(scope, {
      requestId: decided.id,
      decision: 'approve',
      decidedAt: at(2),
    });

    const items = await createApprovalInbox({ repository, scope }).listPending();
    expect(PendingApprovalListResponseSchema.parse({ items })).toEqual({ items });
    expect(items).toEqual([
      { request: first, workflowId: taskRun.workflowId, projectId: taskRun.projectId, taskId },
      { request: second, workflowId: taskRun.workflowId, projectId: taskRun.projectId, taskId },
      { request: later, workflowId: plainRun.workflowId, projectId: plainRun.projectId },
    ]);
  });

  it('works without task repositories, and skips a request whose run is gone', async () => {
    const repository = new FakeRepository();
    const kept = await run(repository);
    const request = await ask(repository, kept.id, 1);
    await ask(repository, newId(), 0);

    expect(await createApprovalInbox({ repository, scope }).listPending()).toEqual([
      { request, workflowId: kept.workflowId, projectId: kept.projectId },
    ]);
  });

  it('answers GET /approvals as { items }, and 501 without an inbox', async () => {
    const repository = new FakeRepository();
    const owner = await run(repository);
    const request = await ask(repository, owner.id, 1);

    const app = routeApp(
      createApprovalRoutes(undefined, createApprovalInbox({ repository, scope })),
    );
    const response = await send(app, 'GET', '/approvals');
    expect(response.status).toBe(200);
    expect(PendingApprovalListResponseSchema.parse(await response.json()).items).toEqual([
      { request, workflowId: owner.workflowId, projectId: owner.projectId },
    ]);

    const without = routeApp(createApprovalRoutes(undefined));
    expect((await send(without, 'GET', '/approvals')).status).toBe(501);
  });
});
