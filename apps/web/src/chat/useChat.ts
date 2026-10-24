import type {
  ApprovalRequest,
  ChatMessage,
  ChatThread,
  ChatThreadDetail,
  NodeState,
  Part,
} from '@ace/contracts';
import { GuardrailBlockedDetailsSchema } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { runningDebate, useDebateProgress } from './debate-store';
import { chatKeys } from './keys';
import {
  owedTurns,
  oweTurn,
  replyAnchor,
  sessionOf,
  useChatSessions,
  withOwed,
  type ChatRefusal,
  type NodeSession,
  type PendingTurn,
} from './session-store';

export type { ChatRefusal } from './session-store';

/** Most recently used first; the ULID id breaks a tie, so the order never flickers. */
const byRecency = (threads: readonly ChatThread[]): ChatThread[] =>
  [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));

/** The threads of one node, most recently used first (FR-CHAT-004). A bare array, as §2.4 answers (D78). */
export function useChatThreads(nodeId: string | undefined) {
  return useQuery<ChatThread[], Error, ChatThread[]>({
    queryKey: chatKeys.threads(nodeId ?? ''),
    queryFn: () => api().listNodeChatThreads(nodeId ?? ''),
    enabled: Boolean(nodeId),
    select: byRecency,
  });
}

/** One thread's settled turns and metadata (FR-CHAT-006). */
export function useChatThreadDetail(threadId: string | undefined) {
  return useQuery<ChatThreadDetail>({
    queryKey: chatKeys.thread(threadId ?? ''),
    queryFn: () => api().getChatThread(threadId ?? ''),
    enabled: Boolean(threadId),
  });
}

/**
 * The thread a node's chat shows (D285): the one the user picked; none for a session they just
 * started with "New chat"; otherwise the node's most recent thread — the one a run of the node
 * writes its result into, so a run and the chat land in the same place.
 */
export function effectiveThreadId(
  session: NodeSession,
  threads: readonly ChatThread[] | undefined,
): string | undefined {
  if (session.fresh === true) return undefined;
  return session.threadId ?? threads?.[0]?.id;
}

/** D391: the turns this session owes on one thread, oldest first. */
const owedOn = (session: NodeSession, threadId: string | undefined): PendingTurn[] =>
  threadId === undefined ? [] : owedTurns(session).filter((turn) => turn.threadId === threadId);

/**
 * Send one message to a node, in its current session (FR-CHAT-004/006/008, D285). Every outcome is
 * written onto that node's session — accepted (the reply is then awaited), refused by a guardrail,
 * or failed before the engine took it — so it stays with the node whichever node is on screen.
 * D302: `targetNodeId` names another node of the workflow to answer it in this same session.
 */
export async function sendToNode(
  queryClient: QueryClient,
  nodeId: string,
  content: Part[],
  targetNodeId?: string,
): Promise<void> {
  const { update } = useChatSessions.getState();
  update(nodeId, ({ error: _error, refusal: _refusal, ...session }) => ({
    ...session,
    sending: true,
  }));

  try {
    const session = sessionOf(nodeId);
    let threadId: string | undefined;
    if (session.fresh !== true) {
      threadId =
        session.threadId ??
        byRecency(
          await queryClient.fetchQuery({
            queryKey: chatKeys.threads(nodeId),
            queryFn: () => api().listNodeChatThreads(nodeId),
          }),
        )[0]?.id;
    }

    const response = await api().postNodeChat(nodeId, {
      content,
      ...(threadId === undefined ? {} : { threadId }),
      ...(targetNodeId === undefined ? {} : { targetNodeId }),
    });
    const userMessage: ChatMessage = {
      id: response.messageId,
      threadId: response.threadId,
      role: 'user',
      content,
      verdicts: [],
      at: new Date().toISOString(),
    };
    // D391: owed after whatever the session already owes — a second send queues behind the first.
    update(nodeId, ({ sending: _sending, fresh: _fresh, ...rest }) =>
      oweTurn(
        { ...rest, threadId: response.threadId },
        {
          threadId: response.threadId,
          userMessage,
          speakerNodeId: targetNodeId ?? nodeId,
          since: Date.now(),
        },
      ),
    );
    void queryClient.invalidateQueries({ queryKey: chatKeys.threads(nodeId) });
  } catch (error) {
    let refusal: ChatRefusal | undefined;
    if (AceApiError.is(error) && error.code === 'guardrail_blocked') {
      const parsed = GuardrailBlockedDetailsSchema.safeParse(error.details);
      refusal = { message: error.message, verdicts: parsed.success ? parsed.data.verdicts : [] };
    }
    const message =
      error instanceof Error && error.message !== ''
        ? error.message
        : 'The message could not be sent to the engine.';
    update(nodeId, ({ sending: _sending, ...rest }) =>
      refusal === undefined ? { ...rest, error: message } : { ...rest, refusal },
    );
  }
}

