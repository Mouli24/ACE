import type { DayTotals, Id, NodeRun, Run } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { HttpError } from '../../../gateway/errors.js';
import { newId } from '../../../ids.js';
import { createLogger } from '../../../logging/index.js';
import { createRunGate, createRunGateRegistry, type RunGateRegistry } from '../gate.js';
import { createRunControls, type PartialRunPlan, type RunControls } from '../service.js';
import {
  agentNode,
  createCapturedBus,
  createFakeStores,
  edge,
  inputNode,
  makeEnvelope,
  makeNodeRun,
  makeRun,
  outputNode,
  tickingClock,
  type CapturedBus,
  type FakeStores,
} from './harness.js';

/* Brief → Writer → Reviewer → Result. */
const brief = inputNode('Brief');
const writer = agentNode('Writer');
const reviewer = agentNode('Reviewer');
const result = outputNode('Result');
const nodes = [brief, writer, reviewer, result];
const edges = [edge(brief, writer), edge(writer, reviewer), edge(reviewer, result)];
const snapshot = { version: 3, nodes, edges };

let idCounter = 0;
const nextId = (): string => `01JBXQ8Z9KQ4R7N2VWXYZ0C${String(idCounter++).padStart(3, '0')}`;

interface Harness {
  controls: RunControls;
  stores: FakeStores;
  bus: CapturedBus;
  gates: RunGateRegistry;
  restarted: Run[];
  partials: PartialRunPlan[];
  envelopesAsked: { runId: Id; nodeId: Id }[];
}

function harness(seed: { runs?: Run[]; nodeRuns?: NodeRun[] } = {}): Harness {
  const stores = createFakeStores(seed);
  const bus = createCapturedBus();
  const gates = createRunGateRegistry();
  const restarted: Run[] = [];
  const partials: PartialRunPlan[] = [];
  const envelopesAsked: { runId: Id; nodeId: Id }[] = [];

  const controls = createRunControls({
    runs: stores.runs,
    nodeRuns: stores.nodeRuns,
    bus,
    gates,
    now: tickingClock(),
    nextId,
    driveRecordedRun: async (run) => {
      restarted.push(run);
      const running = await stores.runs.update(run.id, { status: 'RUNNING' });
      return running ?? run;
    },
    drivePartialRun: async (plan) => {
      partials.push(plan);
      return plan.run;
    },
    envelopesFor: async (run, nodeId) => {
      envelopesAsked.push({ runId: run.id, nodeId });
      return [makeEnvelope(run, writer.id, nodeId, 'latest upstream output')];
    },
  });

  return { controls, stores, bus, gates, restarted, partials, envelopesAsked };
}

beforeEach(() => {
  idCounter = 0;
});

/* -------------------------------------------------------------------------- */

describe('TC-CTL-001 Pause (FR-CTL-001)', () => {
  it('stops dispatch, moves READY node runs to PAUSED and leaves RUNNING ones alone', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const running = makeNodeRun(run, writer.id, { status: 'RUNNING' });
    const queued = makeNodeRun(run, reviewer.id, { status: 'READY' });
    const done = makeNodeRun(run, brief.id, { status: 'COMPLETED' });

    const h = harness({ runs: [run], nodeRuns: [running, queued, done] });
    const gate = createRunGate(run.id);
    h.gates.register(gate);

    const paused = await h.controls.pause(run.id);

    expect(paused.status).toBe('PAUSED');
    expect(paused.pausedAt).toBeDefined();
    expect(paused.allowedActions).toEqual(['resume', 'stop']);
    expect(gate.isPaused()).toBe(true);

    expect(h.stores.nodeRunRows.get(running.id)?.status).toBe('RUNNING');
    expect(h.stores.nodeRunRows.get(queued.id)?.status).toBe('PAUSED');
    expect(h.stores.nodeRunRows.get(done.id)?.status).toBe('COMPLETED');
  });

  it('does not abort anything: a paused run’s in-flight calls run to the end', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });
    const gate = createRunGate(run.id);
    h.gates.register(gate);

    await h.controls.pause(run.id);
    expect(gate.signal.aborted).toBe(false);
  });

  it('emits `run.paused` and a `node.state` per node it moved (§2.6)', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const queued = makeNodeRun(run, reviewer.id, { status: 'READY' });
    const h = harness({ runs: [run], nodeRuns: [queued] });

    await h.controls.pause(run.id);

    expect(h.bus.typesOf('run.paused')).toHaveLength(1);
    expect(h.bus.typesOf('run.paused')[0]?.payload).toEqual({ runId: run.id });
    const states = h.bus.typesOf('node.state');
    expect(states).toHaveLength(1);
    expect(states[0]?.payload).toMatchObject({ nodeId: reviewer.id, status: 'PAUSED' });
  });

  it('flips the gate before it writes the row, so nothing slips through in between', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });
    let pausedWhenRowWritten: boolean | undefined;
    const gate = createRunGate(run.id);
    h.gates.register(gate);

    const patched = h.stores.runs.update;
    h.stores.runs.update = async (runId, patch) => {
      pausedWhenRowWritten ??= gate.isPaused();
      return patched(runId, patch);
    };

    await h.controls.pause(run.id);
    expect(pausedWhenRowWritten).toBe(true);
  });

  it('works when this process is not driving the run: the row is still the truth', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });
    await expect(h.controls.pause(run.id)).resolves.toMatchObject({ status: 'PAUSED' });
  });

  it('refuses to pause a run that is not RUNNING, with 409 `invalid_run_state`', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const h = harness({ runs: [run] });

    await expect(h.controls.pause(run.id)).rejects.toMatchObject({
      code: 'invalid_run_state',
      status: 409,
    });
    expect(h.stores.runRows.get(run.id)?.status).toBe('HALTED');
  });

  it('answers 404 for a run that does not exist', async () => {
    const h = harness();
    await expect(h.controls.pause('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).rejects.toThrow(HttpError);
  });
});

