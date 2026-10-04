import {
  GuardrailVerdictPayloadSchema,
  LoopIterationPayloadSchema,
  NodeApprovalDecidedPayloadSchema,
  NodeApprovalRequiredPayloadSchema,
  NodeErrorPayloadSchema,
  NodeOutputPayloadSchema,
  NodeStatePayloadSchema,
  PERSISTED_RUN_EVENT_TYPES,
  TRACE_ENTRY_KIND_BY_EVENT_TYPE,
  ToolCallPayloadSchema,
  type Id,
  type PersistedRunEventType,
  type TraceEntry,
} from '@ace/contracts';

import { notFound } from '../gateway/errors.js';
import type { EngineEvent, Repository, Scope } from '../ports/index.js';

/**
 * The run trace (round 5 §2.6, FR-OBS-001, F9): a fold of the run's event log, one entry per
 * persisted run event, `seq` the event's own, so the trace reads in exactly the order
 * `GET /runs/:id/events` does (TC-OBS-001). Nothing is stored; `node.token` is never persisted and
 * so never appears, and engine-family events belong to no run.
 */

const PERSISTED = new Set<string>(PERSISTED_RUN_EVENT_TYPES);

const isPersistedRunEvent = (type: string): type is PersistedRunEventType => PERSISTED.has(type);

/** A node run has finished once it reaches one of these. */
const TERMINAL_NODE_STATES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'STOPPED',
  'BLOCKED',
  'FAILED',
]);

type Fields = Partial<Pick<TraceEntry, 'nodeId' | 'nodeRunId' | 'durationMs'>> & {
  label?: string;
};

/** What an event adds to its entry beyond the kind: the node it concerns, its label, its span. */
function describeEvent(
  type: PersistedRunEventType,
  payload: unknown,
  at: string,
  startedAt: ReadonlyMap<string, number>,
): Fields {
  switch (type) {
    case 'node.state': {
      const parsed = NodeStatePayloadSchema.safeParse(payload);
      if (!parsed.success) return {};
      const state = parsed.data;
      const began = startedAt.get(state.nodeRunId);
      const duration =
        TERMINAL_NODE_STATES.has(state.status) && began !== undefined
          ? Math.max(0, Date.parse(at) - began)
          : undefined;
      return {
        nodeId: state.nodeId,
        nodeRunId: state.nodeRunId,
        label: `${state.nodeId} → ${state.status}`,
        ...(duration === undefined ? {} : { durationMs: duration }),
      };
    }
    case 'node.output': {
      const parsed = NodeOutputPayloadSchema.safeParse(payload);
      return parsed.success ? { nodeId: parsed.data.nodeId, nodeRunId: parsed.data.nodeRunId } : {};
    }
    case 'node.error': {
      const parsed = NodeErrorPayloadSchema.safeParse(payload);
      return parsed.success ? { nodeId: parsed.data.nodeId, nodeRunId: parsed.data.nodeRunId } : {};
    }
    case 'tool.call': {
      const parsed = ToolCallPayloadSchema.safeParse(payload);
      if (!parsed.success) return {};
      const { toolCall } = parsed.data;
      return {
        nodeRunId: parsed.data.nodeRunId,
        label: `${toolCall.toolName} (${toolCall.status})`,
        durationMs: toolCall.durationMs,
      };
    }
    case 'guardrail.verdict': {
      const parsed = GuardrailVerdictPayloadSchema.safeParse(payload);
      if (!parsed.success) return {};
      const { verdict } = parsed.data;
      return {
        nodeRunId: parsed.data.nodeRunId,
        label: `${verdict.checkType} at ${verdict.point}: ${verdict.action}`,
      };
    }
    case 'node.approval_required': {
      const parsed = NodeApprovalRequiredPayloadSchema.safeParse(payload);
      return {
        label: 'approval requested',
        ...(parsed.success
          ? { nodeId: parsed.data.request.nodeId, nodeRunId: parsed.data.request.nodeRunId }
          : {}),
      };
    }
    case 'node.approval_decided': {
      const parsed = NodeApprovalDecidedPayloadSchema.safeParse(payload);
      if (!parsed.success) return { label: 'approval decided' };
      return {
        nodeRunId: parsed.data.nodeRunId,
        label: `approval ${parsed.data.decision.decision}`,
      };
    }
    case 'loop.iteration': {
      const parsed = LoopIterationPayloadSchema.safeParse(payload);
      if (!parsed.success) return {};
      const loop = parsed.data;
      return {
        nodeId: loop.targetNodeId,
        label:
          loop.stop === undefined
            ? `loop iteration ${loop.iteration}`
            : `loop stopped: ${loop.stop}`,
      };
    }
    default:
      return {};
  }
}

/**
 * Folds a run's events into its trace. Events that are not persisted run events are skipped, so
 * handing it a mixed log is safe; the result is in ascending `seq`.
 */
export function foldTrace(events: readonly EngineEvent[]): TraceEntry[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const startedAt = new Map<string, number>();
  const trace: TraceEntry[] = [];

  for (const event of ordered) {
    const type = event.type;
    if (!isPersistedRunEvent(type)) continue;

    const { label, ...rest } = describeEvent(type, event.payload, event.createdAt, startedAt);

    // A node run's span starts at its latest RUNNING, so a retry measures its own attempt.
    if (type === 'node.state') {
      const state = NodeStatePayloadSchema.safeParse(event.payload);
      if (state.success && state.data.status === 'RUNNING') {
        startedAt.set(state.data.nodeRunId, Date.parse(event.createdAt));
      }
    }

    trace.push({
      seq: event.seq,
      at: event.createdAt,
      kind: TRACE_ENTRY_KIND_BY_EVENT_TYPE[type],
      ...rest,
      label: label ?? type,
      detail: event.payload,
    });
  }

  return trace;
}

export interface TraceService {
  /** 404 for an unknown run. */
  trace(runId: Id): Promise<TraceEntry[]>;
}

export function createTraceService(deps: {
  repository: Pick<Repository, 'runs' | 'events'>;
  scope: Scope;
}): TraceService {
  return {
    async trace(runId) {
      const run = await deps.repository.runs.get(deps.scope, runId);
      if (run === null) throw notFound(`run ${runId}`);

      // Scoped to this run in the query, as `GET /runs/:id/events` is (FR-EXE-014).
      const events = await deps.repository.events.listAfter(deps.scope, 0, { runIds: [runId] });
      return foldTrace(events);
    },
  };
}
