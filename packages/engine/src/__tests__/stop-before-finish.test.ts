import type { Node, NodeState } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import type { EngineEvent } from '../ports/index.js';
import { createRunDriverHarness, type RunDriverHarness } from './run-driver-harness.js';

/**
 * D-063 — a Stop that lands after a node did its work but before its node run is recorded
 * (FR-CTL-003, FR-ERR-007, D110, D111).
 *
 * The Stop owns the ending of every node run that exists when it lands: it moves the row to STOPPED
 * and announces it, then halts the run and emits `run.completed` (D111). A node whose call had
 * already returned — an agent with no guardrail engine, or an input, transform or output node — went
 * on to write COMPLETED (or FAILED/BLOCKED) over that STOPPED, and to announce `node.output` and
 * `node.state` frames after `run.completed`. Now, once the run is aborted, the executor announces no
 * result and the scheduler writes no ending over the Stop's: the node keeps what it spent, and the
 * Stop's STOPPED is its last word.
 *
 * The run-driver harness has no guardrail engine, which is exactly the case: the output point's own
 * stop handling (D-054) does not run here.
 */

/** Frames that belong to a node's ending or to what flows on from it — none may follow the run's end. */
const NODE_FRAMES = new Set(['node.state', 'node.output', 'node.error', 'edge.transfer', 'loop.iteration']);

function transformNode(h: RunDriverHarness, name: string, config: Record<string, unknown>): Node {
  const id = newId();
  return {
    id,
    workflowId: h.workflowId,
    kind: 'transform',
    name,
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:text`, name: 'text', dataType: 'text', multi: false }],
    outputs: [{ id: `${id}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: config as Extract<Node, { kind: 'transform' }>['config'],
  } as Node;
}

/**
 * Brief → Writer → Shape (transform) → Result. `shape` picks the transform: `join` passes the text on,
 * `extract_json_field` fails on it (a text has no `answer` field).
 */
async function seedChain(h: RunDriverHarness, shape: 'join' | 'extract_json_field' = 'join') {
  const brief = h.inputNode();
  const writer = h.agentNode('Writer');
  const transform = transformNode(
    h,
    'Shape',
    shape === 'join' ? { op: 'join', separator: '\n' } : { op: 'extract_json_field', path: 'answer' },
  );
  const result = h.outputNode();
  await h.seed(
    [brief, writer, transform, result],
    [h.edge(brief, writer), h.edge(writer, transform), h.edge(transform, result)],
  );
  return { brief, writer, transform, result, chain: [brief, writer, transform, result] };
}

/** Stop the run from inside a frame handler: the abort is synchronous, the control's writes follow. */
async function stopOn(
  h: RunDriverHarness,
  matches: (event: EngineEvent) => boolean,
): Promise<{ stopped: () => Promise<unknown> }> {
  let stopping: Promise<unknown> | undefined;
  await h.bus.subscribe((event) => {
    if (stopping !== undefined || event.runId === undefined || !matches(event)) return;
    h.gates.get(event.runId)?.stop();
    stopping = h.controls.stop(event.runId);
  });
  return {
    stopped: async () => {
      await h.waitFor(() => stopping !== undefined, 'the stop to be made');
      return stopping;
    },
  };
}

const isFrame = (type: string, nodeId: string, status?: NodeState) => (event: EngineEvent) => {
  if (event.type !== type) return false;
  const payload = event.payload as { nodeId?: string; status?: NodeState };
  return payload.nodeId === nodeId && (status === undefined || payload.status === status);
};

/** What every one of these runs must look like once it has ended. */
async function expectStoppedCleanly(h: RunDriverHarness, runId: string, node: Node, after: Node[]) {
  const rows = await h.nodeRunsOf(runId, node.id);
  expect(rows.map((row) => row.status)).toEqual(['STOPPED']);
  expect(rows[0]?.failureReason).toBeUndefined();
  expect(h.framesOf(node.id).at(-1)).toBe('1:STOPPED');

  const run = await h.runRow(runId);
  expect(run).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);

  const completedAt = h.indexOf('run.completed');
  const late = h.events.slice(completedAt + 1).filter((event) => NODE_FRAMES.has(event.type));
  expect(late).toEqual([]);

  // A stop blocks and starts nothing after it (D-052, FR-ERR-006/007).
  for (const downstream of after) expect(await h.nodeRunsOf(runId, downstream.id)).toEqual([]);
}

