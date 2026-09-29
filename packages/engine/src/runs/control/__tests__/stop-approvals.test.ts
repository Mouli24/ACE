import type { ApprovalDecision, Id } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../logging/index.js';
import { createRunGate, createRunGateRegistry } from '../gate.js';
import { createRunControls } from '../service.js';
import {
  createCapturedBus,
  createFakeStores,
  makeNodeRun,
  makeRun,
  tickingClock,
} from './harness.js';

/**
 * D-054 at the Stop control (FR-CTL-003, FR-GRD-013, D110, D111): the stop aborts first, then
 * rejects the approvals still waiting on the run — before it writes a row — so no card outlives the
 * run and a late Approve has nothing to decide. The cancellation is best effort: a stop that could
 * not cancel still halts the run.
 */

function harness(cancelPending: (runId: Id, note: string) => Promise<ApprovalDecision[]>) {
  const run = makeRun();
  const waiting = makeNodeRun(run, 'writer-node', { status: 'WAITING' });
  const stores = createFakeStores({ runs: [run], nodeRuns: [waiting] });
  const bus = createCapturedBus();
  const gates = createRunGateRegistry();
  const gate = createRunGate(run.id);
  gates.register(gate);
  /** The warnings the stop logged, by message (pino writes one JSON line per entry). */
  const warnings: string[] = [];
  const logger = createLogger({
    level: 'warn',
    destination: {
      write: (line) => {
        warnings.push((JSON.parse(line) as { msg: string }).msg);
      },
    },
  });

  const controls = createRunControls({
    runs: stores.runs,
    nodeRuns: stores.nodeRuns,
    bus,
    gates,
    approvals: { cancelPending },
    logger,
    now: tickingClock(),
    driveRecordedRun: async (row) => row,
    drivePartialRun: async (plan) => plan.run,
  });

  return { run, waiting, stores, gate, controls, warnings };
}

describe('FR-CTL-003 FR-GRD-013 D-054 Stop cancels the approvals of the run it stops', () => {
  it('aborts first, then rejects what is pending, before any row is written', async () => {
    const seen: { runId: Id; note: string; aborted: boolean; rowsWritten: number }[] = [];
    const h = harness(async (runId, note) => {
      seen.push({
        runId,
        note,
        aborted: h.gate.isAborted(),
        rowsWritten: h.stores.nodeRunPatches.length + h.stores.runPatches.length,
      });
      return [];
    });

    const halted = await h.controls.stop(h.run.id);

    expect(seen).toEqual([
      {
        runId: h.run.id,
        note: 'The run was stopped before this was decided.',
        aborted: true,
        rowsWritten: 0,
      },
    ]);
    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.stores.nodeRunRows.get(h.waiting.id)?.status).toBe('STOPPED');
  });

  it('still halts the run when the approvals could not be cancelled', async () => {
    const h = harness(async () => {
      throw new Error('the approvals table is locked');
    });

    const halted = await h.controls.stop(h.run.id);

    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.stores.nodeRunRows.get(h.waiting.id)?.status).toBe('STOPPED');
    expect(h.warnings).toEqual(['could not cancel the approvals of a stopped run']);
  });
});
