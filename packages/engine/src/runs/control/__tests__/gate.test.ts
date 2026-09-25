import { describe, expect, it } from 'vitest';

import { createRunGate, createRunGateRegistry } from '../gate.js';

const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const OTHER_RUN = '01JBXQ8Z9KQ4R7N2VWXYZ0RN66';
const NODE_A = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const NODE_B = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';

/** Lets the microtask queue drain, so a pending `waitUntilDispatchable` has had its chance. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe('TC-CTL-001 A paused gate never lets a dispatch through (FR-CTL-001)', () => {
  it('waits, indefinitely, while paused', async () => {
    const gate = createRunGate(RUN_ID);
    let dispatched = false;

    gate.pause();
    const waiting = gate.waitUntilDispatchable().then((ok) => {
      dispatched = ok;
    });

    await settle();
    expect(dispatched).toBe(false);
    expect(gate.isPaused()).toBe(true);

    gate.resume();
    await waiting;
    expect(dispatched).toBe(true);
  });

  it('lets a dispatch straight through when it is not paused', async () => {
    const gate = createRunGate(RUN_ID);
    await expect(gate.waitUntilDispatchable()).resolves.toBe(true);
  });

  it('leaves in-flight nodes alone: pausing does not abort the signal', () => {
    const gate = createRunGate(RUN_ID);
    const release = gate.track(NODE_A);

    gate.pause();
    expect(gate.signal.aborted).toBe(false);
    expect(gate.inFlightNodeIds()).toEqual([NODE_A]);

    release();
    expect(gate.inFlightNodeIds()).toEqual([]);
  });

  it('pausing twice and resuming once is still resumed (20 fast pause/resume cycles)', async () => {
    const gate = createRunGate(RUN_ID);
    for (let index = 0; index < 20; index += 1) {
      gate.pause();
      gate.pause();
      gate.resume();
      gate.resume();
    }
    expect(gate.isPaused()).toBe(false);
    await expect(gate.waitUntilDispatchable()).resolves.toBe(true);
  });

  it('wakes every waiter on resume, not just the first', async () => {
    const gate = createRunGate(RUN_ID);
    gate.pause();

    const waiters = [gate.waitUntilDispatchable(), gate.waitUntilDispatchable(), gate.waitUntilDispatchable()];
    gate.resume();
    expect(await Promise.all(waiters)).toEqual([true, true, true]);
  });
});

describe('TC-CTL-003 A stopped gate aborts and stays aborted (FR-CTL-003)', () => {
  it('aborts the signal and tells waiters not to dispatch', async () => {
    const gate = createRunGate(RUN_ID);
    gate.pause();
    const waiting = gate.waitUntilDispatchable();

    gate.stop();
    expect(gate.signal.aborted).toBe(true);
    expect(gate.abortCause()).toBe('stopped');
    await expect(waiting).resolves.toBe(false);
  });

  it('a stop clears the pause, so nothing is left waiting behind it', async () => {
    const gate = createRunGate(RUN_ID);
    gate.pause();
    gate.stop();
    expect(gate.isPaused()).toBe(false);
    await expect(gate.waitUntilDispatchable()).resolves.toBe(false);
  });

  it('remembers why it aborted, so a stop halts `stopped` and a shutdown `shutdown`', () => {
    const stopped = createRunGate(RUN_ID);
    stopped.stop();
    expect(stopped.abortCause()).toBe('stopped');

    const down = createRunGate(RUN_ID);
    down.shutdown();
    expect(down.abortCause()).toBe('shutdown');
  });

  it('the first cause wins: a shutdown after a stop does not rewrite the halt reason', () => {
    const gate = createRunGate(RUN_ID);
    gate.stop();
    gate.shutdown();
    expect(gate.abortCause()).toBe('stopped');
  });

  it('pause and resume are ignored once aborted', async () => {
    const gate = createRunGate(RUN_ID);
    gate.stop();
    gate.pause();
    expect(gate.isPaused()).toBe(false);
    gate.resume();
    await expect(gate.waitUntilDispatchable()).resolves.toBe(false);
  });

  it('resume on a gate that was never paused changes nothing', async () => {
    const gate = createRunGate(RUN_ID);
    gate.resume();
    await expect(gate.waitUntilDispatchable()).resolves.toBe(true);
  });
});

describe('FR-CTL-003 in-flight tracking, so stop knows what it is waiting for', () => {
  it('idle resolves once the last node is released', async () => {
    const gate = createRunGate(RUN_ID);
    const releaseA = gate.track(NODE_A);
    const releaseB = gate.track(NODE_B);

    let idle = false;
    const waiting = gate.idle().then(() => {
      idle = true;
    });

    await settle();
    expect(idle).toBe(false);

    releaseA();
    await settle();
    expect(idle).toBe(false);

    releaseB();
    await waiting;
    expect(idle).toBe(true);
  });

  it('idle resolves at once when nothing is in flight', async () => {
    await expect(createRunGate(RUN_ID).idle()).resolves.toBeUndefined();
  });

  it('counts the same node twice, so two loop iterations do not release each other', () => {
    const gate = createRunGate(RUN_ID);
    const first = gate.track(NODE_A);
    gate.track(NODE_A);

    first();
    expect(gate.inFlightNodeIds()).toEqual([NODE_A]);
  });

  it('a release called twice releases once', () => {
    const gate = createRunGate(RUN_ID);
    const release = gate.track(NODE_A);
    gate.track(NODE_A);
    release();
    release();
    expect(gate.inFlightNodeIds()).toEqual([NODE_A]);
  });
});

describe('FR-CTL-001..003 the registry is how a route handler reaches a running run', () => {
  it('finds a gate by run id and forgets it when unregistered', () => {
    const registry = createRunGateRegistry();
    const gate = createRunGate(RUN_ID);

    const unregister = registry.register(gate);
    expect(registry.get(RUN_ID)).toBe(gate);
    expect(registry.runIds()).toEqual([RUN_ID]);

    unregister();
    expect(registry.get(RUN_ID)).toBeUndefined();
    expect(registry.runIds()).toEqual([]);
  });

  it('answers undefined for a run this process is not driving', () => {
    expect(createRunGateRegistry().get(OTHER_RUN)).toBeUndefined();
  });

  it('an unregister does not remove a gate that has since replaced it', () => {
    const registry = createRunGateRegistry();
    const first = createRunGate(RUN_ID);
    const unregisterFirst = registry.register(first);
    const second = createRunGate(RUN_ID);
    registry.register(second);

    unregisterFirst();
    expect(registry.get(RUN_ID)).toBe(second);
  });

  it('lists every gate, which is what shutdown walks (FR-SYS-008)', () => {
    const registry = createRunGateRegistry();
    registry.register(createRunGate(RUN_ID));
    registry.register(createRunGate(OTHER_RUN));

    for (const gate of registry.all()) gate.shutdown();
    expect(registry.all().map((gate) => gate.abortCause())).toEqual(['shutdown', 'shutdown']);
  });
});
