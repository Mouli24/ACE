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
 *
 * In the theme (D328): the theme dropdown for the node filter, and one mono 11px row per event with
 * a hairline under it — seq and time muted, the type in ink, the sentence in its tone.
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
    case 'tool.call': {
      // A tool call names the node run it ran under, like a verdict does (round 4 §2.4).
      const nodeId = nodeIdByNodeRunId.get(event.payload.nodeRunId);
      return nodeId === undefined ? [] : [nodeId];
    }
    case 'message.created':
      // A timeline row may name no node at all — a user message posted before a run started.
      return event.payload.message.nodeId === undefined ? [] : [event.payload.message.nodeId];
    case 'run.started':
    case 'run.completed':
    case 'run.paused':
    case 'run.resumed':
    case 'usage.updated':
    case 'envelope.routed':
    case 'run.token_budget':
    case 'run.config':
    case 'run.parked':
      return [];
    /* Domain (D303): the events a run's conversation is projected from. */
    case 'human.message':
      return event.payload.mentions.map((mention) => mention.nodeId);
    case 'instruction.state':
    case 'node.interrupted':
      return [event.payload.nodeId];
    case 'envelope.sent':
      return [event.payload.fromNodeId, ...event.payload.toNodeIds];
    case 'run.blocked':
      return event.payload.nodeIds ?? [];
  }
}

/** The text colour of an event row: the node's state colour for state changes, red for errors. */
function eventTone(event: PersistedRunEvent): string {
  if (event.type === 'node.state') return `var(--color-status-${event.payload.status})`;
  if (event.type === 'node.error') return '#c94c27';
  return 'var(--muted)';
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
    case 'tool.call': {
      const { toolCall } = event.payload;
      return `${toolCall.toolName} ${toolCall.status} in ${toolCall.durationMs} ms — ${toolCall.resultSummary}`;
    }
    case 'message.created': {
      const { message } = event.payload;
      // The node is named when there is one; a message with no node is the timeline's own row.
      const from = message.nodeId === undefined ? message.type : nameOf(message.nodeId);
      return `${from} added a ${message.type} message to the timeline`;
    }
    /* Domain (D303). */
    case 'human.message': {
      const { mentions, text } = event.payload;
      const to =
        mentions.length === 0
          ? 'every node (the goal)'
          : mentions.map((each) => `@${each.handle}`).join(', ');
      return `you → ${to}: ${text}`;
    }
    case 'instruction.state':
      return `message ${event.payload.state.toLowerCase()} for ${nameOf(event.payload.nodeId)}`;
    case 'envelope.sent': {
      const { fromNodeId, toNodeIds, kind, summary } = event.payload;
      return `${nameOf(fromNodeId)} → ${toNodeIds.map(nameOf).join(', ')}: ${kind} — ${summary}`;
    }
    case 'envelope.routed': {
      const { decision, by, reason } = event.payload;
      return `envelope ${decision.toLowerCase()} by ${by}${reason === undefined ? '' : ` — ${reason}`}`;
    }
    case 'node.interrupted':
      return `${nameOf(event.payload.nodeId)}'s turn was interrupted by a new message`;
    case 'run.token_budget': {
      const { level, used, limit } = event.payload;
      if (level === 'SET')
        return limit === null ? 'token budget removed' : `token budget set to ${limit}`;
      return `token budget ${level === 'WARN' ? 'at 80%' : 'exceeded'}: ${used} of ${limit ?? '?'}`;
    }
    case 'run.config': {
      const { routing, loopGuardLimit, tokenBudget } = event.payload.config;
      return `${routing} routing, loop guard ${loopGuardLimit}${tokenBudget === null ? '' : `, budget ${tokenBudget} tokens`}`;
    }
    case 'run.blocked':
      return `run blocked — ${event.payload.reason}: ${event.payload.detail}`;
    case 'run.parked':
      return event.payload.graph === 'complete'
        ? 'the graph finished — the run stays open'
        : 'the graph stopped with failures — the run stays open';
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
      if (event.type === 'node.approval_required' && event.payload.request.nodeRunId !== undefined) {
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
    <div className="flex flex-col gap-2 py-3" data-testid="events-tab">
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
        <span className="text-[12px] text-[var(--muted)]" data-testid="events-count">
          {rows.length} event{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="m-0 py-3 text-center text-[13px] text-[var(--muted)]">
          {ordered.length === 0
            ? 'No events yet. Start a run and everything it does appears here.'
            : 'No events for this node.'}
        </p>
      ) : (
        <ol
          className="m-0 flex list-none flex-col p-0 font-machine text-[11px]"
          data-testid="events-list"
        >
          {rows.map((entry) => {
            const nodeIds = eventNodeIds(entry.event, nodeIdByNodeRunId);
            const first = nodeIds[0];
            return (
              <li
                key={entry.event.seq}
                data-testid={`event-${entry.event.seq}`}
                data-type={entry.event.type}
                {...(first === undefined ? {} : { 'data-node-id': first })}
                className="flex flex-wrap items-baseline gap-x-[10px] gap-y-0.5 border-b border-[var(--line)] py-[6px]"
              >
                <span className="text-[var(--muted)]">#{entry.event.seq}</span>
                {entry.at !== undefined && (
                  <span className="text-[var(--muted)]">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                )}
                <span className="text-[var(--ink)]">{entry.event.type}</span>
                <span className="flex-1" style={{ color: eventTone(entry.event) }}>
                  {describeEvent(entry.event, nameOf)}
                </span>
                {first !== undefined && onShowNode && (
                  <button
                    type="button"
                    className="cursor-pointer border-none bg-transparent p-0 font-human text-[11.5px] font-semibold text-[#e8623a] outline-none hover:text-[#c94c27] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
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
