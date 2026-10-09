import type { ChatMessage, ChatVerdict } from '@ace/contracts';
import { create } from 'zustand';

/** An input the node's guardrail policy refused (422 `guardrail_blocked`, FR-CHAT-008). */
export interface ChatRefusal {
  message: string;
  verdicts: ChatVerdict[];
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
  /** Accepted by the engine; its reply has not settled yet. */
  pending?: { threadId: string; userMessage: ChatMessage };
  /** The last send failed before the engine took it — no model chosen, the engine unreachable. */
  error?: string;
  /** The last send was refused by the input guardrails. */
  refusal?: ChatRefusal;
}

interface ChatSessionsState {
  sessions: Record<string, NodeSession>;
  /** threadId → the reply streaming in right now, from `chat.token` frames. */
  streams: Record<string, string>;
  /** Replace one node's session with what `next` makes of it. */
  update(nodeId: string, next: (session: NodeSession) => NodeSession): void;
  appendToken(threadId: string, delta: string): void;
  /** A thread's reply settled: its stream ends and whichever node was waiting on it stops waiting. */
  settleThread(threadId: string): void;
  /** Tests only. */
  reset(): void;
}

export const useChatSessions = create<ChatSessionsState>()((set) => ({
  sessions: {},
  streams: {},
  update: (nodeId, next) =>
    set((state) => ({
      sessions: { ...state.sessions, [nodeId]: next(state.sessions[nodeId] ?? {}) },
    })),
  appendToken: (threadId, delta) =>
    set((state) => ({
      streams: { ...state.streams, [threadId]: (state.streams[threadId] ?? '') + delta },
    })),
  settleThread: (threadId) =>
    set((state) => {
      const { [threadId]: _settled, ...streams } = state.streams;
      const sessions: Record<string, NodeSession> = {};
      for (const [nodeId, session] of Object.entries(state.sessions)) {
        if (session.pending?.threadId === threadId) {
          const { pending: _done, ...rest } = session;
          sessions[nodeId] = rest;
        } else {
          sessions[nodeId] = session;
        }
      }
      return { streams, sessions };
    }),
  reset: () => set({ sessions: {}, streams: {} }),
}));

/** One node's session, never undefined. */
export const sessionOf = (nodeId: string): NodeSession =>
  useChatSessions.getState().sessions[nodeId] ?? {};
