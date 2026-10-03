import type { Id, Message, MessageType, ProviderType } from '@ace/contracts';
import { MESSAGE_TYPES, messageMatchesQuery } from '@ace/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';

/**
 * The Timeline's data (round 4 §5 item 4, FR-CHAT-001/002/004). A `Message` is one row of the
 * workflow's timeline; the whole list is derived from the engine's persisted messages exactly as
 * the events tab is derived from persisted run events (BR-01, BR-04): `GET /workflows/:id/messages`
 * on load, then `message.created` folded live. Because every row is persisted, a reconnect that
 * replays them lands on the identical list — which is why the fold dedups by `id`.
 *
 * The list is loaded whole and filtered on the client (`applyMessageFilter`), so switching a filter
 * is instant and never drops a live row that the current filter happens to exclude. The pure
 * helpers here are what the Timeline tab, the full page and their tests all share, so the screen and
 * the URL agree on what a filter means (the same reasoning as `messageMatchesQuery`, D52).
 */

/** The Timeline's own query key, kept local so it never collides with the shared `query-keys`. */
export const timelineMessagesKey = (workflowId: Id | undefined) =>
  ['timeline-messages', workflowId ?? ''] as const;

/**
 * Time order for the timeline. `at` is an ISO timestamp, so a lexicographic compare is chronological
 * order; ties keep input order (the persisted page comes before the live tail), which a plain
 * `Array#sort` guarantees now that it is stable. Duplicates — a message delivered both by the load
 * and by a replayed `message.created` — are collapsed to the first seen.
 */
