import type { ChatMessage, ChatVerdict } from '@ace/contracts';
import { create } from 'zustand';

/** An input the node's guardrail policy refused (422 `guardrail_blocked`, FR-CHAT-008). */
export interface ChatRefusal {
  message: string;
  verdicts: ChatVerdict[];
}

/**
 * One sent turn the engine accepted and has not answered yet. `speakerNodeId` is the node answering
 * it (D302) — the `@handle` target, or the session's own node.
 */
export interface PendingTurn {
  threadId: string;
  userMessage: ChatMessage;
  speakerNodeId?: string;
  /**
   * The reply must come after this id. PG-1.6: a retry's is the old reply it replaces. D391: a turn
   * that waited behind another has it raised to the reply that settled that one, so the earlier
   * turn's answer is never read back as this one's. Absent: after the user message.
   */
  afterId?: string;
  /** PG-1.5: when its reply became owed (ms), the start of the stall clock. */
  since?: number;
}

/**
 * What the chat column keeps about one node's session while the app is open (D285). It lives
 * outside any component on purpose: switching to another node and back must find the same thread,
 * the same reply still on its way and the same error — not a blank chat that has forgotten them.
 */
export interface NodeSession {
  /** The thread on screen. Absent: the node's most recent thread, or none yet. */
  threadId?: string;
  /** "New chat" was pressed: an empty session until its first message opens a thread. */
  fresh?: boolean;
  /** The message is on its way to the engine. */
  sending?: boolean;
  /** Accepted by the engine; its reply has not settled yet. D391: the oldest turn still owed. */
  pending?: PendingTurn;
  /**
   * D391: turns sent while `pending` was still owed, oldest first. The engine holds a second turn
   * in its per-project write queue (`chat/service.ts`) and answers the turns in order, so each
   * keeps its own waiting state — and Stop — until its own reply lands. Never set without
   * `pending`.
   */
  queued?: PendingTurn[];
  /** The last send failed before the engine took it — no model chosen, the engine unreachable. */
  error?: string;
  /** The last send was refused by the input guardrails. */
  refusal?: ChatRefusal;
}

/** D391: every turn the session is still owed a reply for, oldest first. */
export const owedTurns = (session: NodeSession): PendingTurn[] =>
  session.pending === undefined ? [] : [session.pending, ...(session.queued ?? [])];

/** D391: the session owing exactly `turns` (oldest first): the first `pending`, the rest `queued`. */
export function withOwed(session: NodeSession, turns: readonly PendingTurn[]): NodeSession {
  const { pending: _pending, queued: _queued, ...rest } = session;
  const [first, ...later] = turns;
  return {
    ...rest,
    ...(first === undefined ? {} : { pending: first }),
    ...(later.length === 0 ? {} : { queued: later }),
  };
}

/** D391: the session also owing `turn`, after every turn it already owes — how a send queues. */
export const oweTurn = (session: NodeSession, turn: PendingTurn): NodeSession =>
  withOwed(session, [...owedTurns(session), turn]);

/** What a turn's reply must come after: its `afterId`, else its user message. */
export const replyAnchor = (turn: PendingTurn): string => turn.afterId ?? turn.userMessage.id;

/**
 * D391: the session after `replyId` landed on `threadId` — the one turn it answers settles, the
 * rest stay owed.
 *
 * Nothing on a `ChatMessage` names the user message it answers (packages/contracts `chat.ts`), so
 * the reply is matched FIFO: it settles the oldest turn owed on that thread whose anchor it comes
 * after. That is the engine's own order — its per-project write queue answers turns one at a time,
 * oldest first, and ids are monotonic — and a reply older than every owed turn (an earlier turn's,
 * landing late) settles none. The thread's later turns then wait for a reply after this one, and
 * the next in line starts its stall clock now, because until now it was queued, not stalled.
 */
export function settleOne(session: NodeSession, threadId: string, replyId: string): NodeSession {
  const owed = owedTurns(session);
  const index = owed.findIndex((turn) => turn.threadId === threadId && replyAnchor(turn) < replyId);
  if (index === -1) return session;
  let next = true;
  const rest = owed
    .filter((_turn, at) => at !== index)
    .map((turn) => {
      if (turn.threadId !== threadId) return turn;
      const afterId = replyAnchor(turn) < replyId ? replyId : turn.afterId;
      const raised = afterId === undefined ? turn : { ...turn, afterId };
      if (!next) return raised;
      next = false;
      return { ...raised, since: Date.now() };
    });
  return withOwed(session, rest);
}

interface ChatSessionsState {
  sessions: Record<string, NodeSession>;
  /** threadId → the reply streaming in right now, from `chat.token` frames. */
  streams: Record<string, string>;
  /** PG-1.5: threadId → when its last `chat.token` arrived (ms), which restarts the stall clock. */
  heardAt: Record<string, number>;
  /** Replace one node's session with what `next` makes of it. */
  update(nodeId: string, next: (session: NodeSession) => NodeSession): void;
  appendToken(threadId: string, delta: string): void;
  /**
   * D391: an agent reply (`replyId`) landed on a thread: its stream ends, and the one turn it
   * answers settles ({@link settleOne}) — a later turn still in the engine's queue stays owed.
   */
  settleReply(threadId: string, replyId: string): void;
  /**
   * Every turn owed on a thread settles at once, and its stream ends: the engine had nothing in
   * flight there (a Stop that found the replies already in), or a test says so.
   */
  settleThread(threadId: string): void;
  /** Tests only. */
  reset(): void;
}

/** A thread's stream and stall clock, without that thread. */
function endStream(state: Pick<ChatSessionsState, 'streams' | 'heardAt'>, threadId: string) {
  const { [threadId]: _settled, ...streams } = state.streams;
  const { [threadId]: _heard, ...heardAt } = state.heardAt;
  return { streams, heardAt };
}

export const useChatSessions = create<ChatSessionsState>()((set) => ({
  sessions: {},
  streams: {},
  heardAt: {},
  update: (nodeId, next) =>
    set((state) => ({
      sessions: { ...state.sessions, [nodeId]: next(state.sessions[nodeId] ?? {}) },
    })),
  appendToken: (threadId, delta) =>
    set((state) => ({
      streams: { ...state.streams, [threadId]: (state.streams[threadId] ?? '') + delta },
      heardAt: { ...state.heardAt, [threadId]: Date.now() },
    })),
  settleReply: (threadId, replyId) =>
    set((state) => {
      const sessions: Record<string, NodeSession> = {};
      for (const [nodeId, session] of Object.entries(state.sessions)) {
        sessions[nodeId] = settleOne(session, threadId, replyId);
      }
      return { ...endStream(state, threadId), sessions };
    }),
  settleThread: (threadId) =>
    set((state) => {
      const sessions: Record<string, NodeSession> = {};
      for (const [nodeId, session] of Object.entries(state.sessions)) {
        const owed = owedTurns(session);
        const kept = owed.filter((turn) => turn.threadId !== threadId);
        sessions[nodeId] = kept.length === owed.length ? session : withOwed(session, kept);
      }
      return { ...endStream(state, threadId), sessions };
    }),
  reset: () => set({ sessions: {}, streams: {}, heardAt: {} }),
}));

/** One node's session, never undefined. */
export const sessionOf = (nodeId: string): NodeSession =>
  useChatSessions.getState().sessions[nodeId] ?? {};
