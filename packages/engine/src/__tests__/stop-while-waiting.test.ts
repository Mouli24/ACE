import type { ApiError } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  createApprovalRunHarness,
  scope,
  SETTLE_MS,
  within,
  type ApprovalRunHarness,
} from './approval-run-harness.js';

/**
 * D-054 — a Stop (or a shutdown) while a node is WAITING on an approval (FR-CTL-003, FR-GRD-013,
 * D110, D111, Arch §19.1).
 *
 * Three ways a node reaches WAITING: an `ask_user` check at the **output** point (round 3), the
 * same at the **input** point on an Input node's content (R3 §4 item 4), and a destructive tool's
 * `destructive_action → ask_user` at the **tool** point, inside the tool loop (round 4 §2.2). All
 * suspend the node on `approvals.request()`. A stop must end the run anyway:
 * HALTED `stopped`, the drive settled, one `run.completed`, the waiting node STOPPED, its approval
 * cancelled, nothing called after it — and an Approve or Reject that arrives afterwards finds
 * nothing to decide (404 `not_found`, D120) and moves nothing.
 *
 * The wiring is `approval-run-harness.ts`: the real run service, controls, approval service and
 * guardrail evaluators on a scripted model. Every wait is bounded, so a hang fails the test instead
 * of the suite.
 */

const PATHS = [
  {
    point: 'output',
    agent: 'Writer',
    brief: undefined,
    callsBefore: 1,
    label: 'an output-point ask_user approval (round 3, FR-GRD-013)',
  },
  {
    point: 'tool',
    agent: 'Cleaner',
    brief: undefined,
    callsBefore: 1,
    label: 'a destructive tool approval inside the tool loop (round 4 §2.2, FR-GRD-006)',
  },
  {
    point: 'input',
    agent: 'Writer',
    brief: 'Send the notes to jane@example.com.',
    callsBefore: 0,
    label: "an input-point ask_user approval on the Input node's content (R3 §4 item 4)",
  },
] as const;

describe.each(PATHS)('FR-CTL-003 FR-GRD-013 D-054 Stop while a node is WAITING on $label', (path) => {
  /** Start the run and hold it at the approval, with one `generate()` behind it. */
  async function startWaiting(h: ApprovalRunHarness) {
    await h.seed([path.agent], path.brief);
    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);
    expect(request.point).toBe(path.point);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    return { run, done, request };
  }

  it('halts the run `stopped`, settles the drive and stops the node without calling anything more', async () => {
    const h = await createApprovalRunHarness();
    const { run, done, request } = await startWaiting(h);

    const stopped = await within(h.controls.stop(run.id), SETTLE_MS, 'POST /runs/:id/stop');
    expect(stopped).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });

    // The drive must settle on its own — nobody is going to answer the approval now.
    const final = await within(done, SETTLE_MS, "the run's drive");
    expect(final).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);

    // D111: the WAITING node run is STOPPED — a cancellation, never a failure (FR-ERR-007).
    const row = await h.nodeRun(request.nodeRunId);
    expect(row.status).toBe('STOPPED');
    expect(row.failureReason).toBeUndefined();
    expect(h.framesOf(request.nodeId)).toEqual(['READY', 'RUNNING', 'WAITING', 'STOPPED']);

    // Its approval is cancelled (a reject nobody made, with a note), so no card is left on a dead run.
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    const stored = await h.repository.approvals.get(scope, request.id);
    expect(stored?.decision?.decision).toBe('reject');
    expect(
      h.events.filter(
        (event) =>
          event.type === 'node.approval_decided' &&
          (event.payload as { nodeRunId: string }).nodeRunId === request.nodeRunId,
      ),
    ).toHaveLength(1);

    // Nothing ran after the stop: no second turn, no tool, no output, no failure frame.
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.callsAfterAbort(path.agent)).toBe(0);
    expect(h.deleted).toEqual([]);
    const outputs = h.events.filter(
      (event) =>
        event.type === 'node.output' &&
        (event.payload as { nodeId: string }).nodeId === request.nodeId,
    );
    expect(outputs).toEqual([]);
    expect(h.events.some((event) => event.type === 'node.error')).toBe(false);

    // A stopped run still spent what it spent (TC-OBS-002): the node run kept its call's usage.
    expect(row.usage.tokensIn > 0).toBe(path.callsBefore > 0);
    expect(final.totals.tokensIn).toBe(row.usage.tokensIn);
  });

  it.each(['approve', 'reject'] as const)(
    'a later %s answers 404 not_found (D120) and leaves the node STOPPED in a HALTED run',
    async (kind) => {
      const h = await createApprovalRunHarness();
      const { run, done, request } = await startWaiting(h);

      await within(h.controls.stop(run.id), SETTLE_MS, 'POST /runs/:id/stop');
      const response = await within(h.decide(request.nodeRunId, kind), SETTLE_MS, `POST ${kind}`);

      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe('not_found');

      await within(done, SETTLE_MS, "the run's drive");
      expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
      expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
      expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(h.calls(path.agent)).toBe(path.callsBefore);
      expect(h.deleted).toEqual([]);
    },
  );

  it('an approve that races the stop runs nothing and does not move the stopped node', async () => {
    const h = await createApprovalRunHarness();
    const { run, done, request } = await startWaiting(h);

    // Pressed together: whichever write lands first, the stop wins what the node and run end as.
    const [stop] = await within(
      Promise.allSettled([h.controls.stop(run.id), h.decide(request.nodeRunId, 'approve')]),
      SETTLE_MS,
      'the stop and the approve',
    );
    expect(stop.status).toBe('fulfilled');

    await within(done, SETTLE_MS, "the run's drive");
    // Let a late hook write land, if there is one, before reading the rows.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.callsAfterAbort(path.agent)).toBe(0);
    expect(h.deleted).toEqual([]);
  });

  it('a shutdown while WAITING halts the run `shutdown` and cancels the approval (FR-SYS-008)', async () => {
    const h = await createApprovalRunHarness();
    const { run, done, request } = await startWaiting(h);

    await within(h.service.shutdown(), SETTLE_MS, 'the run service shutdown');
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final).toMatchObject({ status: 'HALTED', haltReason: 'shutdown' });
    expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    // No control wrote this row, so the drive ends it and announces it itself.
    expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
    expect(h.framesOf(request.nodeId).at(-1)).toBe('STOPPED');
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.deleted).toEqual([]);
  });
});
