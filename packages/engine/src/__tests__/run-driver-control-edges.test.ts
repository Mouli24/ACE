import { describe, expect, it } from 'vitest';

import { countNodeOutcomes } from '../errors/index.js';
import type { NodeRunPatch } from '../ports/index.js';
import {
  createRunDriverHarness,
  deferred,
  httpError,
  PROVIDER_ID,
  scope,
  untilAborted,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * The corners of the run-control fixes: a shutdown instead of a stop, a pause the controls did not
 * write, and a store that keeps failing. Each is the same rule as its main case — a node that has
 * not started never starts under a pause or an abort, a stop is never a failure, and a run always
 * reaches its end (FR-CTL-001..003, FR-ERR-007, FR-EXE-011, FR-SYS-008).
 */

const runCompleted = (h: RunDriverHarness, runId: string) =>
  h.events.filter((event) => event.type === 'run.completed' && event.runId === runId);

describe('FR-SYS-008 FR-ERR-007 a shutdown during a retry backoff', () => {
  it('ends the pending attempt STOPPED and announces it itself, since no control will', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer', { retries: 2 });
    const result = h.outputNode();
    h.scripts.set('Writer', [{ throws: httpError(503) }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'READY', 2);
    await h.service.shutdown();
    await done;

    expect(h.framesOf(writer.id)).toEqual([
      '1:READY',
      '1:RUNNING',
      '1:FAILED',
      '2:READY',
      '2:STOPPED',
    ]);
    const [, pending] = await h.nodeRunsOf(run.id, writer.id);
    expect(pending).toMatchObject({ status: 'STOPPED', error: { kind: 'user_cancelled' } });
    expect(pending?.endedAt).toBeDefined();
    expect(h.calls('Writer')).toBe(1);
    expect(countNodeOutcomes(await h.nodeRunsOf(run.id)).failed).toBe(0);
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'shutdown' });
  });
});

describe('FR-CTL-001 FR-CTL-002 FR-CTL-003 a node the pause parked away from its provider slot', () => {
  it('is stopped where it waits, READY → PAUSED → STOPPED, and never called', async () => {
    const h = await createRunDriverHarness({ providerConcurrency: 1 });
    const brief = h.inputNode();
    const a = h.agentNode('A');
    const b = h.agentNode('B');
    const resultA = h.outputNode('ResultA');
    const resultB = h.outputNode('ResultB');
    const release = deferred();
    h.scripts.set('A', [{ hold: release.promise, text: 'a' }]);
    h.scripts.set('B', [{ hold: release.promise, text: 'b' }]);
    await h.seed(
      [brief, a, b, resultA, resultB],
      [h.edge(brief, a), h.edge(brief, b), h.edge(a, resultA), h.edge(b, resultB)],
    );

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitFor(
      () => [a, b].some((node) => h.framesOf(node.id).includes('1:RUNNING')),
      'one agent to hold the slot',
    );
    const [first, queued] = h.framesOf(a.id).includes('1:RUNNING') ? [a, b] : [b, a];
    await h.controls.pause(run.id);
    release.resolve();
    await h.waitForState(first.id, 'COMPLETED');
    // Parked: the slot came free under the pause and was handed straight back.
    expect((await h.providers.semaphoreFor(PROVIDER_ID)).inFlight()).toBe(0);

    await h.controls.stop(run.id);
    await done;

    expect(h.framesOf(queued.id)).toEqual(['1:READY', '1:PAUSED', '1:STOPPED']);
    expect(h.calls(queued.name)).toBe(0);
  });
});

