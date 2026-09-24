import {
  DEFAULT_CONCURRENCY,
  type CursorQuery,
  type Edge,
  type Envelope,
  type Id,
  type Model,
  type Node,
  type NodeRun,
  type NodeState,
  type Page,
  type Part,
  type ProviderCheckResult,
  type Run,
  type RunSummary,
  type StartRunRequest,
  type Usage,
} from '@ace/contracts';

import { contractFor, createTruncatingSummariser, estimatePartsTokens, trustForSource, type Summariser } from '../envelopes/index.js';
import { buildEnvelope } from '../envelopes/index.js';
import type { EventBus } from '../events/index.js';
import { notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { ModelRouter, ProviderAdapter, Repository, Scope } from '../ports/index.js';
import { sumUsage } from './cost.js';
import { createNodeExecutor, type NodeExecutionOutcome, type NodeExecutor } from './executor.js';
import { preflight } from './preflight.js';
import { toSummary } from './summary.js';

export * from './cost.js';
export * from './executor.js';
export * from './preflight.js';
export * from './transform.js';
export * from './machines/index.js';
export * from './lifecycle.js';
export * from './summary.js';

/**
 * The run service and scheduler (FR-EXE-001..012, Arch §12.2, §12.3, BR-04).
 *
 * `startRun` freezes the snapshot with the run row in one transaction and then drives the graph
 * from that snapshot alone — never from the live tables. That is what makes TC-EXE-002 and
 * TC-NODE-008 true rather than merely intended: a node deleted or edited mid-run changes
 * nothing, because the scheduler is not looking at it.
 */

/** A run that has been recorded and pre-flighted, and the promise of its end. */
export interface BegunRun {
  /** The row as it stands once pre-flight is over: `RUNNING`, or `BLOCKED` with its issues. */
  run: Run;
  /** Settles with the final row when the scheduler stops driving the run. Never rejects. */
  done: Promise<Run>;
}

export interface RunService {
  /**
   * Records the run, pre-flights it and starts the scheduler in the background. This is what
   * `POST /workflows/:id/runs` answers with: the client subscribes after the response, so the run
   * must still be in flight when it arrives (§2.4, §5 item 6).
   */
  beginRun(workflowId: Id, request: StartRunRequest): Promise<BegunRun>;
  /** `beginRun` and then wait for the end — for callers that want the finished run. */
  startRun(workflowId: Id, request: StartRunRequest): Promise<Run>;
  getRun(runId: Id): Promise<Run>;
  listRuns(workflowId: Id, page: CursorQuery): Promise<Page<RunSummary>>;
  listNodeRuns(runId: Id): Promise<NodeRun[]>;
  getNodeRun(nodeRunId: Id): Promise<NodeRun>;
  /** Aborts every in-flight call and waits for the dispatch loops to unwind (FR-SYS-008). */
  shutdown(): Promise<void>;
  /** How many runs are still being driven by this process. */
  activeRunCount(): number;
}

export interface RunServiceDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  router: ModelRouter;
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  checkProvider: (providerId: Id) => Promise<ProviderCheckResult>;
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  summariser?: Summariser;
  now?: () => string;
  nextId?: () => string;
  tokenBatchMs?: number;
}

/** A ≤120-character description of what crossed an edge (FR-EXE-015, §2.4). */
export function transferSummary(parts: readonly Part[]): string {
  const kinds = [...new Set(parts.map((part) => part.type))].join(', ');
  const tokens = estimatePartsTokens(parts);
  return `${kinds || 'nothing'} · ~${tokens} tokens`.slice(0, 120);
}

/** Node states that mean the run still has work in flight (Arch §19.2). */
const BUSY_STATES: ReadonlySet<NodeState> = new Set<NodeState>(['RUNNING', 'READY', 'WAITING']);

