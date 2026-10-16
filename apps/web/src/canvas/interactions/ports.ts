import type { Node, Port } from '@ace/contracts';

import type { ConnectionAttempt } from '../connect';

/**
 * PG-1.1 (D350): the pure half of drawing a connection by hand — which ports a line being drawn may
 * end on, the input a line dropped on a card body lands on, the pairs "Connect to…" offers, and
 * when a press on a card is a click rather than a drag. The Canvas supplies `check`, its one rule
 * for a connection (the contract's, plus the loop-edge offer), so these never second-guess it.
 */

/** Whether a drawn connection may be made, and why not. */
export type PortVerdict = { ok: true } | { ok: false; reason: string };
export type CheckConnection = (attempt: ConnectionAttempt) => PortVerdict;

/** Where a line is being drawn from: the node, the port and which side it is. */
export interface ConnectFrom {
  nodeId: string;
  portId: string;
  /** React Flow's handle type: `source` is an output, `target` an input. */
  type: 'source' | 'target';
}

/** How each port shows while a line is drawn (D350). */
export type PortConnectState =
  { look: 'source' } | { look: 'compatible' } | { look: 'incompatible'; reason: string };

/** The attempt a line from `from` ending on `port` of `nodeId` would be, whichever way it is drawn. */
function attemptTo(from: ConnectFrom, nodeId: string, portId: string): ConnectionAttempt {
  return from.type === 'source'
    ? { source: from.nodeId, sourceHandle: from.portId, target: nodeId, targetHandle: portId }
    : { source: nodeId, sourceHandle: portId, target: from.nodeId, targetHandle: from.portId };
}

/**
 * Every port's look while a line is drawn from `from`: the start port is the source, a port on the
 * other side of another node is compatible or incompatible (with the reason), and a port on the same
 * side as the start is left out — it is no place to drop.
 */
export function portConnectStates(
  nodes: readonly Node[],
  from: ConnectFrom,
  check: CheckConnection,
): Map<string, PortConnectState> {
  const states = new Map<string, PortConnectState>();
  states.set(from.portId, { look: 'source' });
  for (const node of nodes) {
    if (node.id === from.nodeId) continue;
    const candidates = from.type === 'source' ? node.inputs : node.outputs;
    for (const port of candidates) {
      const verdict = check(attemptTo(from, node.id, port.id));
      states.set(
        port.id,
        verdict.ok ? { look: 'compatible' } : { look: 'incompatible', reason: verdict.reason },
      );
    }
  }
  return states;
}

/** One way to make the connection: the attempt and the two ports it joins. */
export interface ConnectChoice {
  attempt: ConnectionAttempt;
  from: Port;
  to: Port;
}

/** The outcome of dropping a line on a card, or picking a node in "Connect to…". */
export type DropOutcome =
  | { kind: 'connect'; choice: ConnectChoice }
  | { kind: 'choose'; choices: ConnectChoice[] }
  | { kind: 'refuse'; reason: string };

function outcomeOf(choices: ConnectChoice[], refusal: string | undefined, fallback: string) {
  if (choices.length === 1 && choices[0] !== undefined)
    return { kind: 'connect', choice: choices[0] } as const;
  if (choices.length > 1) return { kind: 'choose', choices } as const;
  return { kind: 'refuse', reason: refusal ?? fallback } as const;
}

/**
 * A line dropped on a card body (D350): an output dropped on a card goes to the card's first
 * compatible input — or, when more than one fits, a chooser; an input dropped on a card takes the
 * card's compatible outputs the same way. None fits: refused with the first input's reason.
 */
export function dropOnCard(
  nodes: readonly Node[],
  from: ConnectFrom,
  cardNodeId: string,
  check: CheckConnection,
): DropOutcome {
  const card = nodes.find((node) => node.id === cardNodeId);
  const start = nodes.find((node) => node.id === from.nodeId);
  const startPort = (from.type === 'source' ? start?.outputs : start?.inputs)?.find(
    (port) => port.id === from.portId,
  );
  if (card === undefined || startPort === undefined || card.id === from.nodeId) {
    return { kind: 'refuse', reason: 'Drop the line on another node.' };
  }
  const ports = from.type === 'source' ? card.inputs : card.outputs;
  const choices: ConnectChoice[] = [];
  let refusal: string | undefined;
  for (const port of ports) {
    const attempt = attemptTo(from, card.id, port.id);
    const verdict = check(attempt);
    if (verdict.ok) {
      choices.push(
        from.type === 'source'
          ? { attempt, from: startPort, to: port }
          : { attempt, from: port, to: startPort },
      );
    } else {
      refusal ??= verdict.reason;
    }
  }
  return outcomeOf(
    choices,
    refusal,
    `${card.name || 'That node'} has no ${from.type === 'source' ? 'input' : 'output'} to connect to.`,
  );
}

/**
 * "Connect to…" (D350): every output of `fromNodeId` paired with every input of `toNodeId` that
 * the rule accepts — one is made at once, several are offered, none is refused with a reason.
 */
export function connectChoices(
  nodes: readonly Node[],
  fromNodeId: string,
  toNodeId: string,
  check: CheckConnection,
): DropOutcome {
  const from = nodes.find((node) => node.id === fromNodeId);
  const to = nodes.find((node) => node.id === toNodeId);
  if (from === undefined || to === undefined || from.id === to.id) {
    return { kind: 'refuse', reason: 'Pick another node to connect to.' };
  }
  const choices: ConnectChoice[] = [];
  let refusal: string | undefined;
  for (const output of from.outputs) {
    for (const input of to.inputs) {
      const attempt: ConnectionAttempt = {
        source: from.id,
        sourceHandle: output.id,
        target: to.id,
        targetHandle: input.id,
      };
      const verdict = check(attempt);
      if (verdict.ok) choices.push({ attempt, from: output, to: input });
      else refusal ??= verdict.reason;
    }
  }
  return outcomeOf(
    choices,
    refusal,
    `${from.name || 'This node'} has no output that ${to.name || 'that node'} can take.`,
  );
}

/** D350: a press that moved more than this many pixels before its release is a drag, not a click. */
export const CLICK_SLOP_PX = 4;

/** Whether a release at `up` after a press at `down` is a click (moved ≤ 4 px). */
export function isClick(
  down: { x: number; y: number } | undefined,
  up: { x: number; y: number },
): boolean {
  if (down === undefined) return true;
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP_PX;
}

/**
 * What a press or click landed on that is the card itself — not a port, not one of the card's own
 * buttons or menus, not what hangs under the card. Only such a click opens the node's settings.
 */
export function isCardBody(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return (
    target.closest('[data-node-card]') !== null &&
    target.closest('.react-flow__handle') === null &&
    target.closest('button, a, input, textarea, select, [role="menu"], [role="menuitem"]') === null
  );
}

/** A port as a person reads it: `text input "in"`. */
export function portLabel(port: Port, direction: 'in' | 'out'): string {
  return `${port.dataType} ${direction === 'in' ? 'input' : 'output'} “${port.name}”`;
}
