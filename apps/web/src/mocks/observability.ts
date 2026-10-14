import {
  ERROR_KINDS,
  TRACE_ENTRY_KIND_BY_EVENT_TYPE,
  type ApprovalDecision,
  type ApprovalRequest,
  type ErrorKind,
  type HealthMetrics,
  type LatencyPercentiles,
  type Message,
  type NodeRun,
  type Run,
  type ToolCall,
  type TraceEntry,
  type UsageBucket,
  type UsageGroupBy,
  type UsageQuery,
  type UsageResponse,
  type Verdict,
} from '@ace/contracts';

import type { MockDb, MockEvent } from './db';

/**
 * The round 5 read models over what the mock engine already records (§2.6, D234): usage folds node
 * runs, the trace folds the event log, and the health metrics count both. Nothing here is stored.
 */

const round6 = (value: number): number => Number(value.toFixed(6));

/* -------------------------------------------------------------------------- */
/* Usage (FR-OBS-002, FR-OBS-004, D234)                                        */
/* -------------------------------------------------------------------------- */

/** What one node run is keyed by for one grouping (D234's key values). */
function keyValue(by: UsageGroupBy, nodeRun: NodeRun, run: Run | undefined): string {
  switch (by) {
    case 'provider':
      return nodeRun.modelUsed?.providerId ?? '';
    case 'model':
      return nodeRun.modelUsed?.modelId ?? '';
    case 'day':
      return (nodeRun.startedAt ?? '').slice(0, 10);
    case 'workflow':
      return run?.workflowId ?? '';
  }
}

/**
 * `GET /usage` (D234): only node runs that called a model, `from` inclusive and `to` exclusive
 * against the node run's start, `runs` the distinct runs, buckets ordered by key grouping by
 * grouping, and `totals` the exact sum of the buckets.
 */
