import type { Id, Node } from '@ace/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';
import { useProviders } from '../providers/hooks';
import { agentMap } from '../theme/agents';
import { useWorkflowGraph } from '../workflows/hooks';
import { TimelineComposer } from './TimelineComposer';
import { TimelineFilters } from './TimelineFilters';
import { TimelineList, type TimelineRow } from './TimelineList';
import {
  applyMessageFilter,
  isEmptyFilter,
  nodeOptions,
  resolveMessageMeta,
  runOptions,
  timelineMessagesKey,
  useTimelineMessages,
  type TimelineFilter,
  type TimelineNode,
} from './timeline-messages';

/**
 * The Timeline itself (round 4 §5 item 4, FR-CHAT-001/002/003), shared by the bottom "Timeline" tab
 * and the full page. It owns the data (`useTimelineMessages`) and the composer's mutation; the
 * filter state is owned by the caller, so the tab can keep it local and the page can keep it in the
 * URL.
 *
 * Node names and provider accents come from the workflow graph and the provider list — the same
 * sources the Canvas draws from — so an agent's bubble reads under its node name in its provider's
 * colour without the message having to carry either (BR-01). An agent's dot takes the colour the
 * theme gives that agent everywhere — by its order among the Agent and Model nodes (D328).
 */

export interface TimelinePanelProps {
  workflowId: Id;
  filter: TimelineFilter;
  onFilterChange: (filter: TimelineFilter) => void;
  className?: string;
}

/** Pull the provider a node runs on out of its config, for the accent — only agent/model have one. */
function timelineNodeOf(node: Node): TimelineNode {
  const providerId =
    node.kind === 'agent' || node.kind === 'model' ? node.config.providerId : undefined;
  return { id: node.id, name: node.name, ...(providerId === undefined ? {} : { providerId }) };
}

export function TimelinePanel({
  workflowId,
  filter,
  onFilterChange,
  className,
}: TimelinePanelProps) {
  const { messages, isError } = useTimelineMessages(workflowId);
  const graph = useWorkflowGraph(workflowId);
  const providers = useProviders();
  const queryClient = useQueryClient();

  const nodes = useMemo<TimelineNode[]>(
    () => (graph.data?.nodes ?? []).map(timelineNodeOf),
    [graph.data?.nodes],
  );
  const agents = useMemo(() => agentMap(graph.data?.nodes ?? []), [graph.data?.nodes]);
  const providerList = useMemo(
    () => (providers.data ?? []).map((provider) => ({ id: provider.id, type: provider.type })),
    [providers.data],
  );

  const nodeName = (nodeId: Id): string =>
    nodes.find((node) => node.id === nodeId)?.name ?? 'unknown node';

  const filtered = useMemo(() => applyMessageFilter(messages, filter), [messages, filter]);

  const rows = useMemo<TimelineRow[]>(
    () =>
      filtered.map((message) => {
        const meta = resolveMessageMeta(message, nodes, providerList);
        const color = message.nodeId === undefined ? undefined : agents.get(message.nodeId)?.color;
        return {
          message,
          ...(meta.nodeName === undefined ? {} : { nodeName: meta.nodeName }),
          ...(meta.provider === undefined ? {} : { provider: meta.provider }),
          ...(color === undefined ? {} : { color }),
        };
      }),
    [filtered, nodes, providerList, agents],
  );

  const send = useMutation({
    mutationFn: (text: string) =>
      api().postMessage(workflowId, { content: [{ type: 'text', text }], run: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: timelineMessagesKey(workflowId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
    },
  });

  const emptyLabel = isError
    ? 'Could not load the timeline.'
    : messages.length === 0
      ? undefined
      : 'No messages match this filter.';

  return (
    <div
      data-testid="timeline"
      className={['flex h-full min-h-0 flex-col', className].filter(Boolean).join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] p-3">
        <TimelineFilters
          filter={filter}
          onChange={onFilterChange}
          runIds={runOptions(messages)}
          nodeIds={nodeOptions(messages)}
          nodeName={nodeName}
        />
        <span className="ml-auto text-[12px] text-[var(--muted)]" data-testid="timeline-count">
          {rows.length}
          {isEmptyFilter(filter) ? '' : ` of ${messages.length}`} message
          {rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TimelineList
          rows={rows}
          contentUrl={(artifactId) => api().artifactContentUrl(artifactId)}
          {...(emptyLabel === undefined ? {} : { emptyLabel })}
        />
      </div>

      <TimelineComposer onSend={(text) => send.mutate(text)} busy={send.isPending} />
    </div>
  );
}