/**
 * D405: `@debate` from this node's session. The engine stores the message as the person's turn and
 * runs the debate on the same thread; the session owes the first reply as for any message, and the
 * debate's progress (`chat.debate`) keeps the rest of it on screen.
 */
export async function sendDebate(
  queryClient: QueryClient,
  nodeId: string,
  content: Part[],
): Promise<void> {
  const { update } = useChatSessions.getState();
  update(nodeId, ({ error: _error, refusal: _refusal, ...session }) => ({
    ...session,
    sending: true,
  }));

  try {
    const session = sessionOf(nodeId);
    let threadId: string | undefined;
    if (session.fresh !== true) {
      threadId =
        session.threadId ??
        byRecency(
          await queryClient.fetchQuery({
            queryKey: chatKeys.threads(nodeId),
            queryFn: () => api().listNodeChatThreads(nodeId),
          }),
        )[0]?.id;
    }

    const response = await api().postNodeDebate(nodeId, {
      content,
      ...(threadId === undefined ? {} : { threadId }),
    });
    const userMessage: ChatMessage = {
      id: response.messageId,
      threadId: response.threadId,
      role: 'user',
      content,
      verdicts: [],
      at: new Date().toISOString(),
    };
    update(nodeId, ({ sending: _sending, fresh: _fresh, ...rest }) =>
      oweTurn(
        { ...rest, threadId: response.threadId },
        { threadId: response.threadId, userMessage, since: Date.now() },
      ),
    );
    void queryClient.invalidateQueries({ queryKey: chatKeys.threads(nodeId) });
  } catch (error) {
    const message =
      error instanceof Error && error.message !== ''
        ? error.message
        : 'The debate could not be started.';
    update(nodeId, ({ sending: _sending, ...rest }) => ({ ...rest, error: message }));
  }
}

/** The words an action that failed leaves on the node's session, shown like a failed send. */
function failedAction(nodeId: string, error: unknown, fallback: string): void {
  const message = error instanceof Error && error.message !== '' ? error.message : fallback;
  useChatSessions
    .getState()
    .update(nodeId, ({ sending: _sending, ...rest }) => ({ ...rest, error: message }));
}

/** Clear what the last send or action left on the session, before a new one. */
function clearOutcome(nodeId: string): void {
  useChatSessions
    .getState()
    .update(nodeId, ({ error: _error, refusal: _refusal, ...session }) => session);
}

/**
 * PG-1.6 (D352): re-run the turn that produced an agent message (a reply or a failed turn). The old
 * turn arrives superseded as `chat.update`; the new reply is owed after it, in the same session.
 */