describe('FR-CTL-002 Arch §19.1 a node run born PAUSED that no resume moved', () => {
  it('goes back to READY before it starts, so it still walks PAUSED → READY → RUNNING', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer', { retries: 1 });
    const result = h.outputNode();
    const firstCall = deferred();
    h.scripts.set('Writer', [{ hold: firstCall.promise, throws: httpError(503) }, { text: 'ok' }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'RUNNING');
    // The gate alone, with no control writing rows: the shape of a resume that listed the PAUSED
    // rows before this one was created, and lifted the gate after.
    const gate = h.gates.get(run.id);
    gate?.pause();
    firstCall.resolve();
    await h.waitForState(writer.id, 'PAUSED', 2);
    gate?.resume();
    await done;

    expect(h.framesOf(writer.id).filter((frame) => frame.startsWith('2:'))).toEqual([
      '2:PAUSED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
  });
});

describe('FR-ERR-007 FR-EXE-011 an engine error while a stopped node unwinds', () => {
  it('does not turn the stop into a failure', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ hold: untilAborted() }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
    // The control's own move (status + endedAt) is stored; the drive's record of the cut attempt is not.
    const update = h.repository.nodeRuns.update;
    h.repository.nodeRuns.update = async (at, id, patch: NodeRunPatch) => {
      if (patch.status === 'STOPPED' && patch.usage !== undefined) throw new Error('disk full');
      return update(at, id, patch);
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'RUNNING');
    await h.controls.stop(run.id);
    await done;

    const rows = await h.nodeRunsOf(run.id);
    expect(rows.find((row) => row.nodeId === writer.id)?.status).toBe('STOPPED');
    expect(countNodeOutcomes(rows).failed).toBe(0);
    expect(h.events.some((event) => event.type === 'node.error')).toBe(false);
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });
});

describe('FR-EXE-011 every step of failing an unfinishable node is best effort', () => {
  it('still ends the run when the store refuses the failure and the BLOCKED rows as well', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const editor = h.agentNode('Editor');
    const result = h.outputNode();
    await h.seed(
      [brief, writer, editor, result],
      [h.edge(brief, writer), h.edge(writer, editor), h.edge(editor, result)],
    );
    const update = h.repository.nodeRuns.update;
    h.repository.nodeRuns.update = async (at, id, patch: NodeRunPatch) => {
      const writerRow = (await h.repository.nodeRuns.get(at, id))?.nodeId === writer.id;
      if (writerRow && (patch.status === 'COMPLETED' || patch.status === 'FAILED')) {
        throw new Error('disk full');
      }
      return update(at, id, patch);
    };
    const create = h.repository.nodeRuns.create;
    h.repository.nodeRuns.create = async (at, nodeRun) => {
      if (nodeRun.status === 'BLOCKED') throw new Error('disk full');
      return create(at, nodeRun);
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await done;

    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect(runCompleted(h, run.id)).toHaveLength(1);
    expect(h.calls('Editor')).toBe(0);
  });
});

describe('FR-ERR-001 a provider state that cannot be stored', () => {
  it('does not change how the node ended', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ throws: httpError(401) }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
    h.providers.recordStatus = async () => {
      throw new Error('the providers table is locked');
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await done;

    expect((await h.nodeRunsOf(run.id, writer.id))[0]).toMatchObject({
      status: 'FAILED',
      error: { kind: 'auth' },
    });
    expect((await h.repository.providers.get(scope, PROVIDER_ID))?.status).toBe('CONNECTED');
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
  });
});

describe('FR-EXE-011 when the drive itself throws', () => {
  it('keeps the ending of a run that had already ended', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const result = h.outputNode();
    await h.seed([brief, result], [h.edge(brief, result)]);
    const append = h.repository.events.append;
    h.repository.events.append = async (at, event) => {
      if (event.type === 'run.completed') throw new Error('the event log is full');
      return append(at, event);
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});

    expect(await done).toMatchObject({ id: run.id, status: 'COMPLETE' });
    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
  });

  it('never rejects `done`, even when the store refuses to halt the run', async () => {
    const h = await createRunDriverHarness({
      onCancelPending: () => {
        throw new Error('the approvals table is locked');
      },
    });
    const brief = h.inputNode();
    const result = h.outputNode();
    await h.seed([brief, result], [h.edge(brief, result)]);
    const update = h.repository.runs.update;
    h.repository.runs.update = async (at, id, patch) => {
      if (patch.status === 'HALTED') throw new Error('disk full');
      return update(at, id, patch);
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});

    await expect(done).resolves.toMatchObject({ id: run.id });
  });
});