describe('TC-CTL-002 Resume (FR-CTL-002)', () => {
  it('puts PAUSED node runs back to READY, clears `pausedAt` and lets dispatch continue', async () => {
    const run = makeRun({ snapshot, status: 'PAUSED', pausedAt: '2026-09-26T10:00:05.000Z' });
    const paused = makeNodeRun(run, reviewer.id, { status: 'PAUSED' });
    const h = harness({ runs: [run], nodeRuns: [paused] });

    const gate = createRunGate(run.id);
    gate.pause();
    h.gates.register(gate);

    const resumed = await h.controls.resume(run.id);

    expect(resumed.status).toBe('RUNNING');
    expect(resumed.pausedAt).toBeUndefined();
    expect(resumed.allowedActions).toEqual(['pause', 'stop']);
    expect(gate.isPaused()).toBe(false);
    expect(h.stores.nodeRunRows.get(paused.id)?.status).toBe('READY');
    expect(h.bus.typesOf('run.resumed')).toHaveLength(1);
  });

  it('lifts the gate only after every row says READY', async () => {
    const run = makeRun({ snapshot, status: 'PAUSED' });
    const paused = makeNodeRun(run, reviewer.id, { status: 'PAUSED' });
    const h = harness({ runs: [run], nodeRuns: [paused] });

    const gate = createRunGate(run.id);
    gate.pause();
    h.gates.register(gate);

    let statusWhenLifted: string | undefined;
    const resume = gate.resume.bind(gate);
    gate.resume = () => {
      statusWhenLifted = h.stores.nodeRunRows.get(paused.id)?.status;
      resume();
    };

    await h.controls.resume(run.id);
    expect(statusWhenLifted).toBe('READY');
  });

  it('refuses to resume a run that is not paused', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });
    await expect(h.controls.resume(run.id)).rejects.toMatchObject({ code: 'invalid_run_state' });
  });
});

describe('TC-CTL-003 Stop (FR-CTL-003, TC-ERR-008)', () => {
  it('aborts the run, STOPs every node that had not finished and halts the run `stopped`', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const running = makeNodeRun(run, writer.id, { status: 'RUNNING' });
    const queued = makeNodeRun(run, reviewer.id, { status: 'READY' });
    const waiting = makeNodeRun(run, result.id, { status: 'WAITING' });
    const done = makeNodeRun(run, brief.id, { status: 'COMPLETED' });

    const h = harness({ runs: [run], nodeRuns: [running, queued, waiting, done] });
    const gate = createRunGate(run.id);
    h.gates.register(gate);

    const halted = await h.controls.stop(run.id);

    expect(gate.signal.aborted).toBe(true);
    expect(gate.abortCause()).toBe('stopped');
    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(halted.allowedActions).toEqual(['restart']);
    expect(halted.endedAt).toBeDefined();
    expect(halted.durationMs).toBeGreaterThanOrEqual(0);

    for (const row of [running, queued, waiting]) {
      const stopped = h.stores.nodeRunRows.get(row.id);
      expect(stopped?.status).toBe('STOPPED');
      expect(stopped?.endedAt).toBeDefined();
    }
    expect(h.stores.nodeRunRows.get(done.id)?.status).toBe('COMPLETED');
  });

  it('stops a paused run too (D76: nodes may still have been finishing)', async () => {
    const run = makeRun({ snapshot, status: 'PAUSED' });
    const paused = makeNodeRun(run, reviewer.id, { status: 'PAUSED' });
    const h = harness({ runs: [run], nodeRuns: [paused] });

    const halted = await h.controls.stop(run.id);
    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.stores.nodeRunRows.get(paused.id)?.status).toBe('STOPPED');
  });

  it('aborts before it writes anything, because the 2 s clock starts at the call', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({
      runs: [run],
      nodeRuns: [makeNodeRun(run, writer.id, { status: 'RUNNING' })],
    });
    const gate = createRunGate(run.id);
    h.gates.register(gate);

    let abortedWhenFirstWrite: boolean | undefined;
    const patched = h.stores.nodeRuns.update;
    h.stores.nodeRuns.update = async (id, patch) => {
      abortedWhenFirstWrite ??= gate.signal.aborted;
      return patched(id, patch);
    };

    await h.controls.stop(run.id);
    expect(abortedWhenFirstWrite).toBe(true);
  });

  it('emits `run.completed` with HALTED `stopped`, never COMPLETE (BR-12)', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });

    await h.controls.stop(run.id);
    const completed = h.bus.typesOf('run.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });

  it('refuses to stop a run that has already ended', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({ runs: [run] });
    await expect(h.controls.stop(run.id)).rejects.toMatchObject({ code: 'invalid_run_state' });
  });
});

