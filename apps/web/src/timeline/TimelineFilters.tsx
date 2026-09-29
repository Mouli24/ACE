import type { Id, MessageType } from '@ace/contracts';
import { MESSAGE_TYPES } from '@ace/contracts';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';

import { isEmptyFilter, type TimelineFilter } from './timeline-messages';

/**
 * The Timeline's filters (round 4 §5 item 4, FR-CHAT-002): by run, by node and by message type,
 * combinable. The three are independent `Select`s, so any combination is a single click each and
 * they intersect — a node plus a type shows only that node's messages of that type. "Clear" appears
 * only when something is set, so the common case (the whole timeline) has nothing to undo.
 *
 * This is a controlled component: the tab keeps the filter in local state, the full page keeps it in
 * the URL query, and both hand it down here — so the filter can be reflected wherever it belongs.
 */

const ALL = '__all__';

/** Human-readable message-type labels; the styles they select are `MessageBubble`'s job. */
const TYPE_LABEL: Readonly<Record<MessageType, string>> = {
  user: 'you',
  agent: 'agent',
  output: 'output',
  event: 'event',
  error: 'error',
  system: 'system',
};

export interface TimelineFiltersProps {
  filter: TimelineFilter;
  onChange: (filter: TimelineFilter) => void;
  /** The run ids the timeline has rows for; each is shown short, newest label from the parent. */
  runIds: readonly Id[];
  /** The node ids the timeline has rows for, resolved to names by `nodeName`. */
  nodeIds: readonly Id[];
  nodeName: (nodeId: Id) => string;
  /** A short label for a run id — the parent may pass an index or a time; falls back to the id. */
  runLabel?: (runId: Id) => string;
}

export function TimelineFilters({
  filter,
  onChange,
  runIds,
  nodeIds,
  nodeName,
  runLabel,
}: TimelineFiltersProps) {
  const set = (patch: Partial<TimelineFilter>) => onChange({ ...filter, ...patch });

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="timeline-filters"
      role="group"
      aria-label="Timeline filters"
    >
      <Select
        value={filter.runId ?? ALL}
        onValueChange={(value) => set({ runId: value === ALL ? undefined : value })}
      >
        <SelectTrigger className="w-40" aria-label="Filter by run">
          <SelectValue placeholder="all runs" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>all runs</SelectItem>
          {runIds.map((runId, index) => (
            <SelectItem key={runId} value={runId}>
              {runLabel?.(runId) ?? `run ${index + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.nodeId ?? ALL}
        onValueChange={(value) => set({ nodeId: value === ALL ? undefined : value })}
      >
        <SelectTrigger className="w-44" aria-label="Filter by node">
          <SelectValue placeholder="all nodes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>all nodes</SelectItem>
          {nodeIds.map((nodeId) => (
            <SelectItem key={nodeId} value={nodeId}>
              {nodeName(nodeId)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.type ?? ALL}
        onValueChange={(value) =>
          set({ type: value === ALL ? undefined : (value as MessageType) })
        }
      >
        <SelectTrigger className="w-40" aria-label="Filter by type">
          <SelectValue placeholder="all types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>all types</SelectItem>
          {MESSAGE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {TYPE_LABEL[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!isEmptyFilter(filter) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({})} data-testid="timeline-clear-filters">
          Clear
        </Button>
      )}
    </div>
  );
}