export function createRunService(deps: RunServiceDeps): RunService {
  const { repository, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const summariser = deps.summariser ?? createTruncatingSummariser();

  const executor: NodeExecutor = createNodeExecutor({
    bus,
    logger,
    adapterFor: deps.adapterFor,
    modelsFor: () => repository.models.list(scope, {}),
    runGated: deps.runGated,
    router: deps.router,
    ...(deps.tokenBatchMs === undefined ? {} : { tokenBatchMs: deps.tokenBatchMs }),
  });

  /** Every run this process is currently driving, so shutdown can abort them (FR-SYS-008). */
  const active = new Map<Id, { controller: AbortController; done: Promise<void> }>();

  async function emitNodeState(
    run: Run,
    nodeRun: NodeRun,
    status: NodeState,
    failureReason?: NodeRun['failureReason'],
  ): Promise<void> {
    await bus.emit({
      type: 'node.state',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        iteration: nodeRun.iteration,
        attempt: nodeRun.attempt,
        status,
        ...(failureReason === undefined ? {} : { failureReason }),
      },
    });
  }

  /* ------------------------------------------------------------- readiness */

  /**
   * A node is ready when every input port that has edges has what it needs: all of them for a
   * single-input port, at least one for a `multi` port (§2.6 of round 1's port model, Arch §12.3).
   */
  function isReady(node: Node, edges: readonly Edge[], delivered: ReadonlySet<Id>): boolean {
    const incoming = edges.filter((edge) => edge.to.nodeId === node.id);
    if (incoming.length === 0) return true;

    const byPort = new Map<string, Edge[]>();
    for (const edge of incoming) {
      byPort.set(edge.to.portId, [...(byPort.get(edge.to.portId) ?? []), edge]);
    }

    for (const [portId, portEdges] of byPort) {
      const port = node.inputs.find((candidate) => candidate.id === portId);
      const needed = port?.multi === true ? 1 : portEdges.length;
      const arrived = portEdges.filter((edge) => delivered.has(edge.id)).length;
      if (arrived < needed) return false;
    }

    return true;
  }

  /** Everything downstream of a node, transitively — what a failure takes with it. */
  function downstreamOf(nodeId: Id, edges: readonly Edge[]): Set<Id> {
    const reached = new Set<Id>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of edges) {
        if (edge.from.nodeId !== current || reached.has(edge.to.nodeId)) continue;
        reached.add(edge.to.nodeId);
        queue.push(edge.to.nodeId);
      }
    }

    return reached;
  }

  /* ------------------------------------------------------------- the drive */

  async function drive(run: Run, signal: AbortSignal): Promise<Run> {
    const { nodes, edges } = run.snapshot;
    const settings = await repository.settings.get(scope);
    const limit = settings.concurrency > 0 ? settings.concurrency : DEFAULT_CONCURRENCY;

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const states = new Map<Id, NodeState>(nodes.map((node) => [node.id, 'IDLE' as NodeState]));
    const nodeRunByNode = new Map<Id, NodeRun>();
    const envelopesFor = new Map<Id, Envelope[]>();
    const deliveredEdges = new Set<Id>();
    const usages: Usage[] = [];
    const finalOutput: Record<Id, Part[]> = {};

    /** One node run row per node, created when the node is first dispatched. */
    async function beginNodeRun(node: Node): Promise<NodeRun> {
      const nodeRun: NodeRun = {
        id: nextId(),
        runId: run.id,
        nodeId: node.id,
        iteration: 1,
        attempt: 1,
        status: 'READY',
        inputEnvelopes: envelopesFor.get(node.id) ?? [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        verdicts: [],
        toolCalls: [],
        startedAt: now(),
      };

      await repository.nodeRuns.create(scope, nodeRun);
      nodeRunByNode.set(node.id, nodeRun);
      await emitNodeState(run, nodeRun, 'READY');
      return nodeRun;
    }

    /** Deliver a completed node's output along its outgoing edges (FR-EXE-005, FR-EXE-015). */
    async function deliver(node: Node, parts: Part[]): Promise<void> {
      const outgoing = edges.filter((edge) => edge.from.nodeId === node.id && edge.kind === 'data');
      const targets = new Set(outgoing.map((edge) => edge.to.nodeId));

      for (const targetId of targets) {
        const target = nodeById.get(targetId);
        if (target === undefined) continue;

        const budgetTokens =
          target.kind === 'agent' ? target.config.contextPolicy.budgetTokens : Number.MAX_SAFE_INTEGER;
        const outputTypes =
          target.kind === 'agent' || target.kind === 'model' ? target.config.outputTypes : ['text' as const];

        const envelope = buildEnvelope(
          {
            id: nextId(),
            runId: run.id,
            fromNodeId: node.id,
            toNodeId: targetId,
            iteration: 1,
            parts,
            budgetTokens,
            // BR-13: only an Input node's content is trusted.
            trust: trustForSource(node.kind),
            contract: contractFor(
              outputTypes,
              target.kind === 'agent' ? target.config.outputContract?.jsonSchema : undefined,
            ),
            createdAt: now(),
          },
          summariser,
        );

        envelopesFor.set(targetId, [...(envelopesFor.get(targetId) ?? []), envelope]);
      }

      for (const edge of outgoing) {
        deliveredEdges.add(edge.id);
        await bus.emit({
          type: 'edge.transfer',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            edgeId: edge.id,
            fromNodeId: edge.from.nodeId,
            toNodeId: edge.to.nodeId,
            iteration: 1,
            summary: transferSummary(parts),
          },
        });
      }
    }

    /** A failed node takes everything that could only be reached through it (FR-ERR-006). */
    async function blockDownstream(node: Node): Promise<void> {
      for (const blockedId of downstreamOf(node.id, edges)) {
        if (states.get(blockedId) !== 'IDLE') continue;
        const blocked = nodeById.get(blockedId);
        if (blocked === undefined) continue;
        if (isReady(blocked, edges, deliveredEdges)) continue;

        states.set(blockedId, 'BLOCKED');
        const nodeRun: NodeRun = {
          id: nextId(),
          runId: run.id,
          nodeId: blockedId,
          iteration: 1,
          attempt: 1,
          status: 'BLOCKED',
          failureReason: 'BLOCKED',
          inputEnvelopes: envelopesFor.get(blockedId) ?? [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          verdicts: [],
          toolCalls: [],
        };
        await repository.nodeRuns.create(scope, nodeRun);
        nodeRunByNode.set(blockedId, nodeRun);
        await emitNodeState(run, nodeRun, 'BLOCKED', 'BLOCKED');
      }
    }

    async function finish(node: Node, nodeRun: NodeRun, outcome: NodeExecutionOutcome): Promise<void> {
      const endedAt = now();
      usages.push(outcome.usage);

      await repository.nodeRuns.update(scope, nodeRun.id, {
        status: outcome.status,
        ...(outcome.failureReason === undefined ? {} : { failureReason: outcome.failureReason }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.modelUsed === undefined ? {} : { modelUsed: outcome.modelUsed }),
        ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
        output: outcome.output,
        usage: outcome.usage,
        endedAt,
      });

      states.set(node.id, outcome.status);
      await emitNodeState(run, nodeRunByNode.get(node.id)!, outcome.status, outcome.failureReason);

      // Totals are the running sum of the node runs, so the number a client sees mid-run is the
      // same arithmetic as the number stored at the end (TC-OBS-002).
      await bus.emit({
        type: 'usage.updated',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id, totals: sumUsage(usages) },
      });

      if (outcome.status === 'COMPLETED') {
        if (node.kind === 'output') finalOutput[node.id] = outcome.output;
        await deliver(node, outcome.output);
      } else {
        await blockDownstream(node);
      }
    }

    async function dispatch(node: Node): Promise<void> {
      states.set(node.id, 'RUNNING');
      const nodeRun = await beginNodeRun(node);
      await repository.nodeRuns.update(scope, nodeRun.id, { status: 'RUNNING' });
      await emitNodeState(run, nodeRun, 'RUNNING');

      const outcome = await executor.execute({
        runId: run.id,
        workflowId: run.workflowId,
        nodeRunId: nodeRun.id,
        node,
        envelopes: envelopesFor.get(node.id) ?? [],
        iteration: 1,
        attempt: 1,
        runInputs: run.inputs,
        signal,
      });

      await finish(node, nodeRun, outcome);
    }

    /* The loop of Arch §12.3: mark ready, dispatch up to the limit, wait, repeat. */
    const inFlight = new Set<Promise<void>>();

    while (!signal.aborted) {
      const ready = nodes.filter(
        (node) => states.get(node.id) === 'IDLE' && isReady(node, edges, deliveredEdges),
      );

      for (const node of ready) {
        if (inFlight.size >= limit) break;
        const promise = dispatch(node).finally(() => inFlight.delete(promise));
        inFlight.add(promise);
      }

      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }

    await Promise.allSettled(inFlight);

    /* FR-EXE-011: COMPLETE only when every Output node finished and nothing is still going. */
    const outputNodes = nodes.filter((node) => node.kind === 'output');
    const allOutputsDone =
      outputNodes.length > 0 &&
      outputNodes.every((node) => states.get(node.id) === 'COMPLETED');
    const stillBusy = [...states.values()].some((state) => BUSY_STATES.has(state));

    const complete = allOutputsDone && !stillBusy && !signal.aborted;
    const endedAt = now();
    const totals = sumUsage(usages);

    const updated = await repository.runs.update(scope, run.id, {
      status: complete ? 'COMPLETE' : 'HALTED',
      ...(complete ? {} : { haltReason: signal.aborted ? 'shutdown' : 'failure' }),
      totals,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
      finalOutput,
    });

    await bus.emit({
      type: 'run.completed',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        status: complete ? 'COMPLETE' : 'HALTED',
        ...(complete ? {} : { haltReason: signal.aborted ? 'shutdown' : 'failure' }),
        totals,
        finalOutput,
      },
    });

    return updated ?? run;
  }

  /* --------------------------------------------------------------- service */

  const service: RunService = {
    async beginRun(workflowId, request) {
      const workflow = await repository.workflows.get(scope, workflowId);
      if (workflow === null) throw notFound(`workflow ${workflowId}`);

      const startedAt = now();

      // BR-04: the snapshot and the run row are written together, so there is no instant at
      // which a run exists without the graph it is going to execute.
      const run = await repository.transaction(async (tx) => {
        const [nodes, edges] = await Promise.all([
          tx.nodes.listByWorkflow(scope, workflowId),
          tx.edges.listByWorkflow(scope, workflowId),
        ]);

        const created: Run = {
          id: nextId(),
          workflowId,
          projectId: workflow.projectId,
          status: 'PREFLIGHT',
          snapshot: { version: workflow.version, nodes, edges },
          inputs: request.inputs ?? {},
          preflightIssues: [],
          totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          startedAt,
        };

        return tx.runs.create(scope, created);
      });

      const [providers, models] = await Promise.all([
        repository.providers.list(scope),
        repository.models.list(scope, {}),
      ]);

      const issues = await preflight({
        nodes: run.snapshot.nodes,
        edges: run.snapshot.edges,
        inputs: run.inputs,
        providers,
        models,
        checkProvider: deps.checkProvider,
      });

      if (issues.length > 0) {
        // BLOCKED, with zero generate() calls (BR-08). Still a run: it is recorded, inspectable
        // and listed in the history, because "why did it not start" is a question worth keeping.
        const withIssues =
          (await repository.runs.update(scope, run.id, {
            status: 'BLOCKED',
            preflightIssues: issues,
            endedAt: now(),
            durationMs: 0,
          })) ?? { ...run, status: 'BLOCKED' as const, preflightIssues: issues };

        await bus.emit({
          type: 'run.started',
          workflowId,
          runId: run.id,
          payload: { run: toSummary(withIssues) },
        });
        await bus.emit({
          type: 'run.completed',
          workflowId,
          runId: run.id,
          payload: { runId: run.id, status: 'BLOCKED', totals: withIssues.totals },
        });

        logger.info(
          { subsystem: 'runs', runId: run.id, issues: issues.length },
          'run blocked by pre-flight',
        );
        return { run: withIssues, done: Promise.resolve(withIssues) };
      }

      const running = (await repository.runs.update(scope, run.id, { status: 'RUNNING' })) ?? run;

      await bus.emit({
        type: 'run.started',
        workflowId,
        runId: run.id,
        payload: { run: toSummary(running) },
      });

      const controller = new AbortController();
      const done = drive(running, controller.signal)
        .catch(async (error: unknown) => {
          // The drive threw rather than halting cleanly; the row is still the truth about the run.
          logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'run failed');
          return (await repository.runs.get(scope, run.id)) ?? running;
        })
        .finally(() => active.delete(run.id));

      active.set(run.id, {
        controller,
        done: done.then(
          () => undefined,
          () => undefined,
        ),
      });

      return { run: running, done };
    },

    async startRun(workflowId, request) {
      const { done } = await service.beginRun(workflowId, request);
      return done;
    },

    async getRun(runId) {
      const run = await repository.runs.get(scope, runId);
      if (run === null) throw notFound(`run ${runId}`);
      return run;
    },

    async listRuns(workflowId, page) {
      const runs = await repository.runs.listByWorkflow(scope, workflowId, page);
      return {
        items: runs.items.map(toSummary),
        ...(runs.nextCursor === undefined ? {} : { nextCursor: runs.nextCursor }),
      };
    },

    listNodeRuns: (runId) => repository.nodeRuns.listByRun(scope, runId),

    async getNodeRun(nodeRunId) {
      const nodeRun = await repository.nodeRuns.get(scope, nodeRunId);
      if (nodeRun === null) throw notFound(`node run ${nodeRunId}`);
      return nodeRun;
    },

    async shutdown() {
      for (const { controller } of active.values()) controller.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.done));
    },

    activeRunCount: () => active.size,
  };

  return service;
}

/** Catalog rows as the router wants them — exported for the composition root. */
export function toRouterModels(models: readonly Model[]) {
  return models.map((model) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    available: model.available,
    inputTypes: model.inputTypes,
    outputTypes: model.outputTypes,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  }));
}