describe('TC-CTL-004 Restart (FR-CTL-004)', () => {
  it('creates a new run on the same snapshot and inputs, with `restartedFromRunId`', async () => {
    const inputs = { [brief.id]: [{ type: 'text' as const, text: 'the brief' }] };
    const source = makeRun({ snapshot, status: 'HALTED', haltReason: 'stopped', inputs });
    const h = harness({ runs: [source] });

    const next = await h.controls.restart(source.id);

    expect(next.id).not.toBe(source.id);
    expect(next.restartedFromRunId).toBe(source.id);
    expect(next.snapshot).toEqual(source.snapshot);
    expect(next.inputs).toEqual(inputs);
    expect(next.totals).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(next.preflightIssues).toEqual([]);
    expect(h.restarted.map((run) => run.id)).toEqual([next.id]);
  });

  it('hands the scheduler a PREFLIGHT row, so pre-flight still runs on it (BR-08)', async () => {
    const source = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({ runs: [source] });

    await h.controls.restart(source.id);
    expect(h.restarted[0]?.status).toBe('PREFLIGHT');
    expect(h.restarted[0]?.allowedActions).toEqual([]);
  });

  it('does not touch the run it restarted from', async () => {
    const source = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const h = harness({ runs: [source] });

    await h.controls.restart(source.id);
    expect(h.stores.runRows.get(source.id)).toMatchObject({
      status: 'HALTED',
      haltReason: 'failure',
    });
  });

  it('restarts a BLOCKED run too, because a block can be transient (D76)', async () => {
    const source = makeRun({ snapshot, status: 'BLOCKED' });
    const h = harness({ runs: [source] });
    await expect(h.controls.restart(source.id)).resolves.toMatchObject({
      restartedFromRunId: source.id,
    });
  });

  it('refuses to restart a run that is still going', async () => {
    const source = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [source] });
    await expect(h.controls.restart(source.id)).rejects.toMatchObject({
      code: 'invalid_run_state',
    });
  });
});

