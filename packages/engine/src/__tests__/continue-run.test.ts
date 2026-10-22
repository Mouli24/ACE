import { canContinueRun, derivePorts, type Edge, type Node, type Usage } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { sumUsage } from '../runs/index.js';
import {
  createRunDriverHarness,
  httpError,
  scope,
  untilAborted,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * D388 / D-055: a run that was cut off carries on, on the real run service and controls with a
 * scripted provider.
 *
 * Continue retries every node run the halt interrupted in one drive — what they feed runs after
 * them once, what had finished never runs again — and the run's totals at the end are the whole
 * run's, the cut-off attempts included (D-055), which is true of a retry and a re-run as well.
 */

const tokensOf = (usage: Usage) => ({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });

/** The sum of every node run of the run, every attempt included (TC-OBS-002). */
async function spentBy(h: RunDriverHarness, runId: string) {
  return tokensOf(sumUsage((await h.nodeRunsOf(runId)).map((row) => row.usage)));
}

/** The `run.completed` payloads of one run, in order. */
const endingsOf = (h: RunDriverHarness, runId: string) =>
  h.events
    .filter((event) => event.type === 'run.completed' && event.runId === runId)
    .map((event) => event.payload as { status: string; haltReason?: string; totals: Usage });

/** A Merge (`all`) and an Output that takes its JSON, with the ports `derivePorts` gives them. */
function mergeInto(h: RunDriverHarness): { merge: Node; result: Node; mergeToResult: Edge } {
  const mergeId = newId();
  const merge: Node = {
    id: mergeId,
    workflowId: h.workflowId,
    kind: 'merge',
    name: 'Merge',
    position: { x: 0, y: 0 },
    ...derivePorts({ id: mergeId, kind: 'merge', config: { mode: 'all' } }),
    config: { mode: 'all' },
  };
  const resultId = newId();
  const result: Node = {
    id: resultId,
    workflowId: h.workflowId,
    kind: 'output',
    name: 'Result',
    position: { x: 0, y: 0 },
    ...derivePorts({ id: resultId, kind: 'output', config: {} }),
    config: {},
  };
  const mergeToResult: Edge = {
    id: newId(),
    workflowId: h.workflowId,
    kind: 'data',
    from: { nodeId: merge.id, portId: merge.outputs[0]!.id },
    to: { nodeId: result.id, portId: result.inputs.find((port) => port.name === 'json')!.id },
  };
  return { merge, result, mergeToResult };
}

/** Brief → A, Brief → B (in parallel) → Merge → Result. */
async function parallelFlow(h: RunDriverHarness) {
  const brief = h.inputNode();
  const a = h.agentNode('A');
  const b = h.agentNode('B');
  const { merge, result, mergeToResult } = mergeInto(h);
  await h.seed(
    [brief, a, b, merge, result],
    [h.edge(brief, a), h.edge(brief, b), h.edge(a, merge), h.edge(b, merge), mergeToResult],
  );
  return { brief, a, b, merge, result };
}

describe('D388 Continue a run stopped with two parallel nodes in flight', () => {
  it('runs both again in one drive, then what they feed once; the run ends COMPLETE (D-055 totals)', async () => {
    const h = await createRunDriverHarness();
    const { brief, a, b, merge, result } = await parallelFlow(h);
    // The first attempts spend something before the stop cuts them off.
    h.scripts.set('A', [
      { usageFirst: { tokensIn: 7, tokensOut: 2 }, hold: untilAborted() },
      { text: 'from A' },
    ]);
    h.scripts.set('B', [
      { usageFirst: { tokensIn: 11, tokensOut: 1 }, hold: untilAborted() },
      { text: 'from B' },
    ]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(a.id, 'RUNNING');
    await h.waitForState(b.id, 'RUNNING');
    await h.controls.stop(run.id);
    await done;

    const halted = await h.runRow(run.id);
    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(tokensOf(halted.totals)).toEqual({ tokensIn: 18, tokensOut: 3 });
    expect(canContinueRun(halted, await h.nodeRunsOf(run.id))).toBe(true);

    const continued = await h.controls.continueRun(run.id);
    expect(continued).toMatchObject({ id: run.id, status: 'RUNNING' });
    // A run going again is no longer halted: its old halt reason does not outlive the halt.
    expect(continued.haltReason).toBeUndefined();
    await h.waitForEvent('run.completed', 2);

    const ended = await h.runRow(run.id);
    expect(ended.status).toBe('COMPLETE');
    expect(ended.haltReason).toBeUndefined();

    // Both cut-off nodes again, at attempt 2, from one Continue; each provider call once more.
    for (const node of [a, b]) {
      expect(
        (await h.nodeRunsOf(run.id, node.id)).map((row) => `${row.attempt}:${row.status}`),
      ).toEqual(['1:STOPPED', '2:COMPLETED']);
    }
    expect(h.calls('A')).toBe(2);
    expect(h.calls('B')).toBe(2);
    // On the inputs the first attempts were delivered (FR-ERR-003).
    expect(h.prompts('A')[1]).toContain('the brief');

    // What finished is not run again; what they feed runs once.
    expect((await h.nodeRunsOf(run.id, brief.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    expect((await h.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    expect((await h.nodeRunsOf(run.id, result.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    expect(JSON.stringify(ended.finalOutput)).toContain('from A');
    expect(JSON.stringify(ended.finalOutput)).toContain('from B');

    // D-055: the whole run's totals — the cut-off attempts' 7 + 11 in and 2 + 1 out, plus the
    // retries' 2 + 2 in and 3 + 3 out — on the row and on the second `run.completed`.
    const whole = { tokensIn: 7 + 11 + 2 + 2, tokensOut: 2 + 1 + 3 + 3 };
    expect(await spentBy(h, run.id)).toEqual(whole);
    expect(tokensOf(ended.totals)).toEqual(whole);
    const endings = endingsOf(h, run.id);
    expect(endings.map((ending) => ending.status)).toEqual(['HALTED', 'COMPLETE']);
    expect(tokensOf(endings[1]!.totals)).toEqual(whole);
    // The running total a client saw last agrees.
    const updates = h.payloads<{ runId: string; totals: Usage }>('usage.updated');
    expect(tokensOf(updates.at(-1)!.totals)).toEqual(whole);

    // A finished run has nothing to continue.
    expect(canContinueRun(ended, await h.nodeRunsOf(run.id))).toBe(false);
    await expect(h.controls.continueRun(run.id)).rejects.toMatchObject({
      status: 409,
      code: 'invalid_run_state',
    });
  });
});

describe('D388 FR-SYS-009 Continue a run the engine crashed under', () => {
  it('after a restart, the nodes the crash cut off run again and the run ends COMPLETE', async () => {
    const h = await createRunDriverHarness();
    const { brief, a, b, merge } = await parallelFlow(h);
    h.scripts.set('A', [{ usageFirst: { tokensIn: 5, tokensOut: 1 }, hold: untilAborted() }]);
    h.scripts.set('B', [{ usageFirst: { tokensIn: 3, tokensOut: 1 }, hold: untilAborted() }]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(a.id, 'RUNNING');
    await h.waitForState(b.id, 'RUNNING');
    // Unwind this process's drive, then leave the store as a process that died mid-call would:
    // the run going, both calls in flight.
    await h.service.shutdown();
    await done;
    await h.repository.runs.update(scope, run.id, { status: 'RUNNING' });
    for (const row of [
      ...(await h.nodeRunsOf(run.id, a.id)),
      ...(await h.nodeRunsOf(run.id, b.id)),
    ]) {
      await h.repository.nodeRuns.update(scope, row.id, { status: 'RUNNING' });
    }

    // The next engine process recovers it — HALTED `crash`, A and B STOPPED — and continues it.
    const next = await createRunDriverHarness({ repository: h.repository });
    next.scripts.set('A', [{ text: 'A again' }]);
    next.scripts.set('B', [{ text: 'B again' }]);
    expect((await next.recover()).halted).toEqual([run.id]);
    const crashed = await next.runRow(run.id);
    expect(crashed).toMatchObject({ status: 'HALTED', haltReason: 'crash' });
    expect(canContinueRun(crashed, await next.nodeRunsOf(run.id))).toBe(true);

    await next.controls.continueRun(run.id);
    await next.waitForEvent('run.completed', 2);

    const ended = await next.runRow(run.id);
    expect(ended.status).toBe('COMPLETE');
    for (const node of [a, b]) {
      expect(
        (await next.nodeRunsOf(run.id, node.id)).map((row) => `${row.attempt}:${row.status}`),
      ).toEqual(['1:STOPPED', '2:COMPLETED']);
    }
    expect(next.calls('A')).toBe(1);
    expect(next.calls('B')).toBe(1);
    expect(await next.nodeRunsOf(run.id, brief.id)).toHaveLength(1);
    expect((await next.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual([
      'COMPLETED',
    ]);
    // D-055: what the crashed attempts spent is in the totals the continued run ends with.
    const whole = { tokensIn: 5 + 3 + 2 + 2, tokensOut: 1 + 1 + 3 + 3 };
    expect(await spentBy(next, run.id)).toEqual(whole);
    expect(tokensOf(ended.totals)).toEqual(whole);
  });
});

describe('[audit E-6] Continue a paused run the engine crashed under', () => {
  it('a node the pause was holding is STOPPED by the recovery and runs again on Continue', async () => {
    const h = await createRunDriverHarness();
    const { a, b, merge } = await parallelFlow(h);
    h.scripts.set('A', [{ hold: untilAborted() }]);
    h.scripts.set('B', [{ hold: untilAborted() }]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(a.id, 'RUNNING');
    await h.waitForState(b.id, 'RUNNING');
    await h.service.shutdown();
    await done;
    // As a process that died while paused leaves it: A's call in flight, B held by the pause.
    await h.repository.runs.update(scope, run.id, {
      status: 'PAUSED',
      allowedActions: ['resume', 'stop'],
    });
    const [aRow] = await h.nodeRunsOf(run.id, a.id);
    const [bRow] = await h.nodeRunsOf(run.id, b.id);
    await h.repository.nodeRuns.update(scope, aRow!.id, { status: 'RUNNING' });
    await h.repository.nodeRuns.update(scope, bRow!.id, { status: 'PAUSED' });

    const next = await createRunDriverHarness({ repository: h.repository });
    expect((await next.recover()).halted).toEqual([run.id]);
    const crashed = await next.runRow(run.id);
    expect(crashed).toMatchObject({ status: 'HALTED', haltReason: 'crash' });
    expect(crashed.allowedActions).toEqual(['restart']);
    expect((await next.nodeRunsOf(run.id, b.id)).map((row) => row.status)).toEqual(['STOPPED']);

    await next.controls.continueRun(run.id);
    await next.waitForEvent('run.completed', 2);

    expect((await next.runRow(run.id)).status).toBe('COMPLETE');
    expect(
      (await next.nodeRunsOf(run.id, b.id)).map((row) => `${row.attempt}:${row.status}`),
    ).toEqual(['1:STOPPED', '2:COMPLETED']);
    expect((await next.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual([
      'COMPLETED',
    ]);
  });
});

describe('D-055 a partial drive totals the whole run', () => {
  it('after a retry, the run totals include the failed first attempt’s tokens', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [
      { usageFirst: { tokensIn: 5, tokensOut: 1 }, throws: httpError(503) },
      { text: 'ok' },
    ]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const failed = await done;
    expect(failed).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect(tokensOf(failed.totals)).toEqual({ tokensIn: 5, tokensOut: 1 });

    const [first] = await h.nodeRunsOf(run.id, writer.id);
    await h.controls.retryNodeRun(first!.id, { withDownstream: true });
    await h.waitForEvent('run.completed', 2);

    const ended = await h.runRow(run.id);
    expect(ended.status).toBe('COMPLETE');
    // D81's reopen clears the `failure` halt: a completed run never reads COMPLETE + failure.
    expect(ended.haltReason).toBeUndefined();
    const whole = { tokensIn: 5 + 2, tokensOut: 1 + 3 };
    expect(tokensOf(ended.totals)).toEqual(whole);
    expect(await spentBy(h, run.id)).toEqual(whole);
    expect(tokensOf(endingsOf(h, run.id)[1]!.totals)).toEqual(whole);
  });

  it('after a re-run, the run totals include what the run spent before it, counted once', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    h.scripts.set('Writer', [
      { text: 'first', usage: { tokensIn: 10, tokensOut: 4 } },
      { text: 'again' },
    ]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    expect(tokensOf((await done).totals)).toEqual({ tokensIn: 10, tokensOut: 4 });

    await h.controls.rerunNode(run.id, writer.id);
    await h.waitForEvent('run.completed', 2);

    const whole = { tokensIn: 10 + 2, tokensOut: 4 + 3 };
    expect(tokensOf((await h.runRow(run.id)).totals)).toEqual(whole);
    expect(await spentBy(h, run.id)).toEqual(whole);
  });

  it('a full drive is unchanged: its totals are its own node runs', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    expect(tokensOf((await done).totals)).toEqual({ tokensIn: 2, tokensOut: 3 });
    expect(await spentBy(h, run.id)).toEqual({ tokensIn: 2, tokensOut: 3 });
  });
});

/** An agent with two single text inputs, so it needs both of its upstreams. */
function withTwoInputs(node: Node): Node {
  const text = (name: string) => ({
    id: `${node.id}:in:${name}`,
    name,
    dataType: 'text' as const,
    multi: false,
  });
  return { ...node, inputs: [text('left'), text('right')] };
}

describe('FR-ERR-004 D388 a partial drive keeps what a finished sibling delivered', () => {
  it('a node re-run after a retry still gets the output of the upstream that had completed', async () => {
    /* Brief → A → Join, Brief → B → Join → Result. A fails; B completes. */
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const a = h.agentNode('A');
    const b = h.agentNode('B');
    const join = withTwoInputs(h.agentNode('Join'));
    const result = h.outputNode();
    const into = (from: Node, portName: string): Edge => ({
      id: newId(),
      workflowId: h.workflowId,
      kind: 'data',
      from: { nodeId: from.id, portId: from.outputs[0]!.id },
      to: { nodeId: join.id, portId: join.inputs.find((port) => port.name === portName)!.id },
    });
    h.scripts.set('A', [{ throws: httpError(503) }, { text: 'from A' }]);
    h.scripts.set('B', [{ text: 'from B' }]);
    await h.seed(
      [brief, a, b, join, result],
      [h.edge(brief, a), h.edge(brief, b), into(a, 'left'), into(b, 'right'), h.edge(join, result)],
    );

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    expect(await done).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect((await h.nodeRunsOf(run.id, join.id)).map((row) => row.status)).toEqual(['BLOCKED']);
    expect(h.calls('Join')).toBe(0);

    const [failedA] = await h.nodeRunsOf(run.id, a.id);
    await h.controls.retryNodeRun(failedA!.id, { withDownstream: true });
    await h.waitForEvent('run.completed', 2);

    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    expect(h.calls('B')).toBe(1);
    expect(h.calls('Join')).toBe(1);
    // Both inputs: A's fresh output, and B's from before the retry.
    expect(h.prompts('Join')[0]).toContain('from A');
    expect(h.prompts('Join')[0]).toContain('from B');
  });
});
