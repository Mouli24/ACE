import {
  zeroUsage,
  type Edge,
  type Id,
  type Node,
  type NodeRun,
  type Run,
  type ValidationIssue,
} from '@ace/contracts';

import { notFound } from '../../gateway/errors.js';
import { upstreamOf } from './graph.js';

/**
 * Start from a node (FR-EXE-013, TC-EXE-012, D83).
 *
 * The new run does not call the nodes before the chosen one. It **copies** their last `COMPLETED`
 * node run — from the workflow's most recent run that has one, per node — as a `COMPLETED` node run
 * with zero usage and `reusedFromNodeRunId` pointing at the original. D83 chose copying over
 * leaving those nodes `IDLE` for one reason: what the start node actually read has to be visible.
 * A run whose first two nodes are blank tells the person nothing about the input the third one got.
 *
 * An upstream node no earlier run ever completed blocks the run at pre-flight with
 * `missing_upstream_output`, naming it — there is no output to reuse and calling it would be
 * exactly what Start from node exists to avoid.
 */

export interface StartFromInput {
  startFromNodeId: Id;
  /** The new run's snapshot. */
  nodes: readonly Node[];
  edges: readonly Edge[];
  /** The new run these copies belong to. */
  runId: Id;
  /** The workflow's earlier runs, **newest first** (D83: "the most recent run that has one"). */
  earlierRuns: readonly Run[];
  nodeRunsOf: (runId: Id) => Promise<NodeRun[]>;
  nextId: () => string;
  now: () => string;
}

export interface StartFromPlan {
  /** Every node before the start node, in snapshot order. */
  upstreamNodeIds: Id[];
  /** The rows to insert: `COMPLETED`, zero usage, `reusedFromNodeRunId` set. */
  reused: NodeRun[];
  /** One `missing_upstream_output` per upstream node no earlier run completed (D83). */
  issues: ValidationIssue[];
}

/** The node run to copy for one node: the latest run, walking back, that completed it. */
async function latestCompleted(
  nodeId: Id,
  earlierRuns: readonly Run[],
  nodeRunsOf: (runId: Id) => Promise<NodeRun[]>,
  cache: Map<Id, NodeRun[]>,
): Promise<NodeRun | undefined> {
  for (const run of earlierRuns) {
    let rows = cache.get(run.id);
    if (rows === undefined) {
      rows = await nodeRunsOf(run.id);
      cache.set(run.id, rows);
    }

    // Within one run, the last completed attempt of the last iteration is the output that ran on.
    const candidates = rows
      .filter((row) => row.nodeId === nodeId && row.status === 'COMPLETED')
      .sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt);

    const chosen = candidates.at(-1);
    if (chosen !== undefined) return chosen;
  }

  return undefined;
}

export async function planStartFrom(input: StartFromInput): Promise<StartFromPlan> {
  const start = input.nodes.find((node) => node.id === input.startFromNodeId);
  // A node id that is not in the snapshot is not a pre-flight issue; it is a wrong request.
  if (start === undefined) throw notFound(`node ${input.startFromNodeId}`);

  const upstream = upstreamOf(input.startFromNodeId, input.edges);
  const cache = new Map<Id, NodeRun[]>();

  const plan: StartFromPlan = { upstreamNodeIds: [], reused: [], issues: [] };

  // Snapshot order, so the copies read in the order the graph is laid out rather than by set order.
  for (const node of input.nodes) {
    if (!upstream.has(node.id)) continue;
    plan.upstreamNodeIds.push(node.id);

    const source = await latestCompleted(node.id, input.earlierRuns, input.nodeRunsOf, cache);
    if (source === undefined) {
      plan.issues.push({
        severity: 'error',
        code: 'missing_upstream_output',
        message:
          `"${node.name}" has no completed output from an earlier run to reuse, so the run cannot ` +
          `start at "${start.name}". Run the whole workflow once first.`,
        nodeId: node.id,
      });
      continue;
    }

    const at = input.now();
    plan.reused.push({
      id: input.nextId(),
      runId: input.runId,
      nodeId: node.id,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      ...(source.output === undefined ? {} : { output: source.output }),
      // Nothing was called, so nothing was spent and nothing was checked: zero usage, and no
      // verdicts, because copying them would claim guardrails ran on this run (D95).
      usage: zeroUsage(),
      verdicts: [],
      toolCalls: [],
      approvals: [],
      reusedFromNodeRunId: source.id,
      startedAt: at,
      endedAt: at,
      durationMs: 0,
    });
  }

  return plan;
}
