import type { Id, ModelUsed, Node, NodeRun, Part, RunSnapshot } from '@ace/contracts';

import type { ProviderAdapter, StreamChunk } from '../ports/index.js';

/**
 * Replay (PG-5.4, FR-GIT-007, Arch §20.2 `POST /runs/:id/replay`).
 *
 * A replay is a new run on an earlier run's snapshot and inputs whose every provider call is
 * answered from what that run recorded — **zero provider calls**. Distinct from Restart, which
 * calls the models again (FR-CTL-004).
 *
 * The book is built once per replay from the source run's node runs. A node's call is answered by
 * its COMPLETED node run of the same iteration (the last attempt that completed); when the
 * iterations do not line up — a Domain turn, say — the node's completed runs are handed out in
 * the order they were recorded. A node with nothing left to answer with fails clearly
 * (`replay_missing`); it is never sent to a provider.
 */

/** What one call of a node in a replay is answered with. */
export type ReplayAnswer =
  | {
      kind: 'recorded';
      /** The source node run whose output this call returns. */
      sourceNodeRunId: Id;
      output: Part[];
      /** The model the source node run used, so a comparison shows the same model. */
      route: ModelUsed;
    }
  | { kind: 'missing'; message: string };

export interface ReplayBook {
  /** The run whose recordings answer this replay. */
  sourceRunId: Id;
  /** The recorded answer for this node's call at this iteration, consumed once. */
  answer(node: Node, iteration: number): ReplayAnswer;
}

/** Only the node kinds that would call a provider, or a search, are answered from the book. */
export function isReplayedKind(node: Node): boolean {
  return node.kind === 'agent' || node.kind === 'model' || node.kind === 'retrieval';
}

/** The order the source run recorded its node runs in: iteration, then attempt, then start. */
function recordedOrder(a: NodeRun, b: NodeRun): number {
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  if (a.attempt !== b.attempt) return a.attempt - b.attempt;
  return (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.id.localeCompare(b.id);
}

/** The model a recorded node run used, or the node's own configured model when it says none. */
function routeOf(node: Node, row: NodeRun): ModelUsed | undefined {
  if (row.modelUsed !== undefined) return row.modelUsed;
  if (node.kind !== 'agent' && node.kind !== 'model') return undefined;
  const { providerId, modelId } = node.config;
  if (providerId === undefined || modelId === undefined) return undefined;
  return { providerId, modelId, viaFallback: false };
}

export function createReplayBook(
  sourceRunId: Id,
  snapshot: RunSnapshot,
  sourceNodeRuns: readonly NodeRun[],
): ReplayBook {
  const nodeNames = new Map(snapshot.nodes.map((node) => [node.id, node.name]));

  /** Per node: its completed node runs with an output, in recorded order. */
  const completed = new Map<Id, NodeRun[]>();
  for (const row of [...sourceNodeRuns].sort(recordedOrder)) {
    if (row.status !== 'COMPLETED' || row.output === undefined) continue;
    const list = completed.get(row.nodeId) ?? [];
    list.push(row);
    completed.set(row.nodeId, list);
  }

  /** The source node runs already handed out, so one recording answers one call. */
  const used = new Set<Id>();

  function pick(nodeId: Id, iteration: number): NodeRun | undefined {
    const rows = (completed.get(nodeId) ?? []).filter((row) => !used.has(row.id));
    // The same iteration first: its last completed attempt is what the source run went on with.
    const sameIteration = rows.filter((row) => row.iteration === iteration);
    if (sameIteration.length > 0) return sameIteration[sameIteration.length - 1];
    // Otherwise the next recording in order (a Domain turn, a re-run).
    return rows[0];
  }

  return {
    sourceRunId,
    answer(node, iteration) {
      const name = nodeNames.get(node.id) ?? node.name;
      const row = pick(node.id, iteration);
      if (row === undefined) {
        return {
          kind: 'missing',
          message:
            `Replay has no recorded output for "${name}" (iteration ${iteration}) in run ` +
            `${sourceRunId}, so this node failed instead of calling a provider.`,
        };
      }
      const route = routeOf(node, row);
      if (route === undefined && node.kind !== 'retrieval') {
        return {
          kind: 'missing',
          message: `Replay cannot tell which model "${name}" used in run ${sourceRunId}, so this node failed instead of calling a provider.`,
        };
      }
      used.add(row.id);
      return {
        kind: 'recorded',
        sourceNodeRunId: row.id,
        output: row.output ?? [],
        // A Retrieval node calls no model; its route is never read.
        route: route ?? { providerId: sourceRunId, modelId: 'replay', viaFallback: false },
      };
    },
  };
}

/**
 * A provider adapter that never reaches a provider: it streams one recorded output back as the
 * answer — text as text, JSON as JSON, any other part as a produced part referencing the artifact
 * the source run already stored — and reports zero usage at zero cost, so the executor neither
 * estimates nor prices tokens that were never spent.
 */
export function createReplayAdapter(answer: Extract<ReplayAnswer, { kind: 'recorded' }>): ProviderAdapter {
  return {
    type: 'mock',
    check: () => Promise.resolve({ status: 'CONNECTED' }),
    listModels: () => Promise.resolve([]),
    async *generate(_request, signal): AsyncIterable<StreamChunk> {
      if (answer.route.resolvedModelId !== undefined) {
        yield { type: 'model', modelId: answer.route.resolvedModelId };
      }
      for (const part of answer.output) {
        if (signal.aborted) return;
        if (part.type === 'text') yield { type: 'text', delta: part.text };
        else if (part.type === 'json') yield { type: 'json', value: part.value };
        else yield { type: 'part', part };
      }
      yield { type: 'usage', tokensIn: 0, tokensOut: 0, costUsd: 0 };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}
