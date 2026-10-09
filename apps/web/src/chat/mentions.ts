/**
 * `@mentions` in the chat composer (FR-CHAT-004). Pure, so the picker and the send path agree on
 * what was mentioned. Node names can have spaces ("Draft writer"), so a mention is matched against
 * the names that exist, longest first, rather than cut at the first space.
 */

export interface Mentionable {
  id: string;
  name: string;
}

/** The `@word` being typed at the end of the text, lower-cased; undefined when none is open. */
export function mentionQuery(text: string): string | undefined {
  return /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1]?.toLowerCase();
}

/** The nodes an open `@query` could mean, in the order given. */
export function mentionMatches<T extends Mentionable>(text: string, nodes: readonly T[]): T[] {
  const query = mentionQuery(text);
  if (query === undefined) return [];
  return nodes.filter((node) => node.name.toLowerCase().includes(query));
}

/** Replace the open `@query` at the end of the text with the chosen node's full mention. */
export function insertMention(text: string, name: string): string {
  return text.replace(/(^|\s)@[^\s@]*$/, `$1@${name} `);
}

/**
 * Who a message is addressed to, and what it says. A message that opens with `@<node name>` goes to
 * that node, and the mention is not part of what the node is sent. Anything else is for whoever
 * the chat is already talking to (`node` undefined).
 */
export function parseMention<T extends Mentionable>(
  text: string,
  nodes: readonly T[],
): { node: T | undefined; body: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('@')) return { node: undefined, body: text.trim() };

  const after = trimmed.slice(1);
  const byLength = [...nodes].sort((a, b) => b.name.length - a.name.length);
  for (const node of byLength) {
    const name = node.name;
    if (after.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const rest = after.slice(name.length);
    // "@Writer2" is not "@Writer": the name has to end at a space, punctuation or the end.
    if (rest !== '' && !/^[\s,:;.!?]/.test(rest)) continue;
    return { node, body: rest.replace(/^[\s,:;]+/, '').trim() };
  }
  return { node: undefined, body: text.trim() };
}