export async function retryMessage(
  queryClient: QueryClient,
  nodeId: string,
  message: ChatMessage,
  options: { withoutUndo?: boolean } = {},
): Promise<void> {
  clearOutcome(nodeId);
  try {
    // PG-2.4 (D361): "Run without undo" retries the stopped turn, letting it write this once.
    const response = await api().retryChatMessage(
      message.threadId,
      message.id,
      options.withoutUndo === true ? { withoutUndo: true } : {},
    );
    useChatSessions.getState().update(nodeId, (session) =>
      oweTurn(
        { ...session, threadId: response.threadId },
        {
          threadId: response.threadId,
          // The question is already in the thread, so nothing is echoed for it.
          userMessage: {
            id: response.messageId,
            threadId: response.threadId,
            role: 'user',
            content: [],
            verdicts: [],
            at: new Date().toISOString(),
          },
          speakerNodeId: message.speakerNodeId ?? nodeId,
          afterId: message.id,
          since: Date.now(),
        },
      ),
    );
  } catch (error) {
    failedAction(nodeId, error, 'The turn could not be retried.');
  }
  void queryClient.invalidateQueries({ queryKey: chatKeys.thread(message.threadId) });
}

/**
 * PG-1.6 (D352): send an edited version of a user message. It and every turn after it become the
 * earlier version; the edited text goes as a new turn. `revert` first reverts the file changes of
 * the turns it replaces (D300's checkpoint revert), when the person asked for that.
 */
