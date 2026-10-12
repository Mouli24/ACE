import { isAddressableNode, type Id, type Node, type NodeState } from '@ace/contracts';

import { agentMap } from '../theme/agents';
import { agentColor } from '../theme/constants';
import { initial } from '../theme/format';

/*
 * How Domain dresses its participants in the Ace UI theme (D328, D336): each agent's colour and
 * letter — the same ones the canvas and Forge use, by graph order — its model, and the Team
 * aside's status pills.
 */

export interface DomainLook {
  color: string;
  letter: string;
  /** The node's configured model id; undefined when it has none. */
  model: string | undefined;
}

export type DomainLooks = ReadonlyMap<Id, DomainLook>;

/** Every agent and model node of a run's snapshot, by id. */
export function domainLooks(nodes: readonly Node[]): Map<Id, DomainLook> {
  const agents = agentMap(nodes);
  return new Map(
    nodes.filter(isAddressableNode).map((node, index): [Id, DomainLook] => {
      const agent = agents.get(node.id);
      return [
        node.id,
        {
          color: agent?.color ?? agentColor(index),
          letter: agent?.letter ?? initial(node.name),
          model: node.config.modelId,
        },
      ];
    }),
  );
}

/** A node's look, or — for one the snapshot does not know — its place's colour and its initial. */
export function lookOf(
  looks: DomainLooks | undefined,
  nodeId: Id,
  name: string,
  index: number,
): DomainLook {
  return (
    looks?.get(nodeId) ?? { color: agentColor(index), letter: initial(name), model: undefined }
  );
}

/** A status pill in the Team aside: its word, fill and ink, and whether its dot pulses. */
export interface StatusPill {
  label: string;
  bg: string;
  ink: string;
  pulse: boolean;
}

const WORKING: StatusPill = {
  label: 'Working',
  bg: 'rgba(239,107,63,0.14)',
  ink: '#e8572e',
  pulse: true,
};
const WAITING: StatusPill = {
  label: 'Waiting',
  bg: 'var(--hover)',
  ink: 'var(--muted)',
  pulse: false,
};

const PILLS: Record<NodeState, StatusPill> = {
  RUNNING: WORKING,
  IDLE: WAITING,
  READY: WAITING,
  WAITING,
  PAUSED: WAITING,
  COMPLETED: { label: 'Done', bg: 'rgba(47,158,99,0.14)', ink: '#2f9e63', pulse: false },
  FAILED: { label: 'Failed', bg: 'var(--hover)', ink: '#c94c27', pulse: false },
  BLOCKED: { label: 'Blocked', bg: 'var(--hover)', ink: '#c94c27', pulse: false },
  STOPPED: { label: 'Stopped', bg: 'var(--hover)', ink: 'var(--muted)', pulse: false },
};

export function statusPill(state: NodeState): StatusPill {
  return PILLS[state];
}

/** A duration as the theme writes it: whole seconds, `4s`. */
export function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** `1 step`, `3 steps`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
