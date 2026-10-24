import type { ChatDebatePayload } from '@ace/contracts';
import { create } from 'zustand';

/**
 * D405: how far each thread's debate has got, as `chat.debate` reports it — which turn is under way
 * and who speaks, then how it ended. In memory only, like the frames it folds: after a reload a
 * debate reads as finished, and its turns are the replies the thread stored.
 */
interface DebateProgressState {
  byThread: Readonly<Record<string, ChatDebatePayload>>;
  report(payload: ChatDebatePayload): void;
}

export const useDebateProgress = create<DebateProgressState>((set) => ({
  byThread: {},
  report: (payload) =>
    set((state) => ({ byThread: { ...state.byThread, [payload.threadId]: payload } })),
}));

/** The thread's debate while a turn of it is under way; undefined once it ended, or with none. */
export function runningDebate(
  byThread: Readonly<Record<string, ChatDebatePayload>>,
  threadId: string | undefined,
): ChatDebatePayload | undefined {
  const progress = threadId === undefined ? undefined : byThread[threadId];
  return progress?.state === 'turn' ? progress : undefined;
}
