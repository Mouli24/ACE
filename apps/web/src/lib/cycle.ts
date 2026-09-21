import type { Edge } from '@ace/contracts';

/**
 * Would a plain `data` edge from `fromNodeId` to `toNodeId` close a cycle (FR-CON-003)?
 * Depth-first search from the target along existing data edges; reaching the source means the
 * new edge would complete a loop. Loop edges do not count — they are the sanctioned way to go
 * back (D3) and are refused with `not_implemented` by the round 1 engine anyway.
 */
export function wouldCloseCycle(
  edges: readonly Edge[],
  fromNodeId: string,
  toNodeId: string,
): boolean {
  if (fromNodeId === toNodeId) return true;

  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'data') continue;
    const list = next.get(edge.from.nodeId) ?? [];
    list.push(edge.to.nodeId);
    next.set(edge.from.nodeId, list);
  }

  const seen = new Set<string>();
  const stack = [toNodeId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === fromNodeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of next.get(current) ?? []) stack.push(target);
  }
  return false;
}
