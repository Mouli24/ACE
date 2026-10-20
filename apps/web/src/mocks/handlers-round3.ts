import {
  APPROVAL_PREVIEW_MAX,
  ApprovalDecisionRequestSchema,
  CreateGuardrailPolicyRequestSchema,
  PolicyTestRequestSchema,
  RetryRequestSchema,
  UpdateGuardrailPolicyRequestSchema,
  aceError,
  agentWorkspaceOf,
  allowedRunActions,
  zeroUsage,
  type ApiError,
  type ApprovalDecision,
  type ApprovalRequest,
  type ErrorKind,
  type GuardrailCheckType,
  type Node,
  type NodeRun,
  type NodeState,
  type Part,
  type PolicyTestResponse,
  type Run,
  type RunAction,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { newId } from '../lib/ulid';
import { type MockDb } from './db';
import { testPolicy } from './guardrail-checks';
import { playFrames, playScenario } from './handlers-round2';
import { cancelPlayback, pausePlayback, resumePlayback } from './playback';
import { buildAttemptScript } from './scenarios';

/**
 * MSW handlers for the round 3 endpoints (§2.5): run controls, retries and re-runs, approvals and
 * guardrail policies. Registered ahead of the round 2 handlers, the way those are registered ahead
 * of round 1's.
 *
 * Every refusal here is the contract's own: 409 `invalid_run_state` when the run or node run is not
 * in a state for the action — `allowedRunActions` from `@ace/contracts` decides, never a second
 * table in this file (FR-CTL-006, D76) — and 409 `policy_in_use` for a policy agents still name
 * (D78).
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };
const param = (ctx: Ctx, name: string): string => String(ctx.params[name] ?? '');

function error(status: number, kind: ErrorKind, code: string, message: string, details?: unknown) {
  const body: ApiError = aceError(kind, code, message, { details, retryable: false });
  return HttpResponse.json(body, { status });
}

const notFound = (what: string) => error(404, 'workflow', 'not_found', `${what} not found.`);
const unauthorized = () => error(401, 'auth', 'unauthorized', 'Missing or invalid session token.');
const invalidRunState = (message: string) => error(409, 'workflow', 'invalid_run_state', message);

function validationFailed(details: unknown) {
  return error(400, 'invalid_config', 'validation_failed', 'Request body is invalid.', details);
}

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

async function body<T>(
  request: Request,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  fallback?: unknown,
) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    if (fallback === undefined)
      return { ok: false as const, response: validationFailed('Body is not JSON.') };
    raw = fallback;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false as const, response: validationFailed(parsed.error.issues) };
  return { ok: true as const, data: parsed.data };
}

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Shared pieces the handlers and the browser test hooks both use              */
/* -------------------------------------------------------------------------- */

interface RunEvent {
  type: string;
  payload: unknown;
}

/** Emit a run-scope frame the way a scenario frame would, with its own seq. */
function emitRun(db: MockDb, run: Run, event: RunEvent): void {
  db.emit({
    type: event.type as Parameters<MockDb['emit']>[0]['type'],
    payload: event.payload,
    scope: 'workflow',
    workflowId: run.workflowId,
  });
}

function nodeStateEvent(run: Run, nodeRun: NodeRun, status: NodeState): RunEvent {
  return {
    type: 'node.state',
    payload: {
      runId: run.id,
      nodeRunId: nodeRun.id,
      nodeId: nodeRun.nodeId,
      iteration: nodeRun.iteration,
      attempt: nodeRun.attempt,
      status,
      ...(status === 'FAILED' && nodeRun.failureReason !== undefined
        ? { failureReason: nodeRun.failureReason }
        : {}),
    },
  };
}

/** The run, put back to RUNNING because a retry or a re-run re-opened it (D81). */
function reopen(db: MockDb, run: Run): Run {
  return (
    db.updateRun(run.id, {
      status: 'RUNNING',
      allowedActions: allowedRunActions('RUNNING'),
      endedAt: undefined,
      durationMs: undefined,
      haltReason: undefined,
    }) ?? run
  );
}

const nodeOf = (run: Run, nodeId: string): Node | undefined =>
  run.snapshot.nodes.find((node) => node.id === nodeId);

/** Executable nodes reachable after this one, in snapshot order (FR-ERR-004). */
function downstreamNodes(run: Run, nodeId: string): Node[] {
  const reached = new Set<string>();
  const queue = [nodeId];
  for (const current of queue) {
    for (const edge of run.snapshot.edges) {
      if (edge.kind !== 'data' || edge.from.nodeId !== current) continue;
      if (reached.has(edge.to.nodeId)) continue;
      reached.add(edge.to.nodeId);
      queue.push(edge.to.nodeId);
    }
  }
  return run.snapshot.nodes.filter(
    (node) =>
      reached.has(node.id) &&
      (node.kind === 'agent' || node.kind === 'model' || node.kind === 'transform'),
  );
}

/** A node run that has not finished cannot be retried or re-run — there is nothing to repeat yet. */
const IN_FLIGHT: ReadonlySet<NodeState> = new Set<NodeState>([
  'IDLE',
  'READY',
  'RUNNING',
  'WAITING',
  'PAUSED',
]);

/** The parts the latest completed upstream node runs produced — what a re-run reads (FR-CTL-005). */
function latestUpstreamReads(db: MockDb, run: Run, nodeId: string): Part[] {
  const upstream = run.snapshot.edges
    .filter((edge) => edge.kind === 'data' && edge.to.nodeId === nodeId)
    .map((edge) => edge.from.nodeId);
  const reads: Part[] = [];
  for (const id of upstream) {
    const done = db
      .listNodeRuns(run.id)
      .filter((nodeRun) => nodeRun.nodeId === id && nodeRun.status === 'COMPLETED')
      .at(-1);
    for (const part of done?.output ?? []) reads.push(part);
    if (done === undefined) {
      const input = nodeOf(run, id);
      const text = (input?.config as { text?: string } | undefined)?.text;
      if (text !== undefined && text !== '') reads.push({ type: 'text', text });
    }
  }
  return reads;
}

/** Start one more attempt of a node: the record, the READY frame, then the script (D81). */
function startAttempt(
  db: MockDb,
  run: Run,
  node: Node,
  options: { attempt: number; iteration: number; reads: Part[]; downstream: readonly Node[] },
): NodeRun {
  const reopened = reopen(db, run);
  const nodeRun: NodeRun = {
    id: newId(),
    runId: run.id,
    nodeId: node.id,
    iteration: options.iteration,
    attempt: options.attempt,
    status: 'READY',
    inputEnvelopes: [],
    usage: zeroUsage(),
    verdicts: [],
    toolCalls: [],
    startedAt: now(),
  };
  db.upsertNodeRun(nodeRun);
  emitRun(db, reopened, nodeStateEvent(reopened, nodeRun, 'READY'));
  playFrames(
    db,
    reopened,
    buildAttemptScript(
      {
        run: reopened,
        workflowId: reopened.workflowId,
        nodes: reopened.snapshot.nodes,
        edges: reopened.snapshot.edges,
      },
      node,
      {
        nodeRunId: nodeRun.id,
        attempt: options.attempt,
        iteration: options.iteration,
        reads: options.reads,
        downstream: options.downstream,
      },
    ),
  );
  return nodeRun;
}

export type DecisionOutcome =
  | { ok: true; nodeRun: NodeRun }
  | { ok: false; reason: 'node_run_not_found' | 'run_not_found' | 'no_pending_approval' };

/**
 * Approve or reject what an `ask_user` check asked about (FR-GRD-013). Approve continues the node
 * from where it paused; reject ends it FAILED `GUARDRAIL_VIOLATION` — never CONTRACT_VIOLATION
 * (BR-03, D9) — and both store the decision with its time and emit `node.approval_decided`.
 */
export function decideApproval(
  db: MockDb,
  nodeRunId: string,
  decision: ApprovalDecision['decision'],
  note?: string,
  always = false,
): DecisionOutcome {
  const nodeRun = db.getNodeRun(nodeRunId);
  if (nodeRun === undefined) return { ok: false, reason: 'node_run_not_found' };
  const run = db.getRun(nodeRun.runId);
  if (run === undefined) return { ok: false, reason: 'run_not_found' };
  const request = db.pendingApprovalForNodeRun(nodeRunId);
  if (request === undefined) return { ok: false, reason: 'no_pending_approval' };

  const stored: ApprovalDecision = {
    requestId: request.id,
    decision,
    ...(note === undefined ? {} : { note }),
    decidedAt: now(),
  };
  db.resolveApproval(request.id);
  // D376: Always allow saves the card's prefix on the node, as the engine does.
  const prefix = request.command?.allowPrefix;
  if (decision === 'approve' && always && prefix !== undefined && !request.command?.denylisted) {
    const nodes = db.nodesOf(run.workflowId);
    const saved = nodes.map((node) => {
      if (node.id !== request.nodeId || node.kind !== 'agent') return node;
      const workspace = agentWorkspaceOf(node.config);
      if (workspace.allowedCommands.includes(prefix)) return node;
      return {
        ...node,
        config: {
          ...node.config,
          workspace: { ...workspace, allowedCommands: [...workspace.allowedCommands, prefix] },
        },
      };
    });
    db.commitGraph(run.workflowId, saved, db.edgesOf(run.workflowId));
  }

  const approvals = [...(nodeRun.approvals ?? []), stored];
  const decided: NodeRun =
    decision === 'approve'
      ? { ...nodeRun, status: 'RUNNING', approvals }
      : {
          ...nodeRun,
          status: 'FAILED',
          failureReason: 'GUARDRAIL_VIOLATION',
          error: {
            kind: 'guardrail',
            code: 'approval_rejected',
            message: `You rejected the ${request.checkType} check on "${request.nodeName}".`,
            retryable: false,
          },
          approvals,
          endedAt: now(),
        };
  db.upsertNodeRun(decided);
  emitRun(db, run, {
    type: 'node.approval_decided',
    payload: { runId: run.id, nodeRunId, decision: stored },
  });

  if (decision === 'approve') {
    // the held script carries on from RUNNING; with no script queued, say so ourselves
    if (!resumePlayback(run.id)) emitRun(db, run, nodeStateEvent(run, decided, 'RUNNING'));
    return { ok: true, nodeRun: decided };
  }

  cancelPlayback(run.id);
  emitRun(db, run, {
    type: 'node.error',
    payload: {
      runId: run.id,
      nodeRunId,
      nodeId: decided.nodeId,
      error: decided.error,
      failureReason: 'GUARDRAIL_VIOLATION',
    },
  });
  emitRun(db, run, nodeStateEvent(run, decided, 'FAILED'));
  const ended = now();
  db.updateRun(run.id, {
    status: 'HALTED',
    haltReason: 'failure',
    allowedActions: allowedRunActions('HALTED'),
    endedAt: ended,
    durationMs: Math.max(0, Date.parse(ended) - Date.parse(run.startedAt)),
  });
  emitRun(db, run, {
    type: 'run.completed',
    payload: { runId: run.id, status: 'HALTED', haltReason: 'failure', totals: run.totals },
  });
  return { ok: true, nodeRun: decided };
}

/**
 * Put a node run into WAITING with an approval card, without waiting for a scenario to reach one —
 * the hook a Playwright test uses to land straight on the card (FR-GRD-013).
 */
export function requireApproval(
  db: MockDb,
  nodeRunId: string,
  options: { checkType?: GuardrailCheckType; reason?: string; preview?: string } = {},
): ApprovalRequest | undefined {
  const nodeRun = db.getNodeRun(nodeRunId);
  if (nodeRun === undefined) return undefined;
  const run = db.getRun(nodeRun.runId);
  if (run === undefined) return undefined;
  const node = nodeOf(run, nodeRun.nodeId);

  const request: ApprovalRequest = {
    id: newId(),
    runId: run.id,
    nodeRunId,
    nodeId: nodeRun.nodeId,
    nodeName: node?.name ?? 'Node',
    point: 'output',
    checkType: options.checkType ?? 'pii',
    reason: options.reason ?? 'The output contains an email address.',
    preview: (options.preview ?? 'contact [email redacted] for the full report.').slice(
      0,
      APPROVAL_PREVIEW_MAX,
    ),
    requestedAt: now(),
  };
  const waiting: NodeRun = { ...nodeRun, status: 'WAITING' };
  db.upsertNodeRun(waiting);
  db.addApproval(request);
  pausePlayback(run.id);
  emitRun(db, run, nodeStateEvent(run, waiting, 'WAITING'));
  emitRun(db, run, { type: 'node.approval_required', payload: { runId: run.id, request } });
  return request;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

export function createRound3Handlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  /** A control the run's state does not allow is a 409, never a silent no-op (FR-CTL-006, D76). */
  const control =
    (action: RunAction, apply: (run: Run) => Response): ((ctx: Ctx) => Response) =>
    (ctx: Ctx) => {
      const run = db.getRun(param(ctx, 'id'));
      if (run === undefined) return notFound('Run');
      if (!allowedRunActions(run.status).includes(action)) {
        return invalidRunState(
          `A ${run.status} run cannot be ${action === 'stop' ? 'stopped' : `${action}d`}.`,
        );
      }
      return apply(run);
    };

  return [
    /* ------------------------------------------------- controls (§2.5, FR-CTL-001..004) */
    http.post(
      `${API}/runs/:id/pause`,
      guard(
        control('pause', (run) => {
          // the scheduler stops dispatching; what is already running finishes (FR-CTL-001)
          pausePlayback(run.id);
          const pausedAt = now();
          for (const nodeRun of db.listNodeRuns(run.id)) {
            if (nodeRun.status !== 'READY') continue;
            const paused: NodeRun = { ...nodeRun, status: 'PAUSED' };
            db.upsertNodeRun(paused);
            emitRun(db, run, nodeStateEvent(run, paused, 'PAUSED'));
          }
          const paused = db.updateRun(run.id, {
            status: 'PAUSED',
            pausedAt,
            allowedActions: allowedRunActions('PAUSED'),
          });
          emitRun(db, run, { type: 'run.paused', payload: { runId: run.id } });
          return HttpResponse.json(paused);
        }),
      ),
    ),

    http.post(
      `${API}/runs/:id/resume`,
      guard(
        control('resume', (run) => {
          for (const nodeRun of db.listNodeRuns(run.id)) {
            if (nodeRun.status !== 'PAUSED') continue;
            const ready: NodeRun = { ...nodeRun, status: 'READY' };
            db.upsertNodeRun(ready);
            emitRun(db, run, nodeStateEvent(run, ready, 'READY'));
          }
          const resumed = db.updateRun(run.id, {
            status: 'RUNNING',
            pausedAt: undefined,
            allowedActions: allowedRunActions('RUNNING'),
          });
          emitRun(db, run, { type: 'run.resumed', payload: { runId: run.id } });
          resumePlayback(run.id);
          return HttpResponse.json(resumed);
        }),
      ),
    ),

    http.post(
      `${API}/runs/:id/stop`,
      guard(
        control('stop', (run) => {
          cancelPlayback(run.id);
          // a stop is not a failure: no failure reason, no error (FR-ERR-007, TC-ERR-008)
          for (const nodeRun of db.listNodeRuns(run.id)) {
            if (!['READY', 'RUNNING', 'PAUSED', 'WAITING'].includes(nodeRun.status)) continue;
            const stopped: NodeRun = { ...nodeRun, status: 'STOPPED', endedAt: now() };
            db.upsertNodeRun(stopped);
            emitRun(db, run, nodeStateEvent(run, stopped, 'STOPPED'));
          }
          for (const request of db.pendingApprovals(run.id)) db.resolveApproval(request.id);
          const endedAt = now();
          const stopped = db.updateRun(run.id, {
            status: 'HALTED',
            haltReason: 'stopped',
            pausedAt: undefined,
            allowedActions: allowedRunActions('HALTED'),
            endedAt,
            durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
          });
          emitRun(db, run, {
            type: 'run.completed',
            payload: {
              runId: run.id,
              status: 'HALTED',
              haltReason: 'stopped',
              totals: stopped?.totals ?? run.totals,
            },
          });
          return HttpResponse.json(stopped);
        }),
      ),
    ),

    http.post(
      `${API}/runs/:id/restart`,
      guard(
        control('restart', (run) => {
          // the same snapshot and the same inputs, as a new run (FR-CTL-004, BR-04)
          const restarted: Run = {
            id: newId(),
            workflowId: run.workflowId,
            projectId: run.projectId,
            status: 'RUNNING',
            snapshot: run.snapshot,
            inputs: run.inputs,
            preflightIssues: [],
            totals: zeroUsage(),
            startedAt: now(),
            allowedActions: allowedRunActions('RUNNING'),
            restartedFromRunId: run.id,
          };
          db.addRun(restarted);
          playScenario(db, restarted);
          return HttpResponse.json(restarted, { status: 201 });
        }),
      ),
    ),

    /* ------------------------------------------------- retry and re-run (§2.5, FR-ERR-003/004) */
    http.post(
      `${API}/node-runs/:id/retry`,
      guard(async (ctx) => {
        const previous = db.getNodeRun(param(ctx, 'id'));
        if (previous === undefined) return notFound('Node run');
        const run = db.getRun(previous.runId);
        if (run === undefined) return notFound('Run');
        const parsed = await body(ctx.request, RetryRequestSchema, { withDownstream: false });
        if (!parsed.ok) return parsed.response;
        if (IN_FLIGHT.has(previous.status)) {
          return invalidRunState(`A ${previous.status} node run has nothing to retry yet.`);
        }
        const node = nodeOf(run, previous.nodeId);
        if (node === undefined) return notFound('Node');

        const nodeRun = startAttempt(db, run, node, {
          // the same inputs as the attempt before it (FR-ERR-003)
          attempt: previous.attempt + 1,
          iteration: previous.iteration,
          reads: previous.inputEnvelopes.flatMap((envelope) => envelope.reads),
          downstream: parsed.data.withDownstream ? downstreamNodes(run, node.id) : [],
        });
        return HttpResponse.json(nodeRun, { status: 201 });
      }),
    ),

    http.post(
      `${API}/runs/:id/nodes/:nodeId/rerun`,
      guard((ctx) => {
        const run = db.getRun(param(ctx, 'id'));
        if (run === undefined) return notFound('Run');
        const node = nodeOf(run, param(ctx, 'nodeId'));
        if (node === undefined) return notFound('Node');
        const previous = db
          .listNodeRuns(run.id)
          .filter((nodeRun) => nodeRun.nodeId === node.id)
          .at(-1);
        if (previous !== undefined && IN_FLIGHT.has(previous.status)) {
          return invalidRunState(`"${node.name}" is still ${previous.status}.`);
        }

        // that node alone, on the latest upstream outputs (FR-CTL-005)
        const nodeRun = startAttempt(db, run, node, {
          attempt: (previous?.attempt ?? 0) + 1,
          iteration: previous?.iteration ?? 1,
          reads: latestUpstreamReads(db, run, node.id),
          downstream: [],
        });
        return HttpResponse.json(nodeRun, { status: 201 });
      }),
    ),

    /* ------------------------------------------------- approvals (§2.5, FR-GRD-013) */
    http.get(
      `${API}/runs/:id/approvals`,
      guard((ctx) => {
        const run = db.getRun(param(ctx, 'id'));
        if (run === undefined) return notFound('Run');
        // a bare array, as §2.5 writes it (D78)
        return HttpResponse.json(db.pendingApprovals(run.id));
      }),
    ),

    http.post(
      `${API}/node-runs/:id/approve`,
      guard(async (ctx) => decide(db, ctx, 'approve')),
    ),

    http.post(
      `${API}/node-runs/:id/reject`,
      guard(async (ctx) => decide(db, ctx, 'reject')),
    ),

    /* ------------------------------------------------- guardrail policies (§2.5, FR-GRD-001) */
    http.get(
      `${API}/guardrail-policies`,
      guard((ctx) => {
        const projectId = new URL(ctx.request.url).searchParams.get('projectId');
        return HttpResponse.json({ items: db.listPolicies(projectId ?? undefined) });
      }),
    ),

    http.post(
      `${API}/guardrail-policies`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateGuardrailPolicyRequestSchema);
        if (!parsed.ok) return parsed.response;
        if (db.getProject(parsed.data.projectId) === undefined) return notFound('Project');
        return HttpResponse.json(db.createPolicy(parsed.data), { status: 201 });
      }),
    ),

    http.get(
      `${API}/guardrail-policies/:id`,
      guard((ctx) => {
        const policy = db.getPolicy(param(ctx, 'id'));
        return policy ? HttpResponse.json(policy) : notFound('Guardrail policy');
      }),
    ),

    http.patch(
      `${API}/guardrail-policies/:id`,
      guard(async (ctx) => {
        if (db.getPolicy(param(ctx, 'id')) === undefined) return notFound('Guardrail policy');
        const parsed = await body(ctx.request, UpdateGuardrailPolicyRequestSchema);
        if (!parsed.ok) return parsed.response;
        // a PATCH writes version + 1; it never edits a version in place (FR-GRD-001)
        const policy = db.patchPolicy(param(ctx, 'id'), parsed.data);
        return policy ? HttpResponse.json(policy) : notFound('Guardrail policy');
      }),
    ),

    http.delete(
      `${API}/guardrail-policies/:id`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (db.getPolicy(id) === undefined) return notFound('Guardrail policy');
        const confirm = new URL(ctx.request.url).searchParams.get('confirm') === 'true';
        const nodeIds = db.nodesUsingPolicy(id);
        if (nodeIds.length > 0 && !confirm) {
          return error(
            409,
            'workflow',
            'policy_in_use',
            `${nodeIds.length} node${nodeIds.length === 1 ? ' still uses' : 's still use'} this policy.`,
            { nodeIds },
          );
        }
        db.deletePolicy(id);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.post(
      `${API}/guardrail-policies/:id/test`,
      guard(async (ctx) => {
        const policy = db.getPolicy(param(ctx, 'id'));
        if (policy === undefined) return notFound('Guardrail policy');
        const parsed = await body(ctx.request, PolicyTestRequestSchema);
        if (!parsed.ok) return parsed.response;
        const response: PolicyTestResponse = {
          verdicts: testPolicy(policy.checks, parsed.data.point, parsed.data.text),
        };
        return HttpResponse.json(response);
      }),
    ),

    http.post(
      `${API}/guardrail-policies/:id/set-default`,
      guard((ctx) => {
        const policy = db.setProjectDefaultPolicy(param(ctx, 'id'));
        return policy ? HttpResponse.json(policy) : notFound('Guardrail policy');
      }),
    ),
  ];
}

/** `approve` and `reject` differ by one word, so they share everything but that word. */
async function decide(
  db: MockDb,
  ctx: Ctx,
  decision: ApprovalDecision['decision'],
): Promise<Response> {
  const parsed = await body(ctx.request, ApprovalDecisionRequestSchema, {});
  if (!parsed.ok) return parsed.response;
  const outcome = decideApproval(
    db,
    param(ctx, 'id'),
    decision,
    parsed.data.note,
    parsed.data.always === true,
  );
  if (outcome.ok) return HttpResponse.json(outcome.nodeRun);
  if (outcome.reason === 'no_pending_approval') {
    return invalidRunState('That approval has already been decided.');
  }
  return notFound(outcome.reason === 'run_not_found' ? 'Run' : 'Node run');
}
