import type { ApprovalRequest, NodeRun, Run } from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * A run WAITING on one approval card, stored straight into the mock engine (ACE parity P1, D270) —
 * what the approvals inbox lists. Optionally owned by a task, through a work execution of the run,
 * the way the mock tasks engine links them. Answers the request and the ids around it.
 */
export function seedPendingApproval(
  db: MockDb,
  options: {
    projectId?: string;
    workflowId?: string;
    taskId?: string;
    nodeName?: string;
    reason?: string;
    preview?: string;
    requestedAt?: string;
  } = {},
): { request: ApprovalRequest; run: Run; nodeRun: NodeRun } {
  const projectId = options.projectId ?? db.createProject({ name: 'Inbox' }).id;
  const workflowId = options.workflowId ?? db.createWorkflow(projectId, 'Team').id;
  const at = options.requestedAt ?? new Date().toISOString();

  const run: Run = {
    id: newId(),
    workflowId,
    projectId,
    status: 'RUNNING',
    snapshot: { version: 1, nodes: [], edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: at,
  };
  db.addRun(run);
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
    startedAt: at,
  };
  db.upsertNodeRun(nodeRun);
  const request: ApprovalRequest = {
    id: newId(),
    runId: run.id,
    nodeRunId: nodeRun.id,
    nodeId: nodeRun.nodeId,
    nodeName: options.nodeName ?? 'Builder',
    point: 'tool',
    checkType: 'destructive_action',
    reason: options.reason ?? 'run_command is a destructive tool.',
    preview: options.preview ?? 'run_command {"command":"rm -rf build"}',
    requestedAt: at,
  };
  db.addApproval(request);

  if (options.taskId !== undefined) {
    db.putTaskExecution({
      id: newId(),
      taskId: options.taskId,
      kind: 'work',
      sequence: db.taskExecutionsOf(options.taskId).length + 1,
      workflowId,
      runId: run.id,
      status: 'running',
      request: 'Work on it.',
      startedAt: at,
    });
  }
  return { request, run, nodeRun };
}
