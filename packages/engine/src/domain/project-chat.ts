import type { DomainMessage, Id } from '@ace/contracts';

import type { EngineEvent } from '../ports/index.js';
import type { DomainContext } from './context.js';
import { createDomainProjection } from './projection.js';

/**
 * `projectChat(events) → messages` (D303): a run's conversation, from its event log alone. Pure
 * and deterministic — the same events give the same messages, in the same order, with the same
 * cursors — so it is what the HTTP page, the SSE stream and the replay script all read.
 */
export function projectChat(
  events: readonly EngineEvent[],
  context: DomainContext,
): DomainMessage[] {
  const projection = createDomainProjection(context);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) projection.apply(event);
  return projection.messages();
}

/**
 * One node's view of the conversation (D5): the messages it sent, the messages addressed to it, and
 * the envelopes it is on either end of. A system message about a node counts as that node's.
 */
export function filterForNode(messages: readonly DomainMessage[], nodeId: Id): DomainMessage[] {
  return messages.filter(
    (message) =>
      message.author.nodeId === nodeId ||
      (message.to?.includes(nodeId) ?? false) ||
      message.envelope?.from === nodeId,
  );
}
