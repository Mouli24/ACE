import {
  DEFAULT_DEBATE_ROUNDS,
  debateRoleOf,
  debateSides,
  validateDebateEdge,
  type DebateConfig,
  type DebateRole,
  type Edge,
  type Node,
} from '@ace/contracts';

/*
 * Debate on a connection (D405): what the connection's menu offers. A data edge between two Agents
 * can be set to debate; once it is, the menu sets its rounds and its judge. The rules are the
 * contract's `validateDebateEdge`, so the menu never offers what the engine would refuse.
 */

export interface DebateJudgeOption {
  id: string;
  name: string;
  role?: DebateRole;
}

export interface DebateMenu {
  /** The edge's debate, when it has one. */
  current?: DebateConfig;
  /** Why this edge cannot debate; absent when it can. */
  refused?: string;
  /** The Agents that could judge it: every other Agent, preset Judges first. */
  judges: DebateJudgeOption[];
}

const speaks = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

export function debateMenuFor(
  nodes: readonly Node[],
  edges: readonly Edge[],
  edgeId: string,
): DebateMenu {
  const edge = edges.find((each) => each.id === edgeId);
  if (edge === undefined) return { refused: 'That connection is gone.', judges: [] };
  const check = validateDebateEdge({ ...edge, debate: { rounds: DEFAULT_DEBATE_ROUNDS } }, nodes);
  const judges = nodes
    .filter((node) => speaks(node) && node.id !== edge.from.nodeId && node.id !== edge.to.nodeId)
    .map((node): DebateJudgeOption => {
      const role = debateRoleOf(node);
      return { id: node.id, name: node.name, ...(role === undefined ? {} : { role }) };
    })
    .sort((a, b) => Number(b.role === 'judge') - Number(a.role === 'judge'));
  return {
    ...(edge.debate === undefined ? {} : { current: edge.debate }),
    ...(check.ok ? {} : { refused: check.reason }),
    judges,
  };
}

/**
 * The debate a connection starts with: three rounds, judged by the workflow's preset Judge when it
 * has exactly one that is not already a debater.
 */
export function newDebate(menu: DebateMenu): DebateConfig {
  const presets = menu.judges.filter((judge) => judge.role === 'judge');
  const [only] = presets;
  return {
    rounds: DEFAULT_DEBATE_ROUNDS,
    ...(presets.length === 1 && only !== undefined ? { judgeNodeId: only.id } : {}),
  };
}

/** The chip's words for a debate edge, `debate · 3`; a judge shows as a gavel beside them. */
export function debateChipLabel(debate: DebateConfig): string {
  return `debate · ${debate.rounds}`;
}

/**
 * What a node's chat says about `@debate` (D405): who would debate — the Defender and the Attacker
 * as its debate edge seats them, the rounds, and the judge — or why the node cannot.
 */
export function chatDebateFor(
  nodeId: string,
  nodes: readonly Node[],
  edges: readonly Edge[],
): { ready: string } | { blocked: string } {
  const node = nodes.find((each) => each.id === nodeId);
  const edge = edges.find(
    (each) =>
      each.debate !== undefined && (each.from.nodeId === nodeId || each.to.nodeId === nodeId),
  );
  if (edge?.debate === undefined) {
    return {
      blocked: `${node?.name ?? 'This node'} has no debate connection. Open the menu on its connection to another agent and choose Debate.`,
    };
  }
  const nameOf = (id: string): string => nodes.find((each) => each.id === id)?.name ?? 'an agent';
  const sides = debateSides(edge, (id) => {
    const each = nodes.find((other) => other.id === id);
    return each === undefined ? undefined : debateRoleOf(each);
  });
  const { rounds, judgeNodeId } = edge.debate;
  const judge =
    judgeNodeId === undefined ? undefined : nodes.find((each) => each.id === judgeNodeId);
  return {
    ready:
      `${nameOf(sides.defenderId)} ⇄ ${nameOf(sides.attackerId)}, ${rounds} round${rounds === 1 ? '' : 's'}` +
      (judge === undefined ? '' : `, ${judge.name} judges`),
  };
}