export async function editMessage(
  queryClient: QueryClient,
  nodeId: string,
  message: ChatMessage,
  content: Part[],
  options: { speakerNodeId?: string; revert?: { projectId: string; checkpointIds: string[] } } = {},
): Promise<void> {
  clearOutcome(nodeId);
  const failures: string[] = [];
  for (const checkpointId of options.revert?.checkpointIds ?? []) {
    try {
      await api().checkpointAction(options.revert?.projectId ?? '', checkpointId, {
        action: 'revert',
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const response = await api().editChatMessage(message.threadId, message.id, { content });
    useChatSessions.getState().update(nodeId, (session) =>
      oweTurn(
        // D391: the edit supersedes the message and every turn after it in its thread, so a turn
        // still owed there is no longer awaited; the edited turn is.
        withOwed(
          {
            ...session,
            threadId: response.threadId,
            ...(failures.length === 0
              ? {}
              : { error: `Some file changes were not reverted: ${failures.join(' ')}` }),
          },
          owedTurns(session).filter((turn) => turn.threadId !== message.threadId),
        ),
        {
          threadId: response.threadId,
          userMessage: {
            id: response.messageId,
            threadId: response.threadId,
            role: 'user',
            content,
            verdicts: [],
            at: new Date().toISOString(),
          },
          speakerNodeId: options.speakerNodeId ?? nodeId,
          since: Date.now(),
        },
      ),
    );
  } catch (error) {
    let refusal: ChatRefusal | undefined;
    if (AceApiError.is(error) && error.code === 'guardrail_blocked') {
      const parsed = GuardrailBlockedDetailsSchema.safeParse(error.details);
      refusal = { message: error.message, verdicts: parsed.success ? parsed.data.verdicts : [] };
    }
    if (refusal === undefined) failedAction(nodeId, error, 'The edited message was not sent.');
    else useChatSessions.getState().update(nodeId, (session) => ({ ...session, refusal }));
  }
  void queryClient.invalidateQueries({ queryKey: chatKeys.thread(message.threadId) });
}

/** PG-1.6 (D352): hide one message; it never reaches a later prompt. */
export async function deleteMessage(
  queryClient: QueryClient,
  nodeId: string,
  message: ChatMessage,
): Promise<void> {
  clearOutcome(nodeId);
  try {
    await api().deleteChatMessage(message.threadId, message.id);
  } catch (error) {
    failedAction(nodeId, error, 'The message could not be deleted.');
  }
  void queryClient.invalidateQueries({ queryKey: chatKeys.thread(message.threadId) });
}

/**
 * PG-1.6 (D352): stop the reply a node's session is waiting on. The engine stores the turn as a
 * failed turn of kind `user_cancelled`, which settles the session when it arrives. D391: a stop
 * aborts every turn of the thread, the ones still queued behind it too, and each arrives as its
 * own stopped turn — so every thread the session still owes a turn on is stopped.
 */
export async function stopNode(queryClient: QueryClient, nodeId: string): Promise<void> {
  const session = sessionOf(nodeId);
  // D405: a debate keeps going after its first reply settles the turn owed, so its thread is
  // stopped while one of its turns is under way.
  const debating = runningDebate(useDebateProgress.getState().byThread, session.threadId);
  const threadIds = [
    ...new Set([
      ...owedTurns(session).map((turn) => turn.threadId),
      ...(debating === undefined ? [] : [debating.threadId]),
    ]),
  ];
  for (const threadId of threadIds) {
    try {
      const { stopped } = await api().stopChatThread(threadId);
      // Nothing was in flight: the replies already landed, so read them.
      if (!stopped) useChatSessions.getState().settleThread(threadId);
    } catch (error) {
      failedAction(nodeId, error, 'The reply could not be stopped.');
    }
    void queryClient.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
  }
}

/** The first agent turn after `afterId` (not replaced) in these messages: that turn's reply. */
const replyAfter = (messages: readonly ChatMessage[], afterId: string): ChatMessage | undefined =>
  messages.find(
    (message) =>
      message.role === 'agent' && message.id > afterId && message.supersededAt === undefined,
  );

/**
 * PG-1.5 stall rule: "No answer — Retry". The thread is read again first — an answer that landed
 * while its frame was lost is shown and the session settles. Only when there is still none is the
 * question sent again, as an edit of itself, so the unanswered turn becomes the earlier version.
 * D391: the turn is the first one owed on the thread on screen (`threadId`), else the oldest owed;
 * an answer found settles that turn alone.
 */
export async function recoverStalled(
  queryClient: QueryClient,
  nodeId: string,
  onThread?: string,
): Promise<void> {
  const session = sessionOf(nodeId);
  const pending = owedOn(session, onThread)[0] ?? session.pending;
  if (pending === undefined) return;
  const { threadId } = pending;
  let detail: ChatThreadDetail;
  try {
    detail = await queryClient.fetchQuery({
      queryKey: chatKeys.thread(threadId),
      queryFn: () => api().getChatThread(threadId),
      staleTime: 0,
    });
  } catch (error) {
    failedAction(nodeId, error, 'The conversation could not be read.');
    return;
  }
  const answer = replyAfter(detail.messages, replyAnchor(pending));
  if (answer !== undefined) {
    useChatSessions.getState().settleReply(threadId, answer.id);
    return;
  }
  // Asked again as an edit of itself, which supersedes it and every turn after it in the thread.
  useChatSessions.getState().settleThread(threadId);
  const question = detail.messages.find((message) => message.id === pending.userMessage.id);
  if (question === undefined || question.content.length === 0) {
    failedAction(nodeId, undefined, 'The unanswered message is no longer in this conversation.');
    return;
  }
  await editMessage(queryClient, nodeId, question, question.content, {
    ...(pending.speakerNodeId === undefined ? {} : { speakerNodeId: pending.speakerNodeId }),
  });
}

const NO_SESSION: NodeSession = {};

/** A run ended for this node (or never reached it): its turns are in its chat now (D285). */
const SETTLED: ReadonlySet<NodeState> = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED']);

/**
 * The chat's one link to the socket (FR-CHAT-006, D285). Mounted once by the chat column, so a
 * reply keeps arriving for a node that is not on screen: it stays subscribed to every thread a
 * reply is still owed on, as well as the thread being read.
 *
 * - `chat.token` builds the streaming text of its thread;
 * - `chat.message` ends it, settles the one turn it answers (D391), and re-reads the thread, so the
 *   engine's stored turns — not a client copy — are what is shown;
 * - a node's run ending re-reads that node's chat, which already holds the run's goal and result:
 *   the engine writes them before it announces the state.
 *
 * A subscription is followed by a re-read of its thread, so a reply that settled in the moment
 * before the subscription took is still shown.
 */
export function useChatSocket(activeNodeId: string | undefined): void {
  const queryClient = useQueryClient();
  const activeSession = useChatSessions((state) =>
    activeNodeId === undefined ? undefined : state.sessions[activeNodeId],
  );
  const activeThreads = useChatThreads(activeNodeId);
  const activeThreadId =
    activeNodeId === undefined
      ? undefined
      : effectiveThreadId(activeSession ?? NO_SESSION, activeThreads.data);
  const owed = useChatSessions(
    useShallow((state) =>
      Object.values(state.sessions).flatMap((session) =>
        owedTurns(session).map((turn) => turn.threadId),
      ),
    ),
  );
  const watched = useMemo(
    () => [...new Set([...owed, ...(activeThreadId === undefined ? [] : [activeThreadId])])].sort(),
    [owed, activeThreadId],
  );
  const watchedKey = watched.join(',');

  useEffect(() => {
    const socket = getSocket();
    if (socket === undefined) return;
    const offToken = socket.on('chat.token', (payload) => {
      useChatSessions.getState().appendToken(payload.threadId, payload.delta);
    });
    // D405: a debate's progress — which turn is under way, then how it ended.
    const offDebate = socket.on('chat.debate', (payload) => {
      useDebateProgress.getState().report(payload);
    });
    const offMessage = socket.on('chat.message', (payload) => {
      // D391: a reply settles the one turn it answers; a turn still queued behind it stays owed.
      if (payload.message.role === 'agent')
        useChatSessions.getState().settleReply(payload.threadId, payload.message.id);
      void queryClient.invalidateQueries({ queryKey: chatKeys.thread(payload.threadId) });
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    });
    // PG-1.6 (D352): a turn was superseded or deleted; the engine's copy is what is shown.
    const offUpdate = socket.on('chat.update', (payload) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.thread(payload.threadId) });
    });
    // PG-2.2 (D359): a tool call waits on a person, or was decided.
    const offAsk = socket.on('chat.approval_required', (payload) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.approvals(payload.threadId) });
    });
    const offDecided = socket.on('chat.approval_decided', (payload) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.approvals(payload.threadId) });
    });
    const offState = socket.on('node.state', (payload) => {
      if (!SETTLED.has(payload.status)) return;
      void queryClient.invalidateQueries({ queryKey: chatKeys.threads(payload.nodeId) });
      void queryClient.invalidateQueries({ queryKey: ['chat-thread'] });
    });
    return () => {
      offToken();
      offDebate();
      offMessage();
      offUpdate();
      offAsk();
      offDecided();
      offState();
    };
  }, [queryClient]);

  // Subscribe and unsubscribe by difference, so a thread that stays watched is never dropped.
  const subscribed = useRef(new Set<string>());
  useEffect(() => {
    const socket = getSocket();
    if (socket === undefined) return;
    const next = new Set(watchedKey === '' ? [] : watchedKey.split(','));
    for (const id of next) {
      if (subscribed.current.has(id)) continue;
      socket.subscribe({ scope: 'thread', id });
      void queryClient.invalidateQueries({ queryKey: chatKeys.thread(id) });
    }
    for (const id of subscribed.current) {
      if (!next.has(id)) socket.unsubscribe({ scope: 'thread', id });
    }
    subscribed.current = next;
  }, [watchedKey, queryClient]);
  useEffect(
    () => () => {
      const socket = getSocket();
      for (const id of subscribed.current) socket?.unsubscribe({ scope: 'thread', id });
      subscribed.current = new Set();
    },
    [],
  );
}

