import { type Id, type LoopStopReason, type RunEvent, type Timestamp } from '@ace/contracts';
import {
  NODE_STATE_META,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { GUARDRAIL_ACTION_LABEL } from '@ace/ui';
import { useMemo, useState } from 'react';

import { haltReasonText, money } from '../runs/controls/HaltReason';

/**
 * The bottom pane's "Events" tab (round 3 §5 item 7, NFR-OBS-01): the run's events in the order the
 * engine recorded them — state changes, guardrail verdicts, approvals, loop iterations and halts —
 * with a filter by node.
 *
 * This is the *event* view, not the chat Timeline (round 4). It renders the folded socket buffer it
 * is handed, so it stays a pure view over the engine's truth: `seq` is monotonic and append-only
 * (BR-04), so sorting by it *is* time order, even where a row carries no clock time.
 *
 * Nothing here interprets a payload beyond wording it. In particular a verdict's `redactedTypes`
 * are printed as type names because that is all a verdict carries — never a value (FR-GRD-014).
 */

/** Every persisted run frame: `node.token` is transient, carries no `seq`, and is not an event. */
export type PersistedRunEvent = Extract<RunEvent, { seq: number }>;

/** One row: the frame, plus the time the engine stamped it with where the caller knows it. */
export interface RunEventEntry {
  event: PersistedRunEvent;
  /** `GET /runs/:id/events` rows carry `at`; live socket frames do not. */
  at?: Timestamp;
}

export interface EventsTabProps {
  entries: readonly RunEventEntry[];
  /** The run snapshot's nodes, so an event can name a node instead of an id. */
  nodes?: readonly { id: Id; name: string }[];
  /** Select the node on the Canvas from a row. */
  onShowNode?: (nodeId: Id) => void;
}

/** Why a loop ended, in words (§2.4, FR-PAR-003..006, FR-GRD-009). */
const LOOP_STOP_LABEL: Readonly<Record<LoopStopReason, string>> = {
  exit_condition: 'the exit condition was met',
  max_iterations: 'it reached the maximum iterations',
  repeated_output: 'the output repeated',
};

/** Which nodes an event is about — the filter and the row's link both use it. */
export function eventNodeIds(
  event: PersistedRunEvent,
  nodeIdByNodeRunId: ReadonlyMap<Id, Id>,
): Id[] {
  switch (event.type) {
    case 'node.state':
    case 'node.output':
    case 'node.error':
      return [event.payload.nodeId];
    case 'node.approval_required':
      return [event.payload.request.nodeId];
    case 'node.approval_decided':
    case 'guardrail.verdict': {
      const nodeId = nodeIdByNodeRunId.get(event.payload.nodeRunId);
      return nodeId === undefined ? [] : [nodeId];
    }
    case 'edge.transfer':
      return [event.payload.fromNodeId, event.payload.toNodeId];
    case 'loop.iteration':
      return [event.payload.targetNodeId];
    case 'run.started':
    case 'run.completed':
    case 'run.paused':
    case 'run.resumed':
    case 'usage.updated':
      return [];
  }
}

/** One line per event, in words. The type is shown beside it, so this never repeats the type. */
export function describeEvent(event: PersistedRunEvent, nameOf: (nodeId: Id) => string): string {
  switch (event.type) {
    case 'run.started':
      return 'run started';
    case 'run.completed': {
      if (event.payload.status === 'COMPLETE') return 'run complete';
      if (event.payload.status === 'BLOCKED') return 'run blocked before anything ran';
      // A halt normally names its reason; nothing is invented for one that does not.
      return event.payload.haltReason === undefined
        ? 'run halted'
        : `run halted — ${haltReasonText(event.payload.haltReason, event.payload.budgetHalt)}`;
    }
    case 'run.paused':
      return 'run paused — nodes already running finish, nothing new starts';
    case 'run.resumed':
      return 'run resumed';
    case 'node.state': {
      const state = NODE_STATE_META[event.payload.status].label;
      const reason =
        event.payload.failureReason === undefined ? '' : ` (${event.payload.failureReason})`;
      return `${nameOf(event.payload.nodeId)} → ${state}${reason}`;
    }
    case 'node.output':
      return `${nameOf(event.payload.nodeId)} produced its output · ${event.payload.usage.tokensIn}↓ ${event.payload.usage.tokensOut}↑`;
    case 'node.error':
      return `${nameOf(event.payload.nodeId)} failed — ${event.payload.error.kind}: ${event.payload.error.message}`;
    case 'edge.transfer':
      return `${nameOf(event.payload.fromNodeId)} → ${nameOf(event.payload.toNodeId)}: ${event.payload.summary}`;
    case 'usage.updated':
      return `run cost so far ${money(event.payload.totals.costUsd)}`;
    case 'node.approval_required': {
      const { request } = event.payload;
      return `${request.nodeName} is waiting for you — ${request.checkType} at ${request.point}: ${request.reason}`;
    }
    case 'node.approval_decided': {
      const { decision } = event.payload;
      const word = decision.decision === 'approve' ? 'approved' : 'rejected';
      return `approval ${word}${decision.note ? ` — ${decision.note}` : ''}`;
    }
    case 'guardrail.verdict': {
      const { verdict } = event.payload;
      const redacted =
        verdict.redactedTypes === undefined || verdict.redactedTypes.length === 0
          ? ''
          : ` · redacted: ${verdict.redactedTypes.join(', ')}`;
      return `${verdict.checkType} at ${verdict.point} — ${GUARDRAIL_ACTION_LABEL[verdict.action]}, ${
        verdict.passed ? 'passed' : 'not passed'
      }: ${verdict.reason}${redacted}`;
    }
    case 'loop.iteration': {
      const target = nameOf(event.payload.targetNodeId);
      return event.payload.stop === undefined
        ? `loop iteration ${event.payload.iteration} of ${target}`
        : `loop stopped after iteration ${event.payload.iteration} of ${target} — ${LOOP_STOP_LABEL[event.payload.stop]}`;
    }
  }
}

const ALL_NODES = 'all';

export function EventsTab({ entries, nodes = [], onShowNode }: EventsTabProps) {
  const [nodeFilter, setNodeFilter] = useState<string>(ALL_NODES);

  const nameOf = (nodeId: Id): string =>
    nodes.find((node) => node.id === nodeId)?.name ?? 'unknown node';

  /*
   * `guardrail.verdict` and `node.approval_decided` name a node run, not a node, so the node they
   * belong to comes from the `node.state` events in the same list — which is where a node run is
   * introduced. No extra wiring, and nothing invented when a state event has not arrived.
   */
  const nodeIdByNodeRunId = useMemo(() => {
    const map = new Map<Id, Id>();
    for (const { event } of entries) {
      if (
        event.type === 'node.state' ||
        event.type === 'node.output' ||
        event.type === 'node.error'
      ) {
        map.set(event.payload.nodeRunId, event.payload.nodeId);
      }
      if (event.type === 'node.approval_required') {
        map.set(event.payload.request.nodeRunId, event.payload.request.nodeId);
      }
    }
    return map;
  }, [entries]);

  /** Time order: `seq` is monotonic and append-only, so it is the order things happened (BR-04). */
  const ordered = useMemo(() => [...entries].sort((a, b) => a.event.seq - b.event.seq), [entries]);

  /** The nodes this run has events for, in the order they first appear. */
  const filterNodes = useMemo(() => {
    const ids: Id[] = [];
    for (const { event } of ordered) {
      for (const nodeId of eventNodeIds(event, nodeIdByNodeRunId)) {
        if (!ids.includes(nodeId)) ids.push(nodeId);
      }
    }
    return ids;
  }, [ordered, nodeIdByNodeRunId]);

  const rows =
    nodeFilter === ALL_NODES
      ? ordered
      : ordered.filter((entry) =>
          eventNodeIds(entry.event, nodeIdByNodeRunId).includes(nodeFilter),
        );

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="events-tab">
      <div className="flex items-center gap-2">
        <Select value={nodeFilter} onValueChange={setNodeFilter}>
          <SelectTrigger className="w-56" aria-label="Filter by node">
            <SelectValue placeholder="all nodes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_NODES}>all nodes</SelectItem>
            {filterNodes.map((nodeId) => (
              <SelectItem key={nodeId} value={nodeId}>
                {nameOf(nodeId)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="font-machine text-xs text-fg-muted" data-testid="events-count">
          {rows.length} event{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="font-human text-sm text-fg-muted">
          {ordered.length === 0
            ? 'No events yet. Start a run and everything it does appears here.'
            : 'No events for this node.'}
        </p>
      ) : (
        <ol className="flex flex-col gap-1" data-testid="events-list">
          {rows.map((entry) => {
            const nodeIds = eventNodeIds(entry.event, nodeIdByNodeRunId);
            const first = nodeIds[0];
            return (
              <li
                key={entry.event.seq}
                data-testid={`event-${entry.event.seq}`}
                data-type={entry.event.type}
                {...(first === undefined ? {} : { 'data-node-id': first })}
                className="flex items-baseline gap-2 text-sm"
              >
                <span className="font-machine text-[10px] text-fg-muted">#{entry.event.seq}</span>
                {entry.at !== undefined && (
                  <span className="font-machine text-[10px] text-fg-muted">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                )}
                <span className="font-machine text-[10px] text-fg-muted">{entry.event.type}</span>
                <span className="flex-1 font-human">{describeEvent(entry.event, nameOf)}</span>
                {first !== undefined && onShowNode && (
                  <button
                    type="button"
                    className="font-machine text-xs text-accent underline-offset-2 hover:underline"
                    onClick={() => onShowNode(first)}
                  >
                    show node
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
