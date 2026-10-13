import { resolveChatTarget, type RosterEntry } from '@ace/contracts';

/**
 * Who a chat message goes to (D302). One `@handle` brings that node of the workflow into the
 * conversation; no handle goes to the conversation's main node. The decision is the engine's own
 * `resolveChatTarget`, so the composer's "to <Node>" is exactly what the engine will do, and a
 * message the engine would refuse is one the composer will not send. The session never switches:
 * the main node changes only when the person picks another node.
 */

export interface ChatTargetPreview {
  canSend: boolean;
  /** The node that will answer. */
  targetNodeId?: string;
  name?: string;
  /** Why it cannot go. */
  error?: string;
}

export function previewChatTarget(
  text: string,
  roster: readonly RosterEntry[],
  mainNodeId: string,
): ChatTargetPreview {
  const target = resolveChatTarget(text, roster, mainNodeId);
  if (target.error !== undefined) return { canSend: false, error: target.error };
  const name = roster.find((entry) => entry.nodeId === target.targetNodeId)?.name;
  return {
    canSend: true,
    targetNodeId: target.targetNodeId,
    ...(name === undefined ? {} : { name }),
  };
}

/** The `@partial` the caret sits at the end of, if any — never inside a word or an address. */
export function handlePartial(
  text: string,
  caret: number,
): { start: number; partial: string } | undefined {
  const match = /(^|\s)@([a-z0-9-]*)$/iu.exec(text.slice(0, caret));
  if (match === null) return undefined;
  const partial = match[2] ?? '';
  return { start: caret - partial.length - 1, partial: partial.toLowerCase() };
}

/** The roster entries an `@partial` could mean: by handle prefix, or by a word of the name. */
export function handleOptions<T extends RosterEntry>(roster: readonly T[], partial: string): T[] {
  return roster.filter(
    (entry) => entry.handle.startsWith(partial) || entry.name.toLowerCase().includes(partial),
  );
}

/** Replace the `@partial` with the chosen handle and a space; the caret lands after it. */
export function completeHandle(
  text: string,
  at: { start: number; partial: string },
  caret: number,
  handle: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, at.start)}@${handle} ${text.slice(caret)}`;
  return { text: next, caret: at.start + handle.length + 2 };
}
