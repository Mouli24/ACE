import type { NodeState, RunState } from '@ace/contracts';
import { NODE_STATES, RUN_STATES } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  canTransitionNode,
  canTransitionRun,
  createNodeMachine,
  createRunMachine,
  nextNodeState,
  nextRunState,
  type NodeEventType,
  type RunEventType,
} from '../runs/machines/index.js';
import { createActor } from 'xstate';

/**
 * Arch §19.1 and §19.2, transcribed. The point of these tests is the *negative* half: every
 * transition the diagrams do not draw must be refused, because a state machine that quietly
 * accepts an undrawn edge is not a specification of anything.
 */

/** Drive a machine from its initial state to `state`, then send `event`. */
function sendNode(from: NodeState, event: NodeEventType): NodeState | undefined {
  const actor = createActor(createNodeMachine(from));
  actor.start();
  actor.send({ type: event });
  const value = actor.getSnapshot().value as NodeState;
  actor.stop();
  return value;
}

function sendRun(from: RunState, event: RunEventType): RunState {
  const actor = createActor(createRunMachine(from));
  actor.start();
  actor.send({ type: event });
  const value = actor.getSnapshot().value as RunState;
  actor.stop();
  return value;
}

/* -------------------------------------------------------------------------- */
/* Node — Arch §19.1                                                           */
/* -------------------------------------------------------------------------- */

describe('Arch §19.1 the node machine has exactly the transitions of the diagram', () => {
  it('lists every edge the diagram draws, and no others', () => {
    expect(NODE_TRANSITIONS).toEqual([
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
    ]);
  });

  it.each(NODE_TRANSITIONS)('walks $from --$event--> $to', ({ from, event, to }) => {
    expect(sendNode(from, event)).toBe(to);
    expect(canTransitionNode(from, event)).toBe(true);
    expect(nextNodeState(from, event)).toBe(to);
  });

  it('refuses every pair the diagram does not draw', () => {
    const drawn = new Set(NODE_TRANSITIONS.map(({ from, event }) => `${from}:${event}`));
    const events = [...new Set(NODE_TRANSITIONS.map((t) => t.event))];
    let refused = 0;

    for (const from of NODE_STATES) {
      for (const event of events) {
        if (drawn.has(`${from}:${event}`)) continue;

        expect(canTransitionNode(from, event), `${from} --${event}-->`).toBe(false);
        expect(nextNodeState(from, event), `${from} --${event}-->`).toBeUndefined();
        // The machine itself must stay where it is, not just the helper.
        expect(sendNode(from, event), `${from} --${event}-->`).toBe(from);
        refused += 1;
      }
    }

    expect(refused).toBeGreaterThan(50);
  });

  it('never leaves STOPPED or BLOCKED on its own', () => {
    for (const event of [...new Set(NODE_TRANSITIONS.map((t) => t.event))]) {
      expect(sendNode('STOPPED', event)).toBe('STOPPED');
      expect(sendNode('BLOCKED', event)).toBe('BLOCKED');
    }
  });

  it('BR-03 reaches FAILED from RUNNING and from WAITING, which are different failures', () => {
    expect(sendNode('RUNNING', 'FAIL')).toBe('FAILED');
    expect(sendNode('WAITING', 'REJECT')).toBe('FAILED');
  });

  it('can be retried out of FAILED, which is what attempt+1 means', () => {
    expect(sendNode('FAILED', 'RETRY')).toBe('READY');
  });

  it('can go round again from COMPLETED, which is what a loop iteration needs', () => {
    expect(sendNode('COMPLETED', 'RERUN')).toBe('READY');
  });

  it('starts at IDLE by default', () => {
    const actor = createActor(createNodeMachine());
    actor.start();
    expect(actor.getSnapshot().value).toBe('IDLE');
    actor.stop();
  });

  it('declares a state for every NodeState the contract names', () => {
    const reachable = new Set<string>(['IDLE']);
    for (const { from, to } of NODE_TRANSITIONS) {
      reachable.add(from);
      reachable.add(to);
    }

    expect([...reachable].sort()).toEqual([...NODE_STATES].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* Run — Arch §19.2                                                            */
/* -------------------------------------------------------------------------- */

describe('Arch §19.2 the run machine has exactly the transitions of the diagram', () => {
  it('lists every edge the diagram draws, and no others', () => {
    expect(RUN_TRANSITIONS).toEqual([
      { from: 'PREFLIGHT', event: 'CHECKS_FAILED', to: 'BLOCKED' },
      { from: 'PREFLIGHT', event: 'CHECKS_PASSED', to: 'RUNNING' },
      { from: 'RUNNING', event: 'PAUSE', to: 'PAUSED' },
      { from: 'PAUSED', event: 'RESUME', to: 'RUNNING' },
      { from: 'RUNNING', event: 'HALT', to: 'HALTED' },
      { from: 'RUNNING', event: 'COMPLETE', to: 'COMPLETE' },
    ]);
  });

  it.each(RUN_TRANSITIONS)('walks $from --$event--> $to', ({ from, event, to }) => {
    expect(sendRun(from, event)).toBe(to);
    expect(canTransitionRun(from, event)).toBe(true);
    expect(nextRunState(from, event)).toBe(to);
  });

  it('refuses every pair the diagram does not draw', () => {
    const drawn = new Set(RUN_TRANSITIONS.map(({ from, event }) => `${from}:${event}`));
    const events = [...new Set(RUN_TRANSITIONS.map((t) => t.event))];

    for (const from of RUN_STATES) {
      for (const event of events) {
        if (drawn.has(`${from}:${event}`)) continue;

        expect(canTransitionRun(from, event), `${from} --${event}-->`).toBe(false);
        expect(sendRun(from, event), `${from} --${event}-->`).toBe(from);
      }
    }
  });

  it('BR-03 keeps COMPLETE and HALTED apart, and both are final', () => {
    expect(sendRun('RUNNING', 'COMPLETE')).toBe('COMPLETE');
    expect(sendRun('RUNNING', 'HALT')).toBe('HALTED');

    for (const event of [...new Set(RUN_TRANSITIONS.map((t) => t.event))]) {
      expect(sendRun('COMPLETE', event)).toBe('COMPLETE');
      expect(sendRun('HALTED', event)).toBe('HALTED');
      expect(sendRun('BLOCKED', event)).toBe('BLOCKED');
    }
  });

  it('cannot go straight from PREFLIGHT to COMPLETE — a run that never ran did not complete', () => {
    expect(canTransitionRun('PREFLIGHT', 'COMPLETE')).toBe(false);
  });

  it('cannot be paused before it is running', () => {
    expect(canTransitionRun('PREFLIGHT', 'PAUSE')).toBe(false);
  });

  it('starts at PREFLIGHT by default', () => {
    const actor = createActor(createRunMachine());
    actor.start();
    expect(actor.getSnapshot().value).toBe('PREFLIGHT');
    actor.stop();
  });

  it('declares a state for every RunState the contract names', () => {
    const reachable = new Set<string>(['PREFLIGHT']);
    for (const { from, to } of RUN_TRANSITIONS) {
      reachable.add(from);
      reachable.add(to);
    }

    expect([...reachable].sort()).toEqual([...RUN_STATES].sort());
  });
});
