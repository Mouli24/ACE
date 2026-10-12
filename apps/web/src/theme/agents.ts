import { isAddressableNode, type Node } from '@ace/contracts';

import { agentColor } from './constants';
import { initial } from './format';

/*
 * "Agents" in the Ace UI theme are ACE's addressable nodes — Agent and Model nodes — in graph
 * order. Their colour is assigned by that order (`#ef6b3f`, `#7a62d6`, `#1f97a3`, repeating), so a
 * node keeps one colour in the header, the canvas, Forge, chat and Domain (D328).
 */

export interface AgentLook {
  nodeId: string;
  name: string;
  letter: string;
  color: string;
  /** 0-based position among the workflow's agents. */
  index: number;
}

/** The workflow's agents in graph order, each with its letter and colour. */
export function agentsOf(nodes: readonly Node[]): AgentLook[] {
  return nodes.filter(isAddressableNode).map((node, index) => ({
    nodeId: node.id,
    name: node.name,
    letter: initial(node.name),
    color: agentColor(index),
    index,
  }));
}

/** Node id → agent look, for lookups by id. */
export function agentMap(nodes: readonly Node[]): Map<string, AgentLook> {
  return new Map(agentsOf(nodes).map((agent) => [agent.nodeId, agent]));
}
