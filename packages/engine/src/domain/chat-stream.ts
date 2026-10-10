import {
  NodeStatePayloadSchema,
  NodeTokenPayloadSchema,
  type DomainMessage,
  type DomainStreamFrame,
  type Id,
  type PricingTable,
} from '@ace/contracts';

import type { EngineEvent, Unsubscribe } from '../ports/index.js';
import type { DomainContext } from './context.js';
import { filterForNode } from './project-chat.js';
import { usageSnapshot } from './project-usage.js';
import { createDomainProjection } from './projection.js';

/**
 * One SSE connection to a run's conversation (D314).
 *
 * It subscribes first, then backfills from the log, then goes live, so nothing that lands between
 * the two is lost; whatever the backfill already sent is dropped by seq when it arrives live. The
 * events up to `after` (the last id the client saw) are folded in silently, so a reconnect
 * carries on from there. Every frame an event produces goes out together, and the last one carries
 * the event's seq as its id. Live tokens (`turn.token`) have no id: a reconnect skips them, and the
 * turn's message carries what they said.
 */

export type ChatStreamWrite = (
  frame: (DomainStreamFrame & { id?: string }) | { comment: string },
) => Promise<void>;

export interface ChatStreamSource {
  context: DomainContext;
  /** The run's whole log, in seq order. */
  events(): Promise<EngineEvent[]>;
  subscribe(handler: (event: EngineEvent) => void): Promise<Unsubscribe>;
  pricing(): PricingTable;
}

export interface ChatStreamOptions {
  /** The last seq the client has; 0 for everything. */
  after: number;
  /** A lens (D5): only this node's messages. */
  node?: Id;
  /** How long a quiet stream waits before a keep-alive comment. */
  keepAliveMs?: number;
}

/** Events after which the team panel's numbers may have moved. */
const USAGE_EVENTS: ReadonlySet<string> = new Set([
  'usage.updated',
  'run.token_budget',
  'run.config',
  'node.state',
  'node.output',
  'run.blocked',
  'run.parked',
  'run.completed',
]);

export const KEEP_ALIVE_MS = 15_000;

export async function pumpChatStream(
  source: ChatStreamSource,
  options: ChatStreamOptions,
  write: ChatStreamWrite,
  signal: AbortSignal,
): Promise<void> {
  const queue: EngineEvent[] = [];
  let wake: (() => void) | undefined;
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  const unsubscribe = await source.subscribe((event) => {
    if (event.runId !== source.context.runId) return;
    queue.push(event);
    wake?.();
  });

  const projection = createDomainProjection(source.context);
  /** Which node each turn belongs to, so a token can name its speaker. */
  const nodeOfTurn = new Map<Id, Id>();
  const inLens = (message: DomainMessage): boolean =>
    options.node === undefined || filterForNode([message], options.node).length > 0;

  const note = (event: EngineEvent): void => {
    if (event.type !== 'node.state') return;
    const parsed = NodeStatePayloadSchema.safeParse(event.payload);
    if (parsed.success) nodeOfTurn.set(parsed.data.nodeRunId, parsed.data.nodeId);
  };

  /** Sends what one event changed; says whether the usage may have moved. */
  const send = async (event: EngineEvent): Promise<boolean> => {
    if (event.transient === true) {
      if (event.type !== 'node.token') return false;
      const parsed = NodeTokenPayloadSchema.safeParse(event.payload);
      const nodeId = parsed.success ? nodeOfTurn.get(parsed.data.nodeRunId) : undefined;
      if (!parsed.success || nodeId === undefined) return false;
      if (options.node !== undefined && options.node !== nodeId) return false;
      await write({
        event: 'turn.token',
        data: { nodeRunId: parsed.data.nodeRunId, nodeId, delta: parsed.data.delta },
      });
      return false;
    }
    note(event);
    const ops = projection.apply(event).filter((op) => inLens(op.message));
    for (const [index, op] of ops.entries()) {
      await write({
        event: op.op === 'append' ? 'chat.message' : 'chat.update',
        data: { message: op.message },
        ...(index === ops.length - 1 ? { id: String(event.seq) } : {}),
      });
    }
    return USAGE_EVENTS.has(event.type);
  };

  const snapshot = (): Promise<void> =>
    write({
      event: 'usage.snapshot',
      data: { snapshot: usageSnapshot(projection, source.context, source.pricing()) },
    });

  try {
    for (const event of await source.events()) {
      if (signal.aborted) return;
      if (event.seq <= options.after) {
        note(event);
        projection.apply(event);
        continue;
      }
      await send(event);
    }
    await snapshot();

    while (!signal.aborted) {
      if (queue.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, options.keepAliveMs ?? KEEP_ALIVE_MS);
        });
        clearTimeout(timer);
        wake = undefined;
        if (queue.length === 0 && !signal.aborted) await write({ comment: 'keep-alive' });
        continue;
      }
      let usageMoved = false;
      for (const event of queue.splice(0)) {
        // Already sent by the backfill, or by an earlier batch.
        if (event.transient !== true && event.seq <= projection.lastSeq()) continue;
        usageMoved = (await send(event)) || usageMoved;
      }
      if (usageMoved) await snapshot();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}
