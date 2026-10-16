import type { DomainMessage, DomainStreamFrame } from '@ace/contracts';

/**
 * The conversation as the page holds it (D9, D314): the server projects, the web only folds what
 * it is sent — `chat.message` appends, `chat.update` replaces by id, and `turn.token` collects a
 * running turn's text until its message says it ended. PG-3.3: messages only — node states and
 * tokens are the run overlay's, and the usage snapshot is kept beside this, not in it.
 */
export interface ConversationState {
  byId: ReadonlyMap<string, DomainMessage>;
  /** Live text per turn (node run id), while the turn is still going. */
  tokens: Readonly<Record<string, string>>;
}

export const initialConversation = (): ConversationState => ({
  byId: new Map(),
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
    case 'turn.token': {
      const { nodeRunId, delta } = frame.data;
      return {
        ...state,
        tokens: { ...state.tokens, [nodeRunId]: `${state.tokens[nodeRunId] ?? ''}${delta}` },
      };
    }
    default:
      // `usage.snapshot` is not the conversation's: the hook keeps it beside the messages.
      return state;
  }
}

const cursorOf = (message: DomainMessage): [number, number] => {
  const [seq = 0, index = 0] = message.cursor.split('.').map(Number);
  return [seq, index];
};

/** The messages in cursor order: `seq`, then the place among the messages one event made. */
export function orderedMessages(state: Pick<ConversationState, 'byId'>): DomainMessage[] {
  return [...state.byId.values()].sort((a, b) => {
    const [aSeq, aIndex] = cursorOf(a);
    const [bSeq, bIndex] = cursorOf(b);
    return aSeq - bSeq || aIndex - bIndex;
  });
}
