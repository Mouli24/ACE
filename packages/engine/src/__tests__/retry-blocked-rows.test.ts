import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, httpError, type RunDriverHarness } from './run-driver-harness.js';

/**
 * [audit E-13] The BLOCKED rows of a run that is retried (FR-ERR-003, FR-ERR-004, FR-ERR-006).
 *
 * A retry with downstream clears the BLOCKED rows after the failed node to IDLE so they can run
 * again. Those rows then stayed IDLE for ever — superseded by a new attempt, or never reached —
 * and a node blocked a second time got a second row at iteration 1, attempt 1 beside the first.
 */

const rowsOf = async (h: RunDriverHarness, runId: string, nodeId: string) =>
  (await h.nodeRunsOf(runId, nodeId)).map((row) => `${row.attempt}:${row.status}`);

async function writerChain(h: RunDriverHarness) {
  const brief = h.inputNode();
  const writer = h.agentNode('Writer');
  const editor = h.agentNode('Editor');
  const result = h.outputNode();
  await h.seed(
    [brief, writer, editor, result],
    [h.edge(brief, writer), h.edge(writer, editor), h.edge(editor, result)],
  );
  const { run, done } = await h.start();
  expect((await done).status).toBe('HALTED');
  const [failed] = await h.nodeRunsOf(run.id, writer.id);
  return { run, writer, editor, result, failed: failed! };
}

const runEnds = (h: RunDriverHarness, runId: string, count: number) =>
  h.waitFor(
    () =>
      h.events.filter((event) => event.type === 'run.completed' && event.runId === runId).length ===
      count,
    `the run to end ${count} times`,
  );

describe('[audit E-13] no IDLE row outlives a retry', () => {
  it('a retry that fails again blocks the same rows again, and adds none', async () => {
    const h = await createRunDriverHarness();
    h.scripts.set('Writer', [{ throws: httpError(503) }]);
    const { run, editor, result, failed } = await writerChain(h);
    expect(await rowsOf(h, run.id, editor.id)).toEqual(['1:BLOCKED']);

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });
    await runEnds(h, run.id, 2);

    expect((await h.runRow(run.id)).status).toBe('HALTED');
    for (const node of [editor, result]) {
      expect(await rowsOf(h, run.id, node.id)).toEqual(['1:BLOCKED']);
    }
  });

  it('a retry that succeeds keeps the old row BLOCKED beside the new attempt', async () => {
    const h = await createRunDriverHarness();
    h.scripts.set('Writer', [{ throws: httpError(503) }, { text: 'second go' }]);
    const { run, editor, failed } = await writerChain(h);

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });
    await runEnds(h, run.id, 2);

    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    expect(await rowsOf(h, run.id, editor.id)).toEqual(['1:BLOCKED', '2:COMPLETED']);
    const all = await h.nodeRunsOf(run.id);
    expect(all.filter((row) => row.status === 'IDLE')).toEqual([]);
  });

  it('a node blocked again after its retried upstream ran never shares an attempt number', async () => {
    const h = await createRunDriverHarness();
    // The first retry fails too; the second succeeds.
    h.scripts.set('Writer', [
      { throws: httpError(503) },
      { throws: httpError(503) },
      { text: 'ok' },
    ]);
    const { run, writer, editor, failed } = await writerChain(h);

    await h.controls.retryNodeRun(failed.id, { withDownstream: true });
    await runEnds(h, run.id, 2);
    const [, second] = await h.nodeRunsOf(run.id, writer.id);
    await h.controls.retryNodeRun(second!.id, { withDownstream: true });
    await runEnds(h, run.id, 3);

    const editorRows = await h.nodeRunsOf(run.id, editor.id);
    const keys = editorRows.map((row) => `${row.iteration}:${row.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(editorRows.at(-1)?.status).toBe('COMPLETED');
  });
});
