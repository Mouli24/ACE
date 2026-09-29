import type { Usage } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { countNodeOutcomes } from '../errors/index.js';
import { createRunControls, createRunGateRegistry, sumUsage } from '../runs/index.js';
import {
  createCapturedBus,
  createFakeStores,
  makeNodeRun,
  makeRun,
  tickingClock,
} from '../runs/control/__tests__/harness.js';
import { createRunDriverHarness, httpError, untilAborted } from './run-driver-harness.js';

/**
 * FR-CTL-003 / FR-ERR-007 / TC-ERR-008: what a Stop leaves behind.
 *
 * A stop is not a failure, so it blocks nothing downstream — BLOCKED means "an upstream failed"
 * (FR-ERR-006) — and nothing is written or announced for the run after its `run.completed`. And a
 * stopped run still spent what it spent: its totals are the sum of its node runs (TC-OBS-002), not
 * the zeros it was created with.
 */

const totalsOf = (usages: readonly Usage[]) => {
  const { tokensIn, tokensOut, costUsd } = sumUsage(usages);
  return { tokensIn, tokensOut, costUsd };
};

describe('FR-CTL-003 FR-ERR-007 a stop blocks nothing downstream', () => {
  it('leaves the nodes after a stopped one untouched, and announces nothing after run.completed', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const editor = h.agentNode('Editor');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ hold: untilAborted() }]);
    await h.seed(
      [brief, writer, editor, result],
      [h.edge(brief, writer), h.edge(writer, editor), h.edge(editor, result)],
    );

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'RUNNING');
    await h.controls.stop(run.id);
    await done;

    expect(await h.nodeRunsOf(run.id, editor.id)).toEqual([]);
    expect(await h.nodeRunsOf(run.id, result.id)).toEqual([]);
    expect(h.framesOf(editor.id)).toEqual([]);
    expect(h.framesOf(result.id)).toEqual([]);

    const counts = countNodeOutcomes(await h.nodeRunsOf(run.id));
    expect(counts).toMatchObject({ completed: 1, stopped: 1, failed: 0, blocked: 0 });

    const completedAt = h.indexOf('run.completed');
    expect(completedAt).toBeGreaterThan(-1);
    const lateStates = h.events
      .slice(completedAt + 1)
      .filter((event) => event.type === 'node.state' || event.type === 'node.error');
    expect(lateStates).toEqual([]);
  });
});

describe('TC-ERR-008 TC-OBS-002 a stopped run totals what its node runs spent', () => {
  it('writes the sum of every attempt on the row and on run.completed, failed attempts included', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const a = h.agentNode('A');
    const b = h.agentNode('B', { retries: 1 });
    const result = h.outputNode();
    h.scripts.set('A', [{ text: 'a' }]);
    // B's first attempt spends 5 in / 1 out before the provider gives up on it.
    h.scripts.set('B', [{ usageFirst: { tokensIn: 5, tokensOut: 1 }, throws: httpError(503) }]);
    await h.seed([brief, a, b, result], [h.edge(brief, a), h.edge(a, b), h.edge(b, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(b.id, 'READY', 2);
    await h.controls.stop(run.id);
    await done;

    const spent = totalsOf((await h.nodeRunsOf(run.id)).map((row) => row.usage));
    expect(spent).toMatchObject({ tokensIn: 2 + 5, tokensOut: 3 + 1 });
    expect(spent.costUsd).toBeGreaterThan(0);

    const row = await h.runRow(run.id);
    expect(row).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(row.totals).toMatchObject(spent);

    const completed = h.events.filter((event) => event.type === 'run.completed');
    expect(completed).toHaveLength(1);
    expect((completed[0]?.payload as { totals: Usage }).totals).toMatchObject(spent);
  });

  it('D113: totals a run this process is not driving from its rows, just the same', async () => {
    const run = makeRun({ status: 'RUNNING' });
    const spentBefore = makeNodeRun(run, 'done', {
      status: 'COMPLETED',
      usage: { tokensIn: 11, tokensOut: 4, costUsd: 0.5 },
    });
    const cutShort = makeNodeRun(run, 'going', {
      status: 'RUNNING',
      usage: { tokensIn: 3, tokensOut: 0, costUsd: 0.25 },
    });
    const stores = createFakeStores({ runs: [run], nodeRuns: [spentBefore, cutShort] });
    const bus = createCapturedBus();
    const controls = createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus,
      // No gate registered: nothing in this process is driving the run.
      gates: createRunGateRegistry(),
      now: tickingClock(),
      driveRecordedRun: async (value) => value,
      drivePartialRun: async (plan) => plan.run,
    });

    const halted = await controls.stop(run.id);

    const expected = { tokensIn: 14, tokensOut: 4, costUsd: 0.75 };
    expect(halted.totals).toMatchObject(expected);
    expect(stores.runRows.get(run.id)?.totals).toMatchObject(expected);
    expect(bus.typesOf('run.completed')[0]?.payload).toMatchObject({ totals: expected });
  });

  it('counts what a call cut short had already spent, once it has unwound', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [{ usageFirst: { tokensIn: 7, tokensOut: 2 }, hold: untilAborted() }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'RUNNING');
    await h.controls.stop(run.id);
    await done;

    const [cut] = await h.nodeRunsOf(run.id, writer.id);
    expect(cut).toMatchObject({ status: 'STOPPED', usage: { tokensIn: 7, tokensOut: 2 } });

    const spent = totalsOf((await h.nodeRunsOf(run.id)).map((nodeRun) => nodeRun.usage));
    expect((await h.runRow(run.id)).totals).toMatchObject(spent);
    // Whatever order the stop and the unwinding landed in, the last word a client got agrees.
    const updates = h.events.filter((event) => event.type === 'usage.updated');
    expect((updates.at(-1)?.payload as { totals: Usage }).totals).toMatchObject(spent);
  });
});