describe('TC-CTL-005 Re-run one node (FR-CTL-005, D81, D82)', () => {
  it('creates one node run for that node on the latest upstream outputs, and nothing else', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const before = [
      makeNodeRun(run, brief.id, { status: 'COMPLETED' }),
      makeNodeRun(run, writer.id, { status: 'COMPLETED' }),
      makeNodeRun(run, reviewer.id, { status: 'COMPLETED' }),
    ];
    const h = harness({ runs: [run], nodeRuns: before });

    const rerun = await h.controls.rerunNode(run.id, reviewer.id);

    expect(rerun.nodeId).toBe(reviewer.id);
    expect(rerun.status).toBe('READY');
    expect(rerun.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect([...h.stores.nodeRunRows.values()]).toHaveLength(4);
    expect(h.envelopesAsked).toEqual([{ runId: run.id, nodeId: reviewer.id }]);
    expect(rerun.inputEnvelopes[0]?.reads).toEqual([
      { type: 'text', text: 'latest upstream output' },
    ]);
  });

  it('numbers the new attempt past the highest already recorded, so the pair stays unique', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, reviewer.id, { status: 'FAILED', attempt: 1 }),
        makeNodeRun(run, reviewer.id, { status: 'COMPLETED', attempt: 2 }),
      ],
    });

    expect((await h.controls.rerunNode(run.id, reviewer.id)).attempt).toBe(3);
  });

  it('belongs to the latest iteration, because a re-run is not a new loop iteration', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, writer.id, { status: 'COMPLETED', iteration: 1 }),
        makeNodeRun(run, writer.id, { status: 'COMPLETED', iteration: 3 }),
      ],
    });

    const rerun = await h.controls.rerunNode(run.id, writer.id);
    expect(rerun.iteration).toBe(3);
    expect(rerun.attempt).toBe(2);
  });

  it('a node with no history yet starts at iteration 1, attempt 1', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({ runs: [run] });
    expect(await h.controls.rerunNode(run.id, writer.id)).toMatchObject({
      iteration: 1,
      attempt: 1,
    });
  });

  it('D81: re-opens a finished run to RUNNING and hands the scheduler just that node', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({ runs: [run] });

    const rerun = await h.controls.rerunNode(run.id, reviewer.id);

    expect(h.stores.runRows.get(run.id)?.status).toBe('RUNNING');
    expect(h.partials).toHaveLength(1);
    expect(h.partials[0]?.withDownstream).toBe(false);
    expect(h.partials[0]?.nodeRuns.map((row) => row.id)).toEqual([rerun.id]);
    expect(h.partials[0]?.run.allowedActions).toEqual(['pause', 'stop']);
  });

  it('D309: refuses a run that is still RUNNING (409) — a second drive beside the first', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });

    await expect(h.controls.rerunNode(run.id, reviewer.id)).rejects.toMatchObject({
      status: 409,
      code: 'invalid_run_state',
    });
    expect(h.stores.runRows.get(run.id)?.status).toBe('RUNNING');
    expect(h.stores.runPatches).toEqual([]);
  });

  it('D82: executes the run’s snapshot — a node absent from it is a 404', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const h = harness({ runs: [run] });
    await expect(h.controls.rerunNode(run.id, '01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).rejects.toThrow(
      HttpError,
    );
  });

  it('re-runs with no reads when the scheduler supplies no envelope builder', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const stores = createFakeStores({ runs: [run] });
    const controls = createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus: createCapturedBus(),
      gates: createRunGateRegistry(),
      nextId,
      driveRecordedRun: async (value) => value,
      drivePartialRun: async (plan) => plan.run,
    });

    expect((await controls.rerunNode(run.id, brief.id)).inputEnvelopes).toEqual([]);
  });
});

describe('TC-ERR-003 Manual retry (FR-ERR-003)', () => {
  it('is a new node run at attempt + 1 with identical inputs', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    // As delivered: what a person typed into the Input node is trusted (BR-13).
    const delivered = makeEnvelope(run, brief.id, writer.id, 'the brief');
    const envelopes = [
      { ...delivered, context: { ...delivered.context, trust: 'trusted' as const } },
    ];
    const failed = makeNodeRun(run, writer.id, {
      status: 'FAILED',
      failureReason: 'RUN_FAILED',
      attempt: 2,
      inputEnvelopes: envelopes,
      error: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
    });
    const h = harness({ runs: [run], nodeRuns: [failed] });

    const retry = await h.controls.retryNodeRun(failed.id, { withDownstream: false });

    expect(retry.attempt).toBe(3);
    expect(retry.nodeId).toBe(writer.id);
    expect(retry.iteration).toBe(failed.iteration);
    expect(retry.status).toBe('READY');
    expect(retry.inputEnvelopes).toEqual(envelopes);
    expect(retry.error).toBeUndefined();
    expect(retry.failureReason).toBeUndefined();
  });

  it('13b fix I1: copies what the failed attempt was delivered, not the context it read', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const delivered = makeEnvelope(run, brief.id, writer.id, 'the brief');
    const read = {
      ...delivered,
      context: {
        ...delivered.context,
        trust: 'untrusted' as const,
        retrieved: [{ chunkId: newId(), text: 'a chunk', score: 0.5, source: 'a.md#1' }],
        memory: [{ key: 'tone', value: 'brief' }],
      },
    };
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED', inputEnvelopes: [read] });
    const h = harness({ runs: [run], nodeRuns: [failed] });

    const retry = await h.controls.retryNodeRun(failed.id, { withDownstream: false });

    expect(retry.inputEnvelopes).toEqual([
      { ...delivered, context: { budgetTokens: delivered.context.budgetTokens, trust: 'trusted' } },
    ]);
    expect(h.stores.nodeRunRows.get(retry.id)?.inputEnvelopes).toEqual(retry.inputEnvelopes);
  });

  it('never rebuilds the envelopes — "identical inputs" means the ones that failed', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, {
      status: 'FAILED',
      inputEnvelopes: [makeEnvelope(run, brief.id, writer.id, 'the original brief')],
    });
    const h = harness({ runs: [run], nodeRuns: [failed] });

    await h.controls.retryNodeRun(failed.id, { withDownstream: false });
    expect(h.envelopesAsked).toEqual([]);
  });

  it('starts with no verdicts and no approvals of its own (FR-GRD-015)', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const h = harness({ runs: [run], nodeRuns: [failed] });

    const retry = await h.controls.retryNodeRun(failed.id, { withDownstream: false });
    expect(retry.verdicts).toEqual([]);
    expect(retry.approvals).toEqual([]);
    expect(retry.toolCalls).toEqual([]);
  });

  it('D81: re-opens the halted run and ends it again', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const h = harness({ runs: [run], nodeRuns: [failed] });

    await h.controls.retryNodeRun(failed.id, { withDownstream: false });
    expect(h.stores.runRows.get(run.id)?.status).toBe('RUNNING');
    expect(h.partials).toHaveLength(1);
  });

  it('answers 404 for a node run that does not exist', async () => {
    const h = harness();
    await expect(
      h.controls.retryNodeRun('01JBXQ8Z9KQ4R7N2VWXYZ0NONE', { withDownstream: false }),
    ).rejects.toThrow(HttpError);
  });
});

