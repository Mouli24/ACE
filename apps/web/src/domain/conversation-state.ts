import type { DomainMessage, DomainStreamFrame, DomainUsageSnapshot } from '@ace/contracts';

/**
 * The conversation as the page holds it (D9, D314): the server projects, the web only folds what
 * it is sent — `chat.message` appends, `chat.update` replaces by id, `usage.snapshot` replaces the
 * numbers, and `turn.token` collects a running turn's text until its message says it ended.
 */
export interface ConversationState {
  byId: ReadonlyMap<string, DomainMessage>;
  usage: DomainUsageSnapshot | null;
  /** Live text per turn (node run id), while the turn is still going. */
  tokens: Readonly<Record<string, string>>;
}

export const initialConversation = (): ConversationState => ({
  byId: new Map(),
  usage: null,
  tokens: {},
});

export function fromPage(messages: readonly DomainMessage[]): ConversationState {
  return {
    ...initialConversation(),
    byId: new Map(messages.map((message) => [message.id, message])),
  };
}

export function applyFrame(state: ConversationState, frame: DomainStreamFrame): ConversationState {
  switch (frame.event) {
    case 'chat.message':
    case 'chat.update': {
      const { message } = frame.data;
      const byId = new Map(state.byId);
      byId.set(message.id, message);
      const turnId = message.turn?.turnId;
      if (
        turnId === undefined ||
        message.turn?.outcome === 'RUNNING' ||
        !(turnId in state.tokens)
      ) {
        return { ...state, byId };
      }
      const { [turnId]: _done, ...tokens } = state.tokens;
      return { ...state, byId, tokens };
    }
    case 'usage.snapshot':
      return { ...state, usage: frame.data.snapshot };
    case 'turn.token': {
      const { nodeRunId, delta } = frame.data;
      return {
        ...state,
        tokens: { ...state.tokens, [nodeRunId]: `${state.tokens[nodeRunId] ?? ''}${delta}` },
      };
    }
    default:
      return state;
  }
}

const cursorOf = (message: DomainMessage): [number, number] => {
  const [seq = 0, index = 0] = message.cursor.split('.').map(Number);
  return [seq, index];
};

/** The messages in cursor order: `seq`, then the place among the messages one event made. */
export function orderedMessages(state: ConversationState): DomainMessage[] {
  return [...state.byId.values()].sort((a, b) => {
    const [aSeq, aIndex] = cursorOf(a);
    const [bSeq, bIndex] = cursorOf(b);
    return aSeq - bSeq || aIndex - bIndex;
  });
}