export function buildUsage(db: MockDb, query: UsageQuery): UsageResponse {
  const runs = new Map(db.allRuns().map((run) => [run.id, run]));
  const from = query.from === undefined ? undefined : Date.parse(query.from);
  const to = query.to === undefined ? undefined : Date.parse(query.to);

  const buckets = new Map<string, { bucket: UsageBucket; runIds: Set<string>; parts: string[] }>();
  for (const nodeRun of db.allNodeRuns()) {
    if (nodeRun.modelUsed === undefined || nodeRun.startedAt === undefined) continue;
    const started = Date.parse(nodeRun.startedAt);
    if (from !== undefined && started < from) continue;
    if (to !== undefined && started >= to) continue;

    const run = runs.get(nodeRun.runId);
    const parts = query.groupBy.map((by) => keyValue(by, nodeRun, run));
    const id = JSON.stringify(parts);
    const entry = buckets.get(id) ?? {
      bucket: {
        key: Object.fromEntries(query.groupBy.map((by, i) => [by, parts[i]!])),
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        runs: 0,
      },
      runIds: new Set<string>(),
      parts,
    };
    entry.bucket.tokensIn += nodeRun.usage.tokensIn;
    entry.bucket.tokensOut += nodeRun.usage.tokensOut;
    entry.bucket.costUsd = round6(entry.bucket.costUsd + nodeRun.usage.costUsd);
    entry.runIds.add(nodeRun.runId);
    entry.bucket.runs = entry.runIds.size;
    buckets.set(id, entry);
  }

  const ordered = [...buckets.values()]
    .sort((a, b) => {
      for (let i = 0; i < a.parts.length; i += 1) {
        const order = a.parts[i]!.localeCompare(b.parts[i]!);
        if (order !== 0) return order;
      }
      return 0;
    })
    .map((entry) => entry.bucket);

  return {
    buckets: ordered,
    totals: {
      tokensIn: ordered.reduce((sum, bucket) => sum + bucket.tokensIn, 0),
      tokensOut: ordered.reduce((sum, bucket) => sum + bucket.tokensOut, 0),
      costUsd: round6(ordered.reduce((sum, bucket) => sum + bucket.costUsd, 0)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Trace (FR-OBS-001)                                                          */
/* -------------------------------------------------------------------------- */

type TracedType = keyof typeof TRACE_ENTRY_KIND_BY_EVENT_TYPE;

const isTraced = (type: string): type is TracedType => type in TRACE_ENTRY_KIND_BY_EVENT_TYPE;

/** Does this persisted event belong to this run's log? */
function ofRun(event: MockEvent, runId: string): boolean {
  const payload = event.payload as {
    runId?: string;
    run?: { id?: string };
    message?: Message;
  };
  return payload.runId === runId || payload.run?.id === runId || payload.message?.runId === runId;
}

interface TracePayload {
  nodeId?: string;
  nodeRunId?: string;
  status?: string;
  failureReason?: string;
  iteration?: number;
  stop?: string;
  edgeId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  targetNodeId?: string;
  request?: ApprovalRequest;
  decision?: ApprovalDecision;
  verdict?: Verdict;
  toolCall?: ToolCall;
  message?: Message;
  haltReason?: string;
}

const TERMINAL_NODE_STATES = new Set(['COMPLETED', 'FAILED', 'STOPPED']);

/**
 * `GET /runs/:id/trace`: one entry per persisted event of the run, in `seq` order, filed under the
 * contract's kind for its type — so the trace matches the event log exactly (FR-OBS-001, D234).
 */
export function buildTrace(db: MockDb, run: Run): TraceEntry[] {
  const names = new Map(run.snapshot.nodes.map((node) => [node.id, node.name]));
  const nodeRuns = new Map(db.listNodeRuns(run.id).map((nodeRun) => [nodeRun.id, nodeRun]));
  const nameOf = (nodeId: string | undefined): string =>
    nodeId === undefined ? 'node' : (names.get(nodeId) ?? 'node');

  return db.events
    .filter((event) => event.seq !== undefined && isTraced(event.type) && ofRun(event, run.id))
    .sort((a, b) => a.seq! - b.seq!)
    .map((event): TraceEntry => {
      const type = event.type as TracedType;
      const payload = event.payload as TracePayload;
      const nodeRunId =
        payload.nodeRunId ??
        payload.request?.nodeRunId ??
        payload.toolCall?.nodeRunId ??
        payload.verdict?.nodeRunId;
      const nodeId =
        payload.nodeId ??
        payload.request?.nodeId ??
        payload.targetNodeId ??
        (nodeRunId === undefined ? undefined : nodeRuns.get(nodeRunId)?.nodeId) ??
        payload.message?.nodeId;
      const name = nameOf(nodeId);

      let label: string;
      let durationMs: number | undefined;
      switch (type) {
        case 'run.started':
          label = 'Run started';
          break;
        case 'run.completed':
          label = `Run ${payload.status ?? 'ended'}${payload.haltReason ? ` (${payload.haltReason})` : ''}`;
          durationMs = run.durationMs;
          break;
        case 'node.state':
          label = `${name} → ${payload.status ?? '?'}${payload.failureReason ? ` (${payload.failureReason})` : ''}`;
          if (payload.status !== undefined && TERMINAL_NODE_STATES.has(payload.status)) {
            durationMs = nodeRunId === undefined ? undefined : nodeRuns.get(nodeRunId)?.durationMs;
          }
          break;
        case 'node.output':
          label = `${name} output`;
          break;
        case 'node.error':
          label = `${name} error`;
          break;
        case 'edge.transfer':
          label = `${nameOf(payload.fromNodeId)} → ${nameOf(payload.toNodeId)}`;
          break;
        case 'usage.updated':
          label = 'Usage updated';
          break;
        case 'run.paused':
          label = 'Run paused';
          break;
        case 'run.resumed':
          label = 'Run resumed';
          break;
        case 'node.approval_required':
          label = `Approval requested: ${name}`;
          break;
        case 'node.approval_decided':
          label = `Approval ${payload.decision?.decision === 'reject' ? 'rejected' : 'approved'}: ${name}`;
          break;
        case 'guardrail.verdict':
          label =
            `${payload.verdict?.checkType ?? 'check'} ${payload.verdict?.action ?? ''} at ${payload.verdict?.point ?? '?'}`.replace(
              /\s+/g,
              ' ',
            );
          break;
        case 'loop.iteration':
          label =
            payload.stop === undefined
              ? `Loop iteration ${payload.iteration ?? '?'}: ${name}`
              : `Loop stopped after ${payload.iteration ?? '?'} (${payload.stop})`;
          break;
        case 'tool.call':
          label = `${payload.toolCall?.toolName ?? 'tool'} (${payload.toolCall?.status ?? '?'})`;
          durationMs = payload.toolCall?.durationMs;
          break;
        case 'message.created':
          label = `Message: ${payload.message?.type ?? 'message'}`;
          break;
        /* Domain (D303) and Debate (D352): the mock engine emits none of these yet; a run that has one reads by type. */
        case 'human.message':
        case 'instruction.state':
        case 'envelope.sent':
        case 'envelope.routed':
        case 'node.interrupted':
        case 'run.token_budget':
        case 'run.config':
        case 'run.blocked':
        case 'run.parked':
        case 'debate.started':
        case 'debate.round_started':
        case 'debate.turn_started':
        case 'debate.turn_completed':
        case 'debate.turn_failed':
        case 'debate.turn_violation':
        case 'debate.instruction_delivered':
        case 'debate.round_completed':
        case 'debate.control':
        case 'debate.stopped':
        case 'debate.verdict':
        case 'debate.failed':
          label = type;
          break;
      }

      return {
        seq: event.seq!,
        at: event.at ?? run.startedAt,
        kind: TRACE_ENTRY_KIND_BY_EVENT_TYPE[type],
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(nodeRunId === undefined ? {} : { nodeRunId }),
        label,
        detail: event.payload,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Health (FR-OBS-007)                                                         */
/* -------------------------------------------------------------------------- */

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;

/** `GET /metrics/health`: every error kind named, latency by provider id, verdicts by check type. */
export function buildHealth(db: MockDb): HealthMetrics {
  const runs = db.allRuns();
  const nodeRuns = db.allNodeRuns();

  const nodeFailuresByKind = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])) as Record<
    ErrorKind,
    number
  >;
  const latencies = new Map<string, number[]>();
  const guardrailVerdictsByType: Record<string, number> = {};
  for (const nodeRun of nodeRuns) {
    if (nodeRun.status === 'FAILED' && nodeRun.error !== undefined) {
      nodeFailuresByKind[nodeRun.error.kind] += 1;
    }
    if (nodeRun.modelUsed !== undefined && nodeRun.durationMs !== undefined) {
      const list = latencies.get(nodeRun.modelUsed.providerId) ?? [];
      list.push(nodeRun.durationMs);
      latencies.set(nodeRun.modelUsed.providerId, list);
    }
    for (const verdict of nodeRun.verdicts) {
      guardrailVerdictsByType[verdict.checkType] =
        (guardrailVerdictsByType[verdict.checkType] ?? 0) + 1;
    }
  }

  const providerLatencyMs: Record<string, LatencyPercentiles> = {};
  for (const [providerId, list] of latencies) {
    const sorted = [...list].sort((a, b) => a - b);
    providerLatencyMs[providerId] = { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
  }

  const count = (status: Run['status']) => runs.filter((run) => run.status === status).length;
  const since = runs.map((run) => run.startedAt).sort()[0] ?? new Date().toISOString();

  return {
    runs: {
      started: runs.length,
      completed: count('COMPLETE'),
      halted: count('HALTED'),
      blocked: count('BLOCKED'),
    },
    nodeFailuresByKind,
    providerLatencyMs,
    guardrailVerdictsByType,
    since,
  };
}
