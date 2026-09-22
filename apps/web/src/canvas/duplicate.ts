import { derivePorts, type Node } from '@ace/contracts';

import { newId } from '../lib/ulid';

export const DUPLICATE_OFFSET = 40;

/** FR-CAN-006: copies with fresh ids, deep-copied config, offset so they are visibly separate. */
export function duplicateNodes(nodes: readonly Node[]): Node[] {
  return nodes.map((node) => {
    const copy = {
      ...node,
      id: newId(),
      config: structuredClone(node.config),
      position: { x: node.position.x + DUPLICATE_OFFSET, y: node.position.y + DUPLICATE_OFFSET },
    } as Node;
    return { ...copy, ...derivePorts(copy) } as Node;
  });
}