describe('FR-CTL-003 FR-ERR-007 D-063 a stop after the work is done but before it is recorded', () => {
  it('an agent whose call returned as the stop landed ends STOPPED, announces no output, keeps what it spent', async () => {
    const h = await createRunDriverHarness();
    const { writer, transform, result } = await seedChain(h);
    let stopping: Promise<unknown> | undefined;
    h.scripts.set('Writer', [
      {
        text: 'the draft',
        afterFinish: () => {
          const runId = h.gates.runIds()[0];
          if (runId === undefined) return;
          h.gates.get(runId)?.stop();
          stopping = h.controls.stop(runId);
        },
      },
    ]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitFor(() => stopping !== undefined, 'the stop to be made');
    await stopping;
    const final = await done;

    await expectStoppedCleanly(h, run.id, writer, [transform, result]);
    expect(h.events.some(isFrame('node.output', writer.id))).toBe(false);
    // The call was made and billed: the stop does not make it free (FR-ERR-007, TC-OBS-002).
    const [row] = await h.nodeRunsOf(run.id, writer.id);
    expect(row?.usage).toMatchObject({ tokensIn: 2, tokensOut: 3 });
    expect(final.totals).toMatchObject({ tokensIn: 2, tokensOut: 3 });
  });

  it.each(['Brief', 'Shape', 'Result'] as const)(
    'a %s node that started as the stop landed ends STOPPED and announces no output',
    async (name) => {
      const h = await createRunDriverHarness();
      const seeded = await seedChain(h);
      const index = seeded.chain.findIndex((node) => node.name === name);
      const node = seeded.chain[index];
      if (node === undefined) throw new Error(`no ${name}`);
      const trigger = await stopOn(h, isFrame('node.state', node.id, 'RUNNING'));

      const { run, done } = await h.service.beginRun(h.workflowId, {});
      await trigger.stopped();
      await done;

      await expectStoppedCleanly(h, run.id, node, seeded.chain.slice(index + 1));
      expect(h.events.some(isFrame('node.output', node.id))).toBe(false);
    },
  );

  it.each(['Brief', 'Writer', 'Shape', 'Result'] as const)(
    'a %s node that announced its output as the stop landed is not written COMPLETED over the stop',
    async (name) => {
      const h = await createRunDriverHarness();
      const seeded = await seedChain(h);
      const index = seeded.chain.findIndex((node) => node.name === name);
      const node = seeded.chain[index];
      if (node === undefined) throw new Error(`no ${name}`);
      const trigger = await stopOn(h, isFrame('node.output', node.id));

      const { run, done } = await h.service.beginRun(h.workflowId, {});
      await trigger.stopped();
      await done;

      await expectStoppedCleanly(h, run.id, node, seeded.chain.slice(index + 1));
      expect(h.framesOf(node.id)).not.toContain('1:COMPLETED');
    },
  );

  it('a transform that fails as the stop lands ends STOPPED, not BLOCKED, and announces no error', async () => {
    const h = await createRunDriverHarness();
    const { transform, result } = await seedChain(h, 'extract_json_field');
    const trigger = await stopOn(h, isFrame('node.state', transform.id, 'RUNNING'));

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await trigger.stopped();
    await done;

    await expectStoppedCleanly(h, run.id, transform, [result]);
    expect(h.events.some((event) => event.type === 'node.error')).toBe(false);
  });

  it('a node recorded COMPLETED just before the stop keeps COMPLETED and announces it before run.completed', async () => {
    const h = await createRunDriverHarness();
    const { writer, transform, result } = await seedChain(h);
    // The stop lands the moment the Writer's COMPLETED row is written — after it, not before it.
    const update = h.repository.nodeRuns.update.bind(h.repository.nodeRuns);
    let stopping: Promise<unknown> | undefined;
    h.repository.nodeRuns.update = async (scope, id, patch) => {
      const written = await update(scope, id, patch);
      if (stopping === undefined && written?.nodeId === writer.id && patch.status === 'COMPLETED') {
        h.gates.get(written.runId)?.stop();
        stopping = h.controls.stop(written.runId);
      }
      return written;
    };

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitFor(() => stopping !== undefined, 'the stop to be made');
    await stopping;
    await done;

    expect((await h.nodeRunsOf(run.id, writer.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    const completedAt = h.indexOf('run.completed');
    const late = h.events.slice(completedAt + 1).filter((event) => NODE_FRAMES.has(event.type));
    expect(late).toEqual([]);
    expect(h.framesOf(writer.id).at(-1)).toBe('1:COMPLETED');
    expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    for (const downstream of [transform, result]) {
      expect(await h.nodeRunsOf(run.id, downstream.id)).toEqual([]);
    }
  });
});
