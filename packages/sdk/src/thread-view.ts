import { isPersistedFrame, type ChatMessage, type Id, type ServerFrame } from '@ace/contracts';

/**
 * The direct-chat counterpart of `RunEventBuffer` (round 4 §2.3/§2.5, FR-CHAT-004/006/008). It
 * folds one thread's `chat.token` and `chat.message` frames into something a chat panel can render:
 * the turns that have settled, and the assistant reply still streaming in.
 *
 * The two frames mirror `node.token`/`node.output`. `chat.token` is transient — no `seq`, never
 * replayed — so its deltas are appended as they arrive and build the streaming reply. `chat.message`
 * is persisted, so it is idempotent under a `resume` replay, and when it is the agent's turn it is
 * the streamed text settling: the stream buffer clears and the message joins the settled list.
 * `chat.update` (PG-1.6, D352) is persisted too: it replaces a settled row by id, or drops it when
 * the row was deleted.
 */
export interface ThreadView {
  /** The thread these frames belong to; set from the constructor or the first frame seen. */
  threadId: Id | undefined;
  /** The highest persisted seq folded in; what `resume { afterSeq }` should ask from. */
  lastSeq: number;
  /** The settled turns, in arrival order — user turns and agent replies (FR-CHAT-006). */
  messages: ChatMessage[];
  /** The assistant text streamed since the last settled reply; `''` when nothing is streaming. */
  streamingText: string;
  /** `true` between the first `chat.token` and the `chat.message` that settles the reply. */
  streaming: boolean;
}

export class ThreadEventBuffer {
  private threadId: Id | undefined;
  private lastSeq = -1;
  private readonly seen = new Set<number>();
  private readonly messages: ChatMessage[] = [];
  private streamingText = '';
  private streaming = false;

  /**
   * Seeding the thread id lets one socket feed several open chat panels: each buffer keeps only its
   * own thread's frames, from the very first one, rather than latching onto whichever arrives first.
   */
  constructor(threadId?: Id) {
    this.threadId = threadId;
  }

  /** Fold one frame in. Non-thread frames, other threads' frames, and replays are ignored. */
  apply(frame: ServerFrame): void {
    if (
      frame.type !== 'chat.token' &&
      frame.type !== 'chat.message' &&
      frame.type !== 'chat.update'
    ) {
      return;
    }

    const incoming = frame.payload.threadId;
    if (this.threadId !== undefined && incoming !== this.threadId) return;
    this.threadId ??= incoming;

    if (frame.type === 'chat.token') {
      this.streamingText += frame.payload.delta;
      this.streaming = true;
      return;
    }

    // `chat.message` is persisted: a `resume` replay can deliver the same seq twice.
    if (isPersistedFrame(frame)) {
      if (this.seen.has(frame.seq)) return;
      this.seen.add(frame.seq);
      if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
    }

    if (frame.type === 'chat.update') {
      // PG-1.6 (D352): an existing turn changed. A deleted one leaves the view; any other change
      // (superseded by a retry or an edit) replaces the row where it stands.
      const changed = frame.payload.message;
      const at = this.messages.findIndex((message) => message.id === changed.id);
      if (changed.deletedAt !== undefined) {
        if (at >= 0) this.messages.splice(at, 1);
      } else if (at >= 0) {
        this.messages[at] = changed;
      }
      return;
    }

    this.messages.push(frame.payload.message);
    // An agent turn is the streamed reply settling; a user echo leaves any live stream alone.
    if (frame.payload.message.role === 'agent') {
      this.streamingText = '';
      this.streaming = false;
    }
  }

  /** Forget everything; the next thread starts from nothing. */
  reset(): void {
    this.threadId = undefined;
    this.lastSeq = -1;
    this.seen.clear();
    this.messages.length = 0;
    this.streamingText = '';
    this.streaming = false;
  }

  get view(): ThreadView {
    return {
      threadId: this.threadId,
      lastSeq: this.lastSeq,
      messages: [...this.messages],
      streamingText: this.streamingText,
      streaming: this.streaming,
    };
  }
}
