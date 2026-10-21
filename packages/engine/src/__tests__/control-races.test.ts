import type { Run } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../gateway/errors.js';
import { createRunGate } from '../runs/control/gate.js';
import {
  createRunDriverHarness,
  httpError,
  scope,
  untilAborted,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * [audit E-5] Run controls that race each other or the drive (FR-CTL-001..006, FR-ERR-003, D81).
 *
 * A control reads the run, checks the action is allowed, and writes. Between the read and the write
 * a second click — or the drive finishing — could move the run on, and both writes landed: a double
 * Retry made two attempt-2 rows and two drives on one run, a Pause landing as the run completed
 * turned COMPLETE into a PAUSED nobody would ever resume. The write is now a compare-and-set on the
 * status the control checked, and a lost race answers the 409 `invalid_run_state`.
 */

const runCompleted = (h: RunDriverHarness, runId: string) =>
  h.events.filter((event) => event.type === 'run.completed' && event.runId === runId);

function isConflict(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof HttpError &&
    result.reason.status === 409 &&
    result.reason.code === 'invalid_run_state'
  );
}

/** Brief → Writer → Result, the Writer failing once and then answering. */
async function haltedOnWriter(h: RunDriverHarness) {
  const brief = h.inputNode();
  const writer = h.agentNode('Writer');
  const result = h.outputNode();
  h.scripts.set('Writer', [{ throws: httpError(503) }, { text: 'second go' }]);
  await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
  const { run, done } = await h.start();
  expect(await done).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
  const [failed] = await h.nodeRunsOf(run.id, writer.id);
  return { run, writer, result, failed: failed! };
}

describe('[audit E-5] controls that race', () => {
  it('two Retries at once: one reopens the run, the other is a 409 and writes nothing', async () => {
    const h = await createRunDriverHarness();
    const { run, writer, result, failed } = await haltedOnWriter(h);

    const settled = await Promise.allSettled([
      h.controls.retryNodeRun(failed.id, { withDownstream: true }),
      h.controls.retryNodeRun(failed.id, { withDownstream: true }),
    ]);

    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(isConflict)).toHaveLength(1);

    await h.waitFor(() => runCompleted(h, run.id).length === 2, 'the reopened run to end');
    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    // One attempt 2, not two — and one drive called the Writer once more, not twice.
    expect((await h.nodeRunsOf(run.id, writer.id)).map((row) => row.attempt)).toEqual([1, 2]);
    expect(h.calls('Writer')).toBe(2);
    expect((await h.nodeRunsOf(run.id, result.id)).map((row) => row.status)).toContain('COMPLETED');
  });

  it('a Pause that read the run RUNNING but lands after it COMPLETED is refused, and the run stays COMPLETE', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
    const { run, done } = await h.start();
    expect((await done).status).toBe('COMPLETE');

    // The Pause's read happened while the run was still going: it saw RUNNING.
    const get = h.repository.runs.get;
    let stale = true;
    h.repository.runs.get = async (at, id) => {
      const row = await get(at, id);
      if (!stale || row === null) return row;
      stale = false;
      return { ...row, status: 'RUNNING' } satisfies Run;
    };

    const [paused] = await Promise.allSettled([h.controls.pause(run.id)]);
    expect(isConflict(paused!)).toBe(true);
    expect((paused as PromiseRejectedResult).reason.details).toMatchObject({ status: 'COMPLETE' });
    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    expect(h.indexOf('run.paused')).toBe(-1);
  });

  it('two Stops at once: the run halts once, with one run.completed', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ hold: untilAborted() }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
    const { run, done } = await h.start();
    await h.waitForState(writer.id, 'RUNNING');

    const settled = await Promise.allSettled([h.controls.stop(run.id), h.controls.stop(run.id)]);
    await done;

    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(isConflict)).toHaveLength(1);
    expect(runCompleted(h, run.id)).toHaveLength(1);
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });

  it('a Retry while the drive that ended the run is still winding down is refused', async () => {
    const h = await createRunDriverHarness();
    const { run, writer, failed } = await haltedOnWriter(h);
    // The run reads HALTED, but its drive still holds its gate (a Stop writes HALTED at once).
    const unregister = h.gates.register(createRunGate(run.id));

    await expect(h.controls.retryNodeRun(failed.id, { withDownstream: true })).rejects.toMatchObject({
      code: 'invalid_run_state',
    });
    expect((await h.nodeRunsOf(run.id, writer.id)).map((row) => row.attempt)).toEqual([1]);
    expect((await h.repository.runs.get(scope, run.id))?.status).toBe('HALTED');

    // Once it has let go, the same Retry goes ahead.
    unregister();
    await h.controls.retryNodeRun(failed.id, { withDownstream: true });
    await h.waitFor(() => runCompleted(h, run.id).length === 2, 'the reopened run to end');
    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
  });
});