describe('TC-ERR-004 Retry with downstream (FR-ERR-004)', () => {
  it('asks the scheduler for the downstream too, and clears the BLOCKED rows it left', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED', failureReason: 'RUN_FAILED' });
    const blockedReviewer = makeNodeRun(run, reviewer.id, {
      status: 'BLOCKED',
      failureReason: 'BLOCKED',
    });
    const blockedResult = makeNodeRun(run, result.id, {
      status: 'BLOCKED',
      failureReason: 'BLOCKED',
    });
    const upstreamDone = makeNodeRun(run, brief.id, { status: 'COMPLETED' });

    const h = harness({
      runs: [run],
      nodeRuns: [failed, blockedReviewer, blockedResult, upstreamDone],
    });

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });

    expect(h.partials[0]?.withDownstream).toBe(true);
    expect(h.stores.nodeRunRows.get(blockedReviewer.id)?.status).toBe('IDLE');
    expect(h.stores.nodeRunRows.get(blockedResult.id)?.status).toBe('IDLE');
    // Upstream is untouched: retry with downstream goes forwards only.
    expect(h.stores.nodeRunRows.get(upstreamDone.id)?.status).toBe('COMPLETED');
  });

  it('announces each cleared node so the Canvas stops showing a lock', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const blocked = makeNodeRun(run, reviewer.id, { status: 'BLOCKED' });
    const h = harness({ runs: [run], nodeRuns: [failed, blocked] });

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });

    const idle = h.bus
      .typesOf('node.state')
      .filter((event) => (event.payload as { status: string }).status === 'IDLE');
    expect(idle).toHaveLength(1);
    expect(idle[0]?.payload).toMatchObject({ nodeId: reviewer.id });
  });

  it('leaves a completed downstream node alone: only BLOCKED rows are cleared', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const finished = makeNodeRun(run, reviewer.id, { status: 'COMPLETED' });
    const h = harness({ runs: [run], nodeRuns: [failed, finished] });

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });
    expect(h.stores.nodeRunRows.get(finished.id)?.status).toBe('COMPLETED');
  });

  it('without `withDownstream` nothing downstream is touched', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const blocked = makeNodeRun(run, reviewer.id, { status: 'BLOCKED' });
    const h = harness({ runs: [run], nodeRuns: [failed, blocked] });

    await h.controls.retryNodeRun(failed.id, { withDownstream: false });
    expect(h.stores.nodeRunRows.get(blocked.id)?.status).toBe('BLOCKED');
  });
});

describe('TC-ERR-009 Fix and re-run, and FR-CTL-006 on every answer', () => {
  it('D82: a re-run reads the snapshot, so fixing a node is Start from this node, not a re-run', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const h = harness({ runs: [run] });

    await h.controls.rerunNode(run.id, writer.id);
    // The plan the scheduler is handed carries the run — snapshot and all — and no live workflow.
    expect(h.partials[0]?.run.snapshot).toEqual(snapshot);
    expect(h.partials[0]?.run.snapshot.version).toBe(3);
  });

  it('every control answers with `allowedActions` filled in (FR-CTL-006)', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });

    expect((await h.controls.get(run.id)).allowedActions).toEqual(['pause', 'stop']);
    expect((await h.controls.pause(run.id)).allowedActions).toEqual(['resume', 'stop']);
    expect((await h.controls.resume(run.id)).allowedActions).toEqual(['pause', 'stop']);
    expect((await h.controls.stop(run.id)).allowedActions).toEqual(['restart']);
    expect((await h.controls.restart(run.id)).allowedActions).toEqual(['pause', 'stop']);
  });

  it('writes `allowedActions` on the row as well as the answer, so a refetch agrees', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const h = harness({ runs: [run] });

    await h.controls.pause(run.id);
    expect(h.stores.runRows.get(run.id)?.allowedActions).toEqual(['resume', 'stop']);
  });

  it('`get` answers 404 for a run that does not exist', async () => {
    const h = harness();
    await expect(h.controls.get('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).rejects.toThrow(HttpError);
  });

  /** A store whose `update` has no row to hand back: the patch on what was read is still true. */
  function controlsOverStoreThatReturnsNull(seed: Run): RunControls {
    const stores = createFakeStores({ runs: [seed] });
    stores.runs.update = async () => null;

    return createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus: createCapturedBus(),
      gates: createRunGateRegistry(),
      nextId,
      driveRecordedRun: async (value) => value,
      drivePartialRun: async (plan) => plan.run,
    });
  }

  it('survives a store that has no row to hand back, and still reports the new status', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const paused = await controlsOverStoreThatReturnsNull(run).pause(run.id);

    expect(paused).toMatchObject({ status: 'PAUSED', allowedActions: ['resume', 'stop'] });
    expect(paused.pausedAt).toBeDefined();
  });

  it('clears `pausedAt` on resume even then, because `null` means "remove it"', async () => {
    const run = makeRun({ snapshot, status: 'PAUSED', pausedAt: '2026-09-26T10:00:05.000Z' });
    const resumed = await controlsOverStoreThatReturnsNull(run).resume(run.id);

    expect(resumed).toMatchObject({ status: 'RUNNING' });
    expect(resumed.pausedAt).toBeUndefined();
  });
});

