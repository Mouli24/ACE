import { NODE_STATES, RUN_STATES, type NodeState, type RunState } from '@ace/contracts';
import { createMachine, type AnyStateMachine } from 'xstate';

/**
 * The node and run state machines, transcribed from Arch §19.1 and §19.2 (ADR: XState v5).
 *
 * The transition tables below are the diagrams, one row per drawn arrow, and the machines are
 * generated from them. That is deliberate: a hand-written machine and a diagram drift, and the
 * thing that must never drift is which transitions are *legal* — BR-03 and BR-12 depend on
 * `FAILED` being reachable only the way the diagram says it is.
 */

export const NODE_EVENTS = [
  'INPUTS_AVAILABLE',
  'UPSTREAM_FAILED',
  'DISPATCH',
  'PAUSE',
  'RESUME',
  'ASK_USER',
  'COMPLETE',
  'FAIL',
  'STOP',
  'APPROVE',
  'REJECT',
  'RETRY',
  'RERUN',
] as const;
export type NodeEventType = (typeof NODE_EVENTS)[number];

export const RUN_EVENTS = [
  'CHECKS_FAILED',
  'CHECKS_PASSED',
  'PAUSE',
  'RESUME',
  'HALT',
  'COMPLETE',
] as const;
export type RunEventType = (typeof RUN_EVENTS)[number];

export interface Transition<TState extends string, TEvent extends string> {
  from: TState;
  event: TEvent;
  to: TState;
}

/** Arch §19.1, in the order the diagram draws its arrows. */
export const NODE_TRANSITIONS: readonly Transition<NodeState, NodeEventType>[] = [
  { from: 'IDLE', event: 'INPUTS_AVAILABLE', to: 'READY' },
  { from: 'IDLE', event: 'UPSTREAM_FAILED', to: 'BLOCKED' },
  { from: 'READY', event: 'DISPATCH', to: 'RUNNING' },
  { from: 'READY', event: 'PAUSE', to: 'PAUSED' },
  { from: 'PAUSED', event: 'RESUME', to: 'READY' },
  { from: 'RUNNING', event: 'ASK_USER', to: 'WAITING' },
  { from: 'RUNNING', event: 'COMPLETE', to: 'COMPLETED' },
  { from: 'RUNNING', event: 'FAIL', to: 'FAILED' },
  { from: 'RUNNING', event: 'STOP', to: 'STOPPED' },
  { from: 'WAITING', event: 'APPROVE', to: 'RUNNING' },
  { from: 'WAITING', event: 'REJECT', to: 'FAILED' },
  { from: 'FAILED', event: 'RETRY', to: 'READY' },
  { from: 'COMPLETED', event: 'RERUN', to: 'READY' },
];

/** Arch §19.2, in the order the diagram draws its arrows. */
export const RUN_TRANSITIONS: readonly Transition<RunState, RunEventType>[] = [
  { from: 'PREFLIGHT', event: 'CHECKS_FAILED', to: 'BLOCKED' },
  { from: 'PREFLIGHT', event: 'CHECKS_PASSED', to: 'RUNNING' },
  { from: 'RUNNING', event: 'PAUSE', to: 'PAUSED' },
  { from: 'PAUSED', event: 'RESUME', to: 'RUNNING' },
  { from: 'RUNNING', event: 'HALT', to: 'HALTED' },
  { from: 'RUNNING', event: 'COMPLETE', to: 'COMPLETE' },
];

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

function index<TState extends string, TEvent extends string>(
  transitions: readonly Transition<TState, TEvent>[],
): Map<string, TState> {
  return new Map(transitions.map(({ from, event, to }) => [`${from}:${event}`, to]));
}

const NODE_INDEX = index(NODE_TRANSITIONS);
const RUN_INDEX = index(RUN_TRANSITIONS);

/** Where this event leads, or `undefined` when the diagram draws no such arrow. */
export function nextNodeState(from: NodeState, event: NodeEventType): NodeState | undefined {
  return NODE_INDEX.get(`${from}:${event}`);
}

export function nextRunState(from: RunState, event: RunEventType): RunState | undefined {
  return RUN_INDEX.get(`${from}:${event}`);
}

export function canTransitionNode(from: NodeState, event: NodeEventType): boolean {
  return NODE_INDEX.has(`${from}:${event}`);
}

export function canTransitionRun(from: RunState, event: RunEventType): boolean {
  return RUN_INDEX.has(`${from}:${event}`);
}

/* -------------------------------------------------------------------------- */
/* Machines                                                                    */
/* -------------------------------------------------------------------------- */

function machineConfig<TState extends string, TEvent extends string>(
  id: string,
  states: readonly TState[],
  transitions: readonly Transition<TState, TEvent>[],
  initial: TState,
): Parameters<typeof createMachine>[0] {
  const config: Record<string, { on?: Record<string, string> }> = {};

  for (const state of states) {
    const on: Record<string, string> = {};
    for (const transition of transitions) {
      if (transition.from === state) on[transition.event] = transition.to;
    }
    // A state with no outgoing arrow is left with no handlers at all, so an event aimed at it is
    // ignored rather than silently self-looping through a catch-all.
    config[state] = Object.keys(on).length === 0 ? {} : { on };
  }

  return { id, initial, states: config };
}

/** The node machine of Arch §19.1. `initial` lets a stored node run be resumed where it was. */
export function createNodeMachine(initial: NodeState = 'IDLE'): AnyStateMachine {
  return createMachine(machineConfig('node', NODE_STATES, NODE_TRANSITIONS, initial));
}

/** The run machine of Arch §19.2. */
export function createRunMachine(initial: RunState = 'PREFLIGHT'): AnyStateMachine {
  return createMachine(machineConfig('run', RUN_STATES, RUN_TRANSITIONS, initial));
}
