import {
  AgentConfigSchema,
  zeroUsage,
  type Edge,
  type Envelope,
  type Id,
  type Node,
  type NodeRun,
  type NodeState,
  type Run,
  type RunState,
} from '@ace/contracts';

import type { EmittedEvent } from '../../../events/index.js';
import { newId } from '../../../ids.js';
import type { ControlNodeRunPatch, ControlNodeRunStore, ControlRunPatch, ControlRunStore } from '../stores.js';

/**
 * In-memory stores and a captured bus for the control tests.
 *
 * These honour the round-3 patch fields (`pausedAt`, `allowedActions`, `restartedFromRunId`) that
 * `ports/run-repository.ts` has yet to declare, which is the point: the controls are tested against
 * the shape they are asking for, so the day the port carries it nothing here changes.
 */

export const NOW = '2026-09-26T10:00:00.000Z';
export const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
export const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
export const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

/* ---------------------------------------------------------------- the graph */

const port = (nodeId: string, dir: 'in' | 'out', multi = false) => ({
  id: `${nodeId}:${dir}:text`,
  name: 'text',
  dataType: 'text' as const,
  multi,
});

export function inputNode(name = 'Brief'): Node {
  const id = newId();
  return {
    id,
    workflowId: WORKFLOW_ID,
    kind: 'input',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [port(id, 'out', true)],
    config: { text: 'the brief', artifactIds: [], outputTypes: ['text'] },
  };
}

export function agentNode(name = 'Writer'): Node {
  const id = newId();
  return {
    id,
    workflowId: WORKFLOW_ID,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in')],
    outputs: [port(id, 'out', true)],
    config: AgentConfigSchema.parse({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
    }),
  };
}

export function outputNode(name = 'Result'): Node {
  const id = newId();
  return {
    id,
    workflowId: WORKFLOW_ID,
    kind: 'output',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in')],
    outputs: [],
    config: {},
  };
}

export function edge(from: Node, to: Node, kind: Edge['kind'] = 'data'): Edge {
  return {
    id: newId(),
    workflowId: WORKFLOW_ID,
    kind,
    from: { nodeId: from.id, portId: from.outputs[0]?.id ?? `${from.id}:out:text` },
    to: { nodeId: to.id, portId: to.inputs[0]?.id ?? `${to.id}:in:text` },
  };
}

/* ------------------------------------------------------------------ the rows */

export function makeRun(overrides: Partial<Run> = {}): Run {
  const nodes = overrides.snapshot?.nodes ?? [];
  return {
    id: newId(),
    workflowId: WORKFLOW_ID,
    projectId: PROJECT_ID,
    status: 'RUNNING' as RunState,
    snapshot: { version: 1, nodes, edges: overrides.snapshot?.edges ?? [] },
    inputs: {},
    preflightIssues: [],
    totals: zeroUsage(),
    startedAt: NOW,
    ...overrides,
  };
}

export function makeNodeRun(run: Run, nodeId: Id, overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    id: newId(),
    runId: run.id,
    nodeId,
    iteration: 1,
    attempt: 1,
    status: 'READY' as NodeState,
    inputEnvelopes: [],
    usage: zeroUsage(),
    verdicts: [],
    toolCalls: [],
    approvals: [],
    ...overrides,
  };
}

export function makeEnvelope(run: Run, fromNodeId: Id, toNodeId: Id, text: string): Envelope {
  return {
    id: newId(),
    runId: run.id,
    fromNodeId,
    toNodeId,
    iteration: 1,
    reads: [{ type: 'text', text }],
    context: { budgetTokens: 4000, trust: 'untrusted' },
    contract: { outputTypes: ['text'] },
    createdAt: NOW,
  };
}

/* ---------------------------------------------------------------- the stores */

export interface FakeStores {
  runs: ControlRunStore;
  nodeRuns: ControlNodeRunStore;
  runRows: Map<Id, Run>;
  nodeRunRows: Map<Id, NodeRun>;
  /** Every patch the controls sent, in order — so a test can assert what was written, not only what stuck. */
  runPatches: { runId: Id; patch: ControlRunPatch }[];
  nodeRunPatches: { id: Id; patch: ControlNodeRunPatch }[];
}

export function createFakeStores(seed: { runs?: Run[]; nodeRuns?: NodeRun[] } = {}): FakeStores {
  const runRows = new Map<Id, Run>((seed.runs ?? []).map((run) => [run.id, run]));
  const nodeRunRows = new Map<Id, NodeRun>((seed.nodeRuns ?? []).map((row) => [row.id, row]));
  const runPatches: FakeStores['runPatches'] = [];
  const nodeRunPatches: FakeStores['nodeRunPatches'] = [];

  const runs: ControlRunStore = {
    get: async (runId) => runRows.get(runId) ?? null,
    create: async (run) => {
      runRows.set(run.id, run);
      return run;
    },
    update: async (runId, patch) => {
      runPatches.push({ runId, patch });
      const current = runRows.get(runId);
      if (current === undefined) return null;

      const { pausedAt, ...rest } = patch;
      const next: Run = { ...current, ...rest };
      if (pausedAt === null) delete next.pausedAt;
      else if (pausedAt !== undefined) next.pausedAt = pausedAt;

      runRows.set(runId, next);
      return next;
    },
    recentForWorkflow: async (workflowId, limit) =>
      [...runRows.values()]
        .filter((run) => run.workflowId === workflowId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        .slice(0, limit),
  };

  const nodeRuns: ControlNodeRunStore = {
    get: async (id) => nodeRunRows.get(id) ?? null,
    create: async (nodeRun) => {
      nodeRunRows.set(nodeRun.id, nodeRun);
      return nodeRun;
    },
    listByRun: async (runId) =>
      [...nodeRunRows.values()].filter((row) => row.runId === runId),
    update: async (id, patch) => {
      nodeRunPatches.push({ id, patch });
      const current = nodeRunRows.get(id);
      if (current === undefined) return null;
      const next: NodeRun = { ...current, ...patch };
      nodeRunRows.set(id, next);
      return next;
    },
  };

  return { runs, nodeRuns, runRows, nodeRunRows, runPatches, nodeRunPatches };
}

/* ------------------------------------------------------------------- the bus */

export interface CapturedBus {
  emit: (event: EmittedEvent) => Promise<{ seq: number }>;
  events: EmittedEvent[];
  typesOf: (type: string) => EmittedEvent[];
}

export function createCapturedBus(): CapturedBus {
  const events: EmittedEvent[] = [];
  let seq = 0;

  return {
    emit: async (event) => {
      events.push(event);
      seq += 1;
      return { seq };
    },
    events,
    typesOf: (type) => events.filter((event) => event.type === type),
  };
}

/** A clock that ticks one second per read, so `endedAt` is always after `startedAt`. */
export function tickingClock(startIso = NOW): () => string {
  let ms = Date.parse(startIso);
  return () => {
    ms += 1_000;
    return new Date(ms).toISOString();
  };
}
