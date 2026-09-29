import { allowedRunActions, type NodeRun } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import type { NodeRunPatch } from '../ports/index.js';
import { createRunDriverHarness, deferred, scope, type RunDriverHarness } from './run-driver-harness.js';

/**
 * FR-EXE-011 / FR-ERR-006: an error the engine did not expect while it dispatches or finishes a node.
 *
 * FR-EXE-011 says a run ends COMPLETE or HALTED — there is no third ending in which it stays RUNNING
 * because a write threw. So the node the engine could not finish fails with an engine error, what is
 * downstream of it is BLOCKED like downstream of any failure, what is still in flight finishes, and
 * the run ends HALTED `failure` with its `run.completed`.
 */

const REFUSED = 'REFUSED BY STORAGE';

/** The store refuses to record this one output, the way storage-local refuses a key-shaped write. */
function refuseOutput(h: RunDriverHarness): void {
  const update = h.repository.nodeRuns.update;
  h.repository.nodeRuns.update = async (at, id, patch: NodeRunPatch) => {
    const refused = patch.output?.some((part) => part.type === 'text' && part.text.includes(REFUSED));
    if (refused === true) throw new Error('the value looks like a credential');
    return update(at, id, patch);
  };
}

const runCompleted = (h: RunDriverHarness, runId: string) =>
  h.events.filter((event) => event.type === 'run.completed' && event.runId === runId);

describe('FR-EXE-011 FR-ERR-006 a node the engine cannot finish fails, and the run still ends', () => {
  it('fails the node with an engine error, blocks its downstream and halts the run `failure`', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const editor = h.agentNode('Editor');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ text: REFUSED }]);
    await h.seed(
      [brief, writer, editor, result],
      [h.edge(brief, writer), h.edge(writer, editor), h.edge(editor, result)],
    );
    refuseOutput(h);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await done;

    const [failed] = await h.nodeRunsOf(run.id, writer.id);
    expect(failed).toMatchObject({
      status: 'FAILED',
      failureReason: 'RUN_FAILED',
      error: { kind: 'workflow', code: 'internal', retryable: false },
    });
    expect(failed?.endedAt).toBeDefined();
    expect(h.framesOf(writer.id).at(-1)).toBe('1:FAILED');

    // FR-ERR-006: BLOCKED, never FAILED, and never called.
    for (const node of [editor, result]) {
      expect((await h.nodeRunsOf(run.id, node.id)).map((row: NodeRun) => row.status)).toEqual([
        'BLOCKED',
      ]);
    }
    expect(h.calls('Editor')).toBe(0);

    expect(await h.runRow(run.id)).toMatchObject({
      status: 'HALTED',
      haltReason: 'failure',
      allowedActions: allowedRunActions('HALTED'),
    });
    const completed = runCompleted(h, run.id);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect(h.approvalsCancelledFor).toContain(run.id);
  });

  it('lets the other branch in flight finish before the run ends, instead of orphaning it', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const a = h.agentNode('A');
    const b = h.agentNode('B');
    const resultA = h.outputNode('ResultA');
    const resultB = h.outputNode('ResultB');
    const slowB = deferred();
    h.scripts.set('A', [{ text: REFUSED }]);
    h.scripts.set('B', [{ hold: slowB.promise, text: 'b' }]);
    await h.seed(
      [brief, a, b, resultA, resultB],
      [h.edge(brief, a), h.edge(brief, b), h.edge(a, resultA), h.edge(b, resultB)],
    );
    refuseOutput(h);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(a.id, 'FAILED');
    expect(runCompleted(h, run.id)).toHaveLength(0);
    slowB.resolve();
    await done;

    expect((await h.nodeRunsOf(run.id, b.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    expect((await h.nodeRunsOf(run.id, resultB.id)).map((row) => row.status)).toEqual([
      'COMPLETED',
    ]);
    expect((await h.nodeRunsOf(run.id, resultA.id)).map((row) => row.status)).toEqual(['BLOCKED']);
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect(runCompleted(h, run.id)).toHaveLength(1);
  });

  it('halts the run `failure` with run.completed when the drive itself throws', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
    h.repository.settings.get = async () => {
      throw new Error('the settings table is locked');
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await done;

    expect(await h.runRow(run.id)).toMatchObject({
      status: 'HALTED',
      haltReason: 'failure',
      allowedActions: allowedRunActions('HALTED'),
    });
    expect((await h.repository.runs.get(scope, run.id))?.endedAt).toBeDefined();
    expect(runCompleted(h, run.id).map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: 'HALTED', haltReason: 'failure' }),
    ]);
    expect(h.approvalsCancelledFor).toContain(run.id);
    expect(h.calls('Writer')).toBe(0);
  });
});
