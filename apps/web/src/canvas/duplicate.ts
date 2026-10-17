import { derivePorts, type Node } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { copyNodeName } from '../nodes/factory';
import { freeSlotNear } from './placement';

/** How far a copy starts from its original before a free slot is looked for (FR-CAN-006). */
export const DUPLICATE_OFFSET = 40;

/**
 * FR-CAN-006: copies with fresh ids, deep-copied config, placed where they do not cover the node
 * they came from — a copy sitting on top of the original hides its ports and makes the original
 * unclickable.
 */
export function duplicateNodes(nodes: readonly Node[], existing: readonly Node[] = nodes): Node[] {
  const placed = [...existing];
  return nodes.map((node) => {
    const position = freeSlotNear(placed, {
      x: node.position.x + DUPLICATE_OFFSET,
      y: node.position.y + DUPLICATE_OFFSET,
    });
    const copy = {
      ...node,
      id: newId(),
      // "<name> copy", numbered when the workflow already has one: no two nodes share a name
      name: copyNodeName(
        node.name,
        placed.map((each) => each.name),
      ),
      config: structuredClone(node.config),
      position,
    } as Node;
    const withPorts = { ...copy, ...derivePorts(copy) } as Node;
    placed.push(withPorts);
    return withPorts;
  });
}
