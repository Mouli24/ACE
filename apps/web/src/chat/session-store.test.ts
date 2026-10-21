import type { ChatMessage } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { owedTurns, oweTurn, sessionOf, useChatSessions, type PendingTurn } from './session-store';

/*
 * D391 (W1-4): chat queue state per message. The engine holds a second turn in its per-project
 * write queue and answers the turns in order; each sent message keeps its own waiting state until
 * the reply that answers it lands — never the first reply settling the whole thread.
 */

const NODE = '01NODE000000000000000000000';
const THREAD = '01THREAD0000000000000000000';
const OTHER_THREAD = '01THREAD0000000000000000001';

/** A user turn the engine took, with the monotonic id the engine gives it. */
function sent(threadId = THREAD): PendingTurn {
  const userMessage: ChatMessage = {
    id: newId(),
    threadId,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    verdicts: [],
    at: new Date().toISOString(),
  };
  return { threadId, userMessage, speakerNodeId: NODE, since: Date.now() };
}

/** What a send writes: the turn owed after whatever the session owes already. */
const send = (turn: PendingTurn) =>
  useChatSessions.getState().update(NODE, (session) => oweTurn(session, turn));

/** An agent reply landing on the thread: `chat.message` with a fresh (later) id. */
const reply = (threadId = THREAD) => useChatSessions.getState().settleReply(threadId, newId());

const owed = () => owedTurns(sessionOf(NODE));

beforeEach(() => useChatSessions.getState().reset());

describe('D391 chat queue state per message', () => {
  it('two sends, then one reply: the second is still pending', () => {
    const first = sent();
    const second = sent();
    send(first);
    send(second);
    expect(owed().map((turn) => turn.userMessage.id)).toEqual([
      first.userMessage.id,
      second.userMessage.id,
    ]);

    reply();

    expect(owed().map((turn) => turn.userMessage.id)).toEqual([second.userMessage.id]);
    // the one still owed is now the session's pending turn: the composer keeps its Stop
    expect(sessionOf(NODE).pending?.userMessage.id).toBe(second.userMessage.id);
    expect(sessionOf(NODE).queued).toBeUndefined();
  });

  it('two sends, then two replies: none pending', () => {
    send(sent());
    send(sent());
    reply();
    reply();
    expect(owed()).toEqual([]);
    expect(sessionOf(NODE).pending).toBeUndefined();
  });

  it('the turn left waiting expects a reply after the one that settled the turn before it', () => {
    const first = sent();
    const second = sent();
    send(first);
    send(second);
    const replyId = newId();
    useChatSessions.getState().settleReply(THREAD, replyId);
    // read back later, the first turn's reply is never taken for the second's
    expect(sessionOf(NODE).pending?.afterId).toBe(replyId);
  });

  it('a reply from before every owed turn (an earlier turn landing late) settles none', () => {
    const late = newId();
    send(sent());
    useChatSessions.getState().settleReply(THREAD, late);
    expect(owed()).toHaveLength(1);
  });

  it('a reply settles a turn on its own thread only', () => {
    send(sent(OTHER_THREAD));
    send(sent());
    reply(THREAD);
    expect(owed().map((turn) => turn.threadId)).toEqual([OTHER_THREAD]);
  });

  it('the reply ends its thread’s stream; the next one streams afresh', () => {
    send(sent());
    send(sent());
    useChatSessions.getState().appendToken(THREAD, 'first answer');
    reply();
    expect(useChatSessions.getState().streams[THREAD]).toBeUndefined();
  });

  it('settleThread (nothing was in flight) settles every turn owed on that thread', () => {
    send(sent());
    send(sent());
    send(sent(OTHER_THREAD));
    useChatSessions.getState().settleThread(THREAD);
    expect(owed().map((turn) => turn.threadId)).toEqual([OTHER_THREAD]);
  });
});