describe('FR-OBS-002 a Stop announces the day totals (13a review m5)', () => {
  function stopping(usage: { dayTotals(day: string): Promise<DayTotals> }) {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const spent = makeNodeRun(run, writer.id, {
      status: 'COMPLETED',
      usage: { tokensIn: 5, tokensOut: 7, costUsd: 0.25 },
    });
    const stores = createFakeStores({ runs: [run], nodeRuns: [spent] });
    const bus = createCapturedBus();
    const logs: string[] = [];
    const controls = createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus,
      gates: createRunGateRegistry(),
      now: tickingClock(),
      nextId,
      usage,
      logger: createLogger({ level: 'warn', destination: { write: (line) => logs.push(line) } }),
      driveRecordedRun: async (recorded) => recorded,
      drivePartialRun: async (plan) => plan.run,
    });
    return { run, bus, logs, controls };
  }

  it('emits usage.updated with the run totals and the day totals, before run.completed', async () => {
    const days: string[] = [];
    const h = stopping({
      async dayTotals(day) {
        days.push(day);
        return { day, totals: { tokensIn: 50, tokensOut: 70, costUsd: 2.5 } };
      },
    });

    const halted = await h.controls.stop(h.run.id);

    const types = h.bus.events.map((event) => event.type);
    const updated = types.indexOf('usage.updated');
    expect(updated).toBeGreaterThan(-1);
    expect(updated).toBeLessThan(types.indexOf('run.completed'));
    expect(h.bus.events[updated]?.payload).toEqual({
      runId: h.run.id,
      totals: halted.totals,
      dayTotals: {
        day: halted.endedAt!.slice(0, 10),
        totals: { tokensIn: 50, tokensOut: 70, costUsd: 2.5 },
      },
    });
    expect(days).toEqual([halted.endedAt!.slice(0, 10)]);
  });

  it('still stops when the day totals cannot be read, and says so in the log', async () => {
    const h = stopping({
      async dayTotals() {
        throw new Error('the usage read model is unavailable');
      },
    });

    const halted = await h.controls.stop(h.run.id);

    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.bus.typesOf('usage.updated')).toEqual([]);
    expect(h.bus.typesOf('run.completed')).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('could not read the day totals'))).toBe(true);
  });
});