export function orderMessages(messages: readonly Message[]): Message[] {
  const byId = new Map<Id, Message>();
  for (const message of messages) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** One combinable filter (FR-CHAT-002); every field is optional and they intersect. */
export interface TimelineFilter {
  runId?: Id;
  nodeId?: Id;
  type?: MessageType;
}

/** Does a row pass the filter? Delegates to the contract so the engine and the UI never diverge. */
export function messagePassesFilter(message: Message, filter: TimelineFilter): boolean {
  return messageMatchesQuery(message, {
    ...(filter.runId === undefined ? {} : { runId: filter.runId }),
    ...(filter.nodeId === undefined ? {} : { nodeId: filter.nodeId }),
    ...(filter.type === undefined ? {} : { type: [filter.type] }),
  });
}

export function applyMessageFilter(
  messages: readonly Message[],
  filter: TimelineFilter,
): Message[] {
  return messages.filter((message) => messagePassesFilter(message, filter));
}

/** True when no field is set — the whole timeline is showing. */
export function isEmptyFilter(filter: TimelineFilter): boolean {
  return filter.runId === undefined && filter.nodeId === undefined && filter.type === undefined;
}

/** The run ids the timeline has rows for, in first-seen order — the run filter's options. */
export function runOptions(messages: readonly Message[]): Id[] {
  const ids: Id[] = [];
  for (const message of messages) {
    if (message.runId !== undefined && !ids.includes(message.runId)) ids.push(message.runId);
  }
  return ids;
}

/** The node ids the timeline has rows for, in first-seen order — the node filter's options. */
export function nodeOptions(messages: readonly Message[]): Id[] {
  const ids: Id[] = [];
  for (const message of messages) {
    if (message.nodeId !== undefined && !ids.includes(message.nodeId)) ids.push(message.nodeId);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Row metadata: a message names a node id; the bubble wants a name and accent */
/* -------------------------------------------------------------------------- */

export interface TimelineNode {
  id: Id;
  name: string;
  /** The provider this agent/model node runs on, so the bubble carries its accent. */
  providerId?: Id;
}

export interface TimelineProvider {
  id: Id;
  type: ProviderType;
}

export interface MessageMeta {
  nodeName?: string;
  provider?: ProviderType;
}

/**
 * Resolve a message's node id to the node name and provider accent `MessageBubble` renders. Only an
 * agent message needs the accent, and only a node that names a provider has one; anything unresolved
 * simply renders without it.
 */
export function resolveMessageMeta(
  message: Message,
  nodes: readonly TimelineNode[],
  providers: readonly TimelineProvider[],
): MessageMeta {
  if (message.nodeId === undefined) return {};
  const node = nodes.find((candidate) => candidate.id === message.nodeId);
  if (node === undefined) return {};
  const provider =
    node.providerId === undefined
      ? undefined
      : providers.find((candidate) => candidate.id === node.providerId)?.type;
  return { nodeName: node.name, ...(provider === undefined ? {} : { provider }) };
}

/* -------------------------------------------------------------------------- */
/* URL <-> filter (full page, FR-CHAT-002: filters reflected in the URL query) */
/* -------------------------------------------------------------------------- */

const isMessageType = (value: string): value is MessageType =>
  (MESSAGE_TYPES as readonly string[]).includes(value);

/** Read a filter out of the page's `?run=&node=&type=` query. Unknown values are ignored. */
export function filterFromParams(params: URLSearchParams): TimelineFilter {
  const filter: TimelineFilter = {};
  const runId = params.get('run');
  const nodeId = params.get('node');
  const type = params.get('type');
  if (runId) filter.runId = runId;
  if (nodeId) filter.nodeId = nodeId;
  if (type && isMessageType(type)) filter.type = type;
  return filter;
}

/** Write a filter into a fresh query object, dropping the keys that are not set. */
export function paramsFromFilter(filter: TimelineFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.runId !== undefined) params.set('run', filter.runId);
  if (filter.nodeId !== undefined) params.set('node', filter.nodeId);
  if (filter.type !== undefined) params.set('type', filter.type);
  return params;
}

/* -------------------------------------------------------------------------- */
/* The data hook                                                               */
/* -------------------------------------------------------------------------- */

/** Messages per request while loading the whole timeline (the engine's default page is 100). */
export const MESSAGE_PAGE_SIZE = 500;

/**
 * The whole persisted timeline: `GET /messages` pages oldest-first with a forward cursor, so follow
 * `nextCursor` until there is none (D-071 — one page left everything after the first 100 missing on
 * reload). A cursor seen twice ends the walk rather than looping on a misbehaving server.
 */
export async function loadAllMessages(
  fetchPage: (cursor?: string) => Promise<{ items: Message[]; nextCursor?: string }>,
): Promise<Message[]> {
  const all: Message[] = [];
  const followed = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    if (page.nextCursor === undefined || followed.has(page.nextCursor)) return all;
    followed.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export interface TimelineMessagesResult {
  messages: Message[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * The workflow's timeline, live. The persisted page is a query so it comes back identically after a
 * reload (the socket seeds `lastSeq` from `hello`, so `resume` replays nothing from before the load
 * — the same reason the run overlay adopts from records, D-028); `message.created` frames arriving
 * on the workflow subscription are folded on top and deduped by id.
 */
export function useTimelineMessages(workflowId: Id | undefined): TimelineMessagesResult {
  const initial = useQuery({
    queryKey: timelineMessagesKey(workflowId),
    queryFn: () =>
      loadAllMessages((cursor) =>
        api().listMessages(workflowId ?? '', {
          limit: MESSAGE_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    enabled: Boolean(workflowId),
  });

  const [live, setLive] = useState<Message[]>([]);

  useEffect(() => {
    setLive([]);
    const socket = getSocket();
    if (!socket || workflowId === undefined) return;
    return socket.on('message.created', (payload) => {
      if (payload.workflowId !== workflowId) return;
      setLive((previous) =>
        previous.some((message) => message.id === payload.message.id)
          ? previous
          : [...previous, payload.message],
      );
    });
  }, [workflowId]);

  const messages = useMemo(
    () => orderMessages([...(initial.data ?? []), ...live]),
    [initial.data, live],
  );

  return { messages, isLoading: initial.isPending, isError: initial.isError };
}