export interface ChatConversation {
  /** The thread on screen; undefined for a session with no thread yet. */
  threadId: string | undefined;
  /** The node's threads, most recently used first. */
  threads: ChatThread[];
  /** The stored turns, plus the just-sent user turn until the engine's copy is read back. */
  messages: ChatMessage[];
  /** The reply streaming in right now (FR-CHAT-006); `''` when nothing streams. */
  streamingText: string;
  /** A sent message's reply has not landed yet (D391: any sent message's, on this thread). */
  awaitingReply: boolean;
  /**
   * D391: turns the session sent after the one being answered that still wait in the engine's
   * queue — what the composer's "N queued" says. 0 while one turn or none is outstanding.
   */
  queued: number;
  /** D302: the node answering the reply that is owed, when one is. */
  replyingNodeId: string | undefined;
  /** The message is on its way to the engine. */
  sending: boolean;
  /** Set when the last send was refused on the input; cleared on the next send. */
  refusal: ChatRefusal | undefined;
  /** Set when the last send failed before the engine took it; cleared on the next send. */
  error: string | undefined;
  /**
   * [audit W-11] The node's threads or this thread could not be read — not the same as a chat with
   * nothing in it. `retry` reads them again.
   */
  loadError: { message: string; retry: () => void } | undefined;
  send: (content: Part[], targetNodeId?: string) => void;
  /**
   * PG-1.5: when the stall clock last restarted (ms) — the reply became owed, or a token arrived —
   * while a reply is owed; undefined otherwise.
   */
  waitingSince: number | undefined;
  /** PG-1.6 (D352) message actions. */
  retry: (message: ChatMessage) => void;
  /** PG-2.4 (D361): retry a turn stopped without a checkpoint, writing this once without undo. */
  retryWithoutUndo: (message: ChatMessage) => void;
  /** PG-2.2 (D359): the thread's tool calls waiting on a person. */
  approvals: ApprovalRequest[];
  /** PG-2.2: approve or reject one of them; the turn goes on either way. */
  decideApproval: (
    request: ApprovalRequest,
    kind: 'approve' | 'reject',
    /** D376: also save the command's prefix on the node (approve only). */
    always?: boolean,
  ) => void;
  edit: (
    message: ChatMessage,
    content: Part[],
    revert?: { projectId: string; checkpointIds: string[] },
  ) => void;
  remove: (message: ChatMessage) => void;
  /** PG-1.6: stop the reply in flight. */
  stop: () => void;
  /** PG-1.5: "No answer — Retry": read the thread again, and send the question again if need be. */
  recover: () => void;
  selectThread: (threadId: string) => void;
  /** Start an empty session; its first message opens a thread. */
  newThread: () => void;
}