describe('D388 Continue an interrupted run (FR-ERR-003, FR-ERR-004)', () => {
  /* Brief → A, Brief → B (in parallel) → Join → End. */
  const a = agentNode('A');
  const b = agentNode('B');
  const join = agentNode('Join');
  const end = outputNode('End');
  const parallel = {
    version: 4,
    nodes: [brief, a, b, join, end],
    edges: [edge(brief, a), edge(brief, b), edge(a, join), edge(b, join), edge(join, end)],
  };
  const cutOff = (overrides: Partial<Run> = {}): Run =>
    makeRun({ snapshot: parallel, status: 'HALTED', haltReason: 'crash', ...overrides });
  const restartedError = { kind: 'workflow' as const, message: 'restarted', retryable: true };
  const upstreamError = { kind: 'workflow' as const, message: 'blocked', retryable: false };
  const idleFrames = (h: Harness): string[] =>
    h.bus
      .typesOf('node.state')
      .map((event) => event.payload as { nodeId: string; status: string })
      .filter((payload) => payload.status === 'IDLE')
      .map((payload) => payload.nodeId);

  it('a crash with two parallel nodes cut off: two READY retries at attempt 2, one drive with both', async () => {
    const run = cutOff();
    const toA = makeEnvelope(run, brief.id, a.id, 'the brief for A');
    const toB = makeEnvelope(run, brief.id, b.id, 'the brief for B');
    const done = makeNodeRun(run, brief.id, { status: 'COMPLETED' });
    const stoppedA = makeNodeRun(run, a.id, { status: 'STOPPED', inputEnvelopes: [toA] });
    const stoppedB = makeNodeRun(run, b.id, {
      status: 'STOPPED',
      inputEnvelopes: [toB],
      usage: { tokensIn: 4, tokensOut: 1, costUsd: 0.01 },
    });
    const h = harness({ runs: [run], nodeRuns: [done, stoppedA, stoppedB] });

    const continued = await h.controls.continueRun(run.id);

    expect(continued).toMatchObject({ id: run.id, status: 'RUNNING' });
    expect(continued.allowedActions).toEqual(['pause', 'stop']);
    expect(h.stores.runRows.get(run.id)?.status).toBe('RUNNING');

    expect(h.partials).toHaveLength(1);
    const plan = h.partials[0]!;
    expect(plan.withDownstream).toBe(true);
    expect(plan.run.status).toBe('RUNNING');
    expect(plan.nodeRuns.map((row) => row.nodeId).sort()).toEqual([a.id, b.id].sort());
    for (const retry of plan.nodeRuns) {
      expect(retry).toMatchObject({ status: 'READY', attempt: 2, iteration: 1 });
      expect(retry.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
      expect(retry.verdicts).toEqual([]);
      expect(retry.toolCalls).toEqual([]);
      expect(retry.approvals).toEqual([]);
      expect(retry.error).toBeUndefined();
      // Each in the store, exactly as handed to the drive.
      expect(h.stores.nodeRunRows.get(retry.id)).toEqual(retry);
    }
    // FR-ERR-003: what the cut-off attempt was delivered, as delivered — never rebuilt.
    const retryA = plan.nodeRuns.find((row) => row.nodeId === a.id);
    expect(retryA?.inputEnvelopes.map((envelope) => envelope.reads)).toEqual([toA.reads]);
    expect(h.envelopesAsked).toEqual([]);
    // The cut-off rows are history, left as they were.
    expect(h.stores.nodeRunRows.get(stoppedA.id)?.status).toBe('STOPPED');
    expect(h.stores.nodeRunRows.get(stoppedB.id)?.usage.tokensIn).toBe(4);
    expect(h.stores.nodeRunRows.get(done.id)?.status).toBe('COMPLETED');
  });

  it('a node that COMPLETED gets no retry, and only the latest attempt of a node counts', async () => {
    const run = cutOff({ haltReason: 'stopped' });
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(run, a.id, { status: 'COMPLETED' }),
        // Stopped once, then finished on a retry: nothing left to continue for B.
        makeNodeRun(run, b.id, { status: 'STOPPED', attempt: 1 }),
        makeNodeRun(run, b.id, { status: 'COMPLETED', attempt: 2 }),
        makeNodeRun(run, join.id, { status: 'STOPPED' }),
      ],
    });

    await h.controls.continueRun(run.id);

    expect(h.partials).toHaveLength(1);
    expect(h.partials[0]?.nodeRuns.map((row) => [row.nodeId, row.attempt])).toEqual([[join.id, 2]]);
    expect(h.stores.nodeRunRows.size).toBe(6);
  });

  it('an agentic node left BLOCKED by an engine restart (D379) is continued like a STOPPED one', async () => {
    const run = cutOff();
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(run, a.id, {
          status: 'BLOCKED',
          failureReason: 'BLOCKED',
          error: { ...restartedError, code: 'engine_restarted' },
        }),
        makeNodeRun(run, b.id, {
          status: 'BLOCKED',
          failureReason: 'BLOCKED',
          error: { ...restartedError, code: 'approval_lost' },
        }),
      ],
    });

    await h.controls.continueRun(run.id);

    expect(h.partials[0]?.nodeRuns.map((row) => row.nodeId).sort()).toEqual([a.id, b.id].sort());
    expect(h.partials[0]?.nodeRuns.every((row) => row.status === 'READY')).toBe(true);
    // Its own BLOCKED row is not cleared: the retry is what runs.
    expect(idleFrames(h)).toEqual([]);
  });

  it('a row BLOCKED by an upstream failure downstream of what continues is cleared to IDLE, not retried', async () => {
    /* The parallel graph, plus Brief → Side → SideEnd off to one side. */
    const side = agentNode('Side');
    const sideEnd = outputNode('SideEnd');
    const run = cutOff({
      haltReason: 'stopped',
      snapshot: {
        version: 5,
        nodes: [...parallel.nodes, side, sideEnd],
        edges: [...parallel.edges, edge(brief, side), edge(side, sideEnd)],
      },
    });
    const blockedJoin = makeNodeRun(run, join.id, {
      status: 'BLOCKED',
      failureReason: 'BLOCKED',
      error: { ...upstreamError, code: 'upstream_failed' },
    });
    const blockedSideEnd = makeNodeRun(run, sideEnd.id, {
      status: 'BLOCKED',
      failureReason: 'BLOCKED',
      error: { ...upstreamError, code: 'upstream_failed' },
    });
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(run, a.id, { status: 'FAILED', failureReason: 'RUN_FAILED' }),
        makeNodeRun(run, b.id, { status: 'STOPPED' }),
        makeNodeRun(run, side.id, { status: 'FAILED', failureReason: 'RUN_FAILED' }),
        blockedJoin,
        blockedSideEnd,
      ],
    });

    await h.controls.continueRun(run.id);

    // Only B was cut off; A failed, and a failure is a Retry, not a Continue.
    expect(h.partials[0]?.nodeRuns.map((row) => row.nodeId)).toEqual([b.id]);
    expect(h.stores.nodeRunRows.get(blockedJoin.id)?.status).toBe('IDLE');
    // Nothing that continues reaches SideEnd: its block stands.
    expect(h.stores.nodeRunRows.get(blockedSideEnd.id)?.status).toBe('BLOCKED');
    expect(idleFrames(h)).toEqual([join.id]);
  });

  it.each(['crash', 'shutdown', 'stopped'] as const)(
    'continues a run HALTED `%s`',
    async (haltReason) => {
      const run = cutOff({ haltReason });
      const h = harness({ runs: [run], nodeRuns: [makeNodeRun(run, a.id, { status: 'STOPPED' })] });
      await expect(h.controls.continueRun(run.id)).resolves.toMatchObject({ status: 'RUNNING' });
      expect(h.partials).toHaveLength(1);
    },
  );

  it.each(['failure', 'budget_exceeded'] as const)(
    'refuses a run HALTED `%s` with 409 `invalid_run_state`, and writes nothing',
    async (haltReason) => {
      const run = cutOff({ haltReason });
      const h = harness({ runs: [run], nodeRuns: [makeNodeRun(run, a.id, { status: 'STOPPED' })] });

      const refused = h.controls.continueRun(run.id);
      await expect(refused).rejects.toMatchObject({
        status: 409,
        code: 'invalid_run_state',
        details: { runId: run.id, status: 'HALTED', haltReason, allowedActions: ['restart'] },
      });
      expect(h.partials).toEqual([]);
      expect(h.stores.nodeRunRows.size).toBe(1);
      expect(h.stores.runPatches).toEqual([]);
    },
  );

  it.each(['RUNNING', 'PAUSED', 'COMPLETE', 'BLOCKED'] as const)(
    'refuses a run that is %s with 409 `invalid_run_state`',
    async (status) => {
      const run = makeRun({ snapshot: parallel, status });
      const h = harness({ runs: [run], nodeRuns: [makeNodeRun(run, a.id, { status: 'STOPPED' })] });

      await expect(h.controls.continueRun(run.id)).rejects.toMatchObject({
        status: 409,
        code: 'invalid_run_state',
        details: { status },
      });
      expect(h.partials).toEqual([]);
      expect(h.stores.runRows.get(run.id)?.status).toBe(status);
    },
  );

  it('refuses a run HALTED `stopped` with nothing cut off: 409 `nothing_to_continue`', async () => {
    const run = cutOff({ haltReason: 'stopped' });
    const h = harness({
      runs: [run],
      nodeRuns: [
        makeNodeRun(run, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(run, a.id, { status: 'FAILED', failureReason: 'RUN_FAILED' }),
      ],
    });

    await expect(h.controls.continueRun(run.id)).rejects.toMatchObject({
      status: 409,
      code: 'nothing_to_continue',
      message: 'Nothing in this run was cut off — retry a failed node or restart the run.',
    });
    expect(h.partials).toEqual([]);
    expect(h.stores.runRows.get(run.id)?.status).toBe('HALTED');
  });

  it('answers 404 for a run that does not exist', async () => {
    const h = harness();
    await expect(h.controls.continueRun('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a Domain run that was stopped carries on too, with its own controls (D323)', async () => {
    const domain = {
      routing: 'supervised' as const,
      loopGuardLimit: 3,
      tokenBudget: null,
      stayOpen: true,
    };
    const run = cutOff({ haltReason: 'stopped', domain });
    const h = harness({ runs: [run], nodeRuns: [makeNodeRun(run, a.id, { status: 'STOPPED' })] });

    const continued = await h.controls.continueRun(run.id);

    expect(continued.status).toBe('RUNNING');
    expect(continued.allowedActions).toContain('end');
    expect(h.partials[0]?.run.domain).toEqual(domain);
  });
});
