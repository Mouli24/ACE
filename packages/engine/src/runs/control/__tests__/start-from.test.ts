import type { NodeRun, Run } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../../gateway/errors.js';
import { planStartFrom } from '../start-from.js';
import {
  NOW,
  agentNode,
  edge,
  inputNode,
  makeNodeRun,
  makeRun,
  outputNode,
} from './harness.js';

const NEW_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NEWRN';

/** Brief → Writer → Reviewer → Result. Start from the Reviewer and the first two are reused. */
function fixture() {
  const brief = inputNode('Brief');
  const writer = agentNode('Writer');
  const reviewer = agentNode('Reviewer');
  const result = outputNode('Result');
  const nodes = [brief, writer, reviewer, result];
  const edges = [edge(brief, writer), edge(writer, reviewer), edge(reviewer, result)];
  return { brief, writer, reviewer, result, nodes, edges };
}

let idCounter = 0;
const nextId = () => `01JBXQ8Z9KQ4R7N2VWXYZ0R${String(idCounter++).padStart(3, '0')}`;

describe('TC-EXE-012 Start from a node reuses the upstream node runs (FR-EXE-013, D83)', () => {
  it('copies each upstream node’s last COMPLETED node run, with zero usage and a reuse marker', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier = makeRun({ snapshot: { version: 1, nodes, edges }, status: 'COMPLETE' });

    const briefRun = makeNodeRun(earlier, brief.id, {
      status: 'COMPLETED',
      output: [{ type: 'text', text: 'the brief' }],
      usage: { tokensIn: 3, tokensOut: 4, costUsd: 0.5, priceTableVersion: 'mock-v1' },
    });
    const writerRun = makeNodeRun(earlier, writer.id, {
      status: 'COMPLETED',
      output: [{ type: 'text', text: 'draft one' }],
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 1.25, priceTableVersion: 'mock-v1' },
    });

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => [briefRun, writerRun],
      nextId,
      now: () => NOW,
    });

    expect(plan.issues).toEqual([]);
    expect(plan.upstreamNodeIds).toEqual([brief.id, writer.id]);
    expect(plan.reused).toHaveLength(2);

    const [copiedBrief, copiedWriter] = plan.reused;
    expect(copiedBrief).toMatchObject({
      runId: NEW_RUN_ID,
      nodeId: brief.id,
      status: 'COMPLETED',
      reusedFromNodeRunId: briefRun.id,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      output: [{ type: 'text', text: 'the brief' }],
      durationMs: 0,
    });
    expect(copiedWriter?.reusedFromNodeRunId).toBe(writerRun.id);
    expect(copiedWriter?.output).toEqual([{ type: 'text', text: 'draft one' }]);
  });

  it('gives each copy a fresh id — never the id of the node run it copied', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier = makeRun({ status: 'COMPLETE' });
    const rows = [
      makeNodeRun(earlier, brief.id, { status: 'COMPLETED' }),
      makeNodeRun(earlier, writer.id, { status: 'COMPLETED' }),
    ];

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => rows,
      nextId,
      now: () => NOW,
    });

    const copiedIds = plan.reused.map((row) => row.id);
    expect(new Set(copiedIds).size).toBe(2);
    for (const row of rows) expect(copiedIds).not.toContain(row.id);
  });

  it('records nothing it did not do: no verdicts, no approvals, no envelopes', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier = makeRun({ status: 'COMPLETE' });

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => [
        makeNodeRun(earlier, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(earlier, writer.id, {
          status: 'COMPLETED',
          verdicts: [
            {
              id: '01JBXQ8Z9KQ4R7N2VWXYZ0VRDCT',
              nodeRunId: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN11',
              point: 'output',
              checkType: 'pii',
              action: 'warn',
              passed: false,
              reason: 'An email was found.',
              at: NOW,
            },
          ],
        }),
      ],
      nextId,
      now: () => NOW,
    });

    for (const row of plan.reused) {
      expect(row.verdicts).toEqual([]);
      expect(row.approvals).toEqual([]);
      expect(row.inputEnvelopes).toEqual([]);
      expect(row.usage.priceTableVersion).toBeUndefined();
    }
  });

  it('walks back to the most recent run that has an output for each node (D83)', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const newest = makeRun({ status: 'HALTED', startedAt: '2026-09-26T12:00:00.000Z' });
    const older = makeRun({ status: 'COMPLETE', startedAt: '2026-09-26T09:00:00.000Z' });

    // The newest run only got as far as the Brief; the Writer's output comes from the older one.
    const byRun: Record<string, NodeRun[]> = {
      [newest.id]: [
        makeNodeRun(newest, brief.id, {
          status: 'COMPLETED',
          output: [{ type: 'text', text: 'newer brief' }],
        }),
        makeNodeRun(newest, writer.id, { status: 'FAILED' }),
      ],
      [older.id]: [
        makeNodeRun(older, brief.id, {
          status: 'COMPLETED',
          output: [{ type: 'text', text: 'older brief' }],
        }),
        makeNodeRun(older, writer.id, {
          status: 'COMPLETED',
          output: [{ type: 'text', text: 'older draft' }],
        }),
      ],
    };

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [newest, older],
      nodeRunsOf: async (runId) => byRun[runId] ?? [],
      nextId,
      now: () => NOW,
    });

    expect(plan.reused.map((row) => row.output?.[0])).toEqual([
      { type: 'text', text: 'newer brief' },
      { type: 'text', text: 'older draft' },
    ]);
  });

  it('within one run takes the last completed attempt of the last iteration', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier = makeRun({ status: 'COMPLETE' });

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => [
        makeNodeRun(earlier, brief.id, { status: 'COMPLETED' }),
        makeNodeRun(earlier, writer.id, {
          status: 'COMPLETED',
          iteration: 1,
          output: [{ type: 'text', text: 'first pass' }],
        }),
        makeNodeRun(earlier, writer.id, {
          status: 'COMPLETED',
          iteration: 2,
          attempt: 1,
          output: [{ type: 'text', text: 'second pass' }],
        }),
        makeNodeRun(earlier, writer.id, {
          status: 'COMPLETED',
          iteration: 2,
          attempt: 2,
          output: [{ type: 'text', text: 'second pass, retried' }],
        }),
      ],
      nextId,
      now: () => NOW,
    });

    expect(plan.reused.at(-1)?.output).toEqual([{ type: 'text', text: 'second pass, retried' }]);
  });

  it('blocks the run with `missing_upstream_output`, naming the node, when nothing completed it', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier = makeRun({ status: 'HALTED' });

    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => [makeNodeRun(earlier, brief.id, { status: 'COMPLETED' })],
      nextId,
      now: () => NOW,
    });

    expect(plan.reused.map((row) => row.nodeId)).toEqual([brief.id]);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]).toMatchObject({
      severity: 'error',
      code: 'missing_upstream_output',
      nodeId: writer.id,
    });
    expect(plan.issues[0]?.message).toContain('"Writer"');
    expect(plan.issues[0]?.message).toContain('"Reviewer"');
  });

  it('blocks on every missing upstream at once, not one at a time (BR-08)', async () => {
    const { reviewer, nodes, edges } = fixture();
    const plan = await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [],
      nodeRunsOf: async () => [],
      nextId,
      now: () => NOW,
    });

    expect(plan.reused).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toEqual([
      'missing_upstream_output',
      'missing_upstream_output',
    ]);
  });

  it('starting at the first node reuses nothing and blocks nothing', async () => {
    const { brief, nodes, edges } = fixture();
    const plan = await planStartFrom({
      startFromNodeId: brief.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [],
      nodeRunsOf: async () => [],
      nextId,
      now: () => NOW,
    });

    expect(plan).toEqual({ upstreamNodeIds: [], reused: [], issues: [] });
  });

  it('a node id that is not in the snapshot is a 404, not a pre-flight issue', async () => {
    const { nodes, edges } = fixture();
    await expect(
      planStartFrom({
        startFromNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0NONE',
        nodes,
        edges,
        runId: NEW_RUN_ID,
        earlierRuns: [],
        nodeRunsOf: async () => [],
        nextId,
        now: () => NOW,
      }),
    ).rejects.toThrow(HttpError);
  });

  it('reads each earlier run’s node runs once, however many nodes are reused', async () => {
    const { brief, writer, reviewer, nodes, edges } = fixture();
    const earlier: Run = makeRun({ status: 'COMPLETE' });
    let reads = 0;

    await planStartFrom({
      startFromNodeId: reviewer.id,
      nodes,
      edges,
      runId: NEW_RUN_ID,
      earlierRuns: [earlier],
      nodeRunsOf: async () => {
        reads += 1;
        return [
          makeNodeRun(earlier, brief.id, { status: 'COMPLETED' }),
          makeNodeRun(earlier, writer.id, { status: 'COMPLETED' }),
        ];
      },
      nextId,
      now: () => NOW,
    });

    expect(reads).toBe(1);
  });
});