/**
 * One node's conversation (FR-CHAT-004/006/008, D285). Everything about it — the thread on screen,
 * a reply still on its way, an error — lives in the node's session, so switching nodes and back
 * shows exactly what was there. Its sources are the chat endpoints and the thread's frames; a
 * direct chat itself never reads or writes a run (FR-CHAT-005).
 */
export function useThreadConversation(nodeId: string): ChatConversation {
  const queryClient = useQueryClient();
  const session = useChatSessions((state) => state.sessions[nodeId]) ?? NO_SESSION;
  const threads = useChatThreads(nodeId);
  const threadId = effectiveThreadId(session, threads.data);
  const detail = useChatThreadDetail(threadId);
  // PG-2.2 (D359): what this thread's turn is waiting on; the frames re-read it.
  const approvals = useQuery({
    queryKey: chatKeys.approvals(threadId ?? ''),
    queryFn: () => api().listChatApprovals(threadId ?? ''),
    enabled: threadId !== undefined,
  });
  const streamingText = useChatSessions((state) =>
    threadId === undefined ? '' : (state.streams[threadId] ?? ''),
  );

  const loaded = detail.data?.messages ?? [];
  // D391: every turn owed on this thread, oldest first; the first is the one being answered.
  const owedHere = owedOn(session, threadId);
  const pending = owedHere[0];
  // Each sent message shows until the engine's copy is read back, in the order they were sent.
  const echo = owedHere
    .filter((turn) => !loaded.some((message) => message.id === turn.userMessage.id))
    .map((turn) => turn.userMessage);
  // Engine ids are monotonic: an agent turn after the sent one is its reply (or its failure). A
  // retry's reply comes after the turn it replaces (PG-1.6); a replaced turn never counts. D391: a
  // turn queued behind another waits for a reply after the one that settled it (`afterId`).
  const answer = pending === undefined ? undefined : replyAfter(loaded, replyAnchor(pending));
  const replied = answer !== undefined;
  // The turn whose reply is owed now: the first, or — for the moment until that reply settles it —
  // the next.
  const awaited = replied ? owedHere[1] : pending;
  const heardAt = useChatSessions((state) =>
    threadId === undefined ? undefined : state.heardAt[threadId],
  );

  // A reply read back before its frame arrived (a frame missed during a reconnect) still settles —
  // the turn it answers, and only that one (D391).
  const answerId = answer?.id;
  useEffect(() => {
    if (answerId !== undefined && pending !== undefined)
      useChatSessions.getState().settleReply(pending.threadId, answerId);
  }, [answerId, pending]);

  const update = useChatSessions.getState().update;
  return {
    threadId,
    threads: threads.data ?? [],
    messages: [...loaded, ...echo],
    streamingText,
    awaitingReply: awaited !== undefined,
    queued: Math.max(0, owedTurns(session).length - 1),
    replyingNodeId: awaited?.speakerNodeId,
    sending: session.sending === true,
    refusal: session.refusal,
    error: session.error,
    loadError:
      threads.isError || detail.isError
        ? {
            message: (threads.error ?? detail.error)?.message ?? 'The engine did not answer.',
            retry: () => {
              if (threads.isError) void threads.refetch();
              if (detail.isError) void detail.refetch();
            },
          }
        : undefined,
    send: (content, targetNodeId) => void sendToNode(queryClient, nodeId, content, targetNodeId),
    waitingSince:
      awaited !== undefined && !replied
        ? Math.max(awaited.since ?? 0, heardAt ?? 0) || undefined
        : undefined,
    retry: (message) => void retryMessage(queryClient, nodeId, message),
    retryWithoutUndo: (message) =>
      void retryMessage(queryClient, nodeId, message, { withoutUndo: true }),
    approvals: approvals.data ?? [],
    decideApproval: (request, kind, always = false) => {
      const threadOf = request.threadId ?? threadId ?? '';
      const call =
        kind === 'approve'
          ? api().approveChatToolCall(threadOf, request.id, always ? { always: true } : {})
          : api().rejectChatToolCall(threadOf, request.id);
      void call
        .catch((error: unknown) =>
          failedAction(nodeId, error, 'The decision could not be sent to the engine.'),
        )
        .finally(
          () => void queryClient.invalidateQueries({ queryKey: chatKeys.approvals(threadOf) }),
        );
    },
    edit: (message, content, revert) => {
      // Whoever answered it answers the new version (D302): the first reply after it.
      const answered = loaded.find(
        (each) => each.role === 'agent' && each.id > message.id && each.supersededAt === undefined,
      );
      void editMessage(queryClient, nodeId, message, content, {
        ...(answered?.speakerNodeId === undefined ? {} : { speakerNodeId: answered.speakerNodeId }),
        ...(revert === undefined ? {} : { revert }),
      });
    },
    remove: (message) => void deleteMessage(queryClient, nodeId, message),
    stop: () => void stopNode(queryClient, nodeId),
    recover: () => void recoverStalled(queryClient, nodeId, threadId),
    selectThread: (id) =>
      update(nodeId, ({ fresh: _fresh, error: _error, refusal: _refusal, ...rest }) => ({
        ...rest,
        threadId: id,
      })),
    newThread: () =>
      update(nodeId, ({ threadId: _threadId, error: _error, refusal: _refusal, ...rest }) => ({
        ...rest,
        fresh: true,
      })),
  };
}

/** Delete a thread; a node whose session was showing it falls back to its latest (FR-CHAT-004). */
export function useDeleteThread(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => api().deleteChatThread(threadId),
    onSuccess: (_result, threadId) => {
      useChatSessions.getState().update(nodeId, (session) => {
        if (session.threadId !== threadId) return session;
        const { threadId: _gone, ...rest } = session;
        return rest;
      });
      return queryClient.invalidateQueries({ queryKey: chatKeys.threads(nodeId) });
    },
  });
}
