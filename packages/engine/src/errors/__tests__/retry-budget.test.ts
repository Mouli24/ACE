import {
  AgentConfigSchema,
  type Edge,
  type Model,
  type Node,
  type NodeError,
  type NodeRun,
  type Provider,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelRouter,
  type RouteResult,
  type StreamChunk,
} from '../../ports/index.js';
import { createRunGateRegistry, createRunService } from '../../runs/index.js';
import { autoRetryDecision, retryBackoffDelayMs } from '../index.js';

/**
 * FR-ERR-005, R3 §2.1, Arch §28: what the backoff rule re-sends, and what it counts.
 *
 * Two defects in `autoRetryDecision`: it never read `error.retryable`, so an adapter's unrecognised
 * failure (`provider` / `unknown`, `retryable: false`) was re-sent until `execution.retries` ran
 * out; and it spent the backoff budget by attempt number, so a contract repair — which §2.1 gives
 * a node on top of its retries — used up one of them.
 */

const error = (kind: NodeError['kind'], code: string, retryable: boolean): NodeError => ({
  kind,
  code,
  message: code,
  retryable,
});

const http503 = error('provider', 'http_503', true);

describe('TC-ERR-005 FR-ERR-005 the backoff rule re-sends only what a retry can fix', () => {
  it('never re-sends a provider failure the adapter marked retryable: false', () => {
    const decision = autoRetryDecision({
      error: error('provider', 'unknown', false),
      attempt: 1,
      maxRetries: 2,
    });

    expect(decision).toMatchObject({ retry: false, mode: 'backoff' });
    expect(decision.reason).toContain('not retryable');
  });

  it('never re-sends a network failure marked retryable: false either', () => {
    expect(
      autoRetryDecision({ error: error('network', 'x', false), attempt: 1, maxRetries: 5 }).retry,
    ).toBe(false);
  });

  it('still re-sends one marked retryable: true, with the D105 wait', () => {
    expect(autoRetryDecision({ error: http503, attempt: 1, maxRetries: 2 })).toMatchObject({
      retry: true,
      nextAttempt: 2,
      delayMs: 500,
      repairPrompt: false,
    });
  });

  it('leaves the contract repair to its own rule, whatever retryable says', () => {
    // The executor records a broken contract with retryable: false; its one repair still follows.
    for (const code of ['contract_violation', 'refusal']) {
      expect(
        autoRetryDecision({ error: error('agent', code, false), attempt: 1, maxRetries: 0 }),
      ).toMatchObject({ retry: true, mode: 'contract_repair', repairPrompt: true, delayMs: 0 });
    }
  });
});

describe('TC-ERR-005 FR-ERR-005 a contract repair does not spend a backoff retry (R3 §2.1)', () => {
  it('retries a 503 on attempt 2 with retries: 1 when attempt 1 was a contract repair', () => {
    const decision = autoRetryDecision({
      error: http503,
      attempt: 2,
      maxRetries: 1,
      contractRepairs: 1,
    });

    // 0 of 1 backoff retries used; the wait keeps D105's curve, keyed on the attempt that failed.
    expect(decision).toMatchObject({
      retry: true,
      mode: 'backoff',
      nextAttempt: 3,
      delayMs: retryBackoffDelayMs(2),
      repairPrompt: false,
    });
  });

  it('stops once the backoff retries themselves are spent', () => {
    const decision = autoRetryDecision({
      error: http503,
      attempt: 3,
      maxRetries: 1,
      contractRepairs: 1,
    });

    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('1 automatic retries');
  });

  it('counts the attempts exactly as before when there was no repair', () => {
    expect(autoRetryDecision({ error: http503, attempt: 2, maxRetries: 1 }).retry).toBe(false);
    expect(autoRetryDecision({ error: http503, attempt: 2, maxRetries: 2 }).retry).toBe(true);
  });

  it('never counts more repairs than attempts into a negative budget', () => {
    expect(
      autoRetryDecision({ error: http503, attempt: 1, maxRetries: 0, contractRepairs: 3 }).retry,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Through the run driver, as `runs/index.ts` calls it today                   */
/* -------------------------------------------------------------------------- */

const scope = LOCAL_SCOPE;
const NOW = '2026-09-29T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';

const provider: Provider = {
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'scripted',
  displayName: 'Scripted',
  inputTypes: ['text'],
  outputTypes: ['text', 'json'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: true,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
};

/** A fixed route with no fallback: once its one model has failed, the chain is exhausted. */
const router: ModelRouter = {
  resolve: (_node, _requirements, { failures }): RouteResult =>
    failures.length > 0
      ? { ok: false, code: 'no_candidate_left', reason: 'No fallback model is left.' }
      : { ok: true, route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false } },
  resolveForBench: () => ({
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false },
  }),
};

/** One scripted answer per call: text to stream, or something to throw. */
type Answer = { text: string } | { throws: unknown };

/** Brief → Writer → Result, with Writer's calls scripted; returns Writer's node runs, in order. */
async function runWriter(
  answers: Answer[],
  writer: { outputType: 'text' | 'json'; retries: number },
): Promise<{ attempts: NodeRun[]; calls: number }> {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: () => NOW,
  });
  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency: 4 });

  let calls = 0;
  const service = createRunService({
    gates: createRunGateRegistry(),
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    router,
    adapterFor: async () => ({
      type: 'mock',
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      generate: () =>
        (async function* (): AsyncGenerator<StreamChunk> {
          const answer = answers[Math.min(calls, answers.length - 1)];
          calls += 1;
          await Promise.resolve();
          if (answer === undefined || 'throws' in answer) throw answer?.throws;
          yield { type: 'text', delta: answer.text };
          yield { type: 'usage', tokensIn: 2, tokensOut: 3 };
          yield { type: 'finish', reason: 'stop' };
        })(),
    }),
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
  });

  const workflowId = newId();
  const port = (nodeId: string, dir: 'in' | 'out', dataType: 'text' | 'json') => ({
    id: `${nodeId}:${dir}:${dataType}`,
    name: dataType,
    dataType,
    multi: dir === 'out',
  });
  const briefId = newId();
  const writerId = newId();
  const resultId = newId();
  const nodes: Node[] = [
    {
      id: briefId,
      workflowId,
      kind: 'input',
      name: 'Brief',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [port(briefId, 'out', 'text')],
      config: { text: 'the brief', artifactIds: [], outputTypes: ['text'] },
    },
    {
      id: writerId,
      workflowId,
      kind: 'agent',
      name: 'Writer',
      position: { x: 0, y: 0 },
      inputs: [port(writerId, 'in', 'text')],
      outputs: [port(writerId, 'out', writer.outputType)],
      config: AgentConfigSchema.parse({
        providerId: PROVIDER_ID,
        modelId: 'scripted',
        instructions: 'Act as Writer.',
        inputTypes: ['text'],
        outputTypes: [writer.outputType],
        execution: { retries: writer.retries },
      }),
    },
    {
      id: resultId,
      workflowId,
      kind: 'output',
      name: 'Result',
      position: { x: 0, y: 0 },
      inputs: [port(resultId, 'in', writer.outputType)],
      outputs: [],
      config: {},
    },
  ];
  const edge = (from: Node, to: Node): Edge => ({
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  });
  await repository.workflows.create(scope, {
    id: workflowId,
    projectId: PROJECT_ID,
    name: 'Flow',
    version: 1,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const node of nodes) await repository.nodes.insert(scope, node);
  await repository.edges.insert(scope, edge(nodes[0]!, nodes[1]!));
  await repository.edges.insert(scope, edge(nodes[1]!, nodes[2]!));

  const run = await service.startRun(workflowId, {});
  const attempts = (await repository.nodeRuns.listByRun(scope, run.id))
    .filter((row) => row.nodeId === writerId)
    .sort((a, b) => a.attempt - b.attempt);
  return { attempts, calls };
}

const thrown = (nodeError: NodeError): Error =>
  Object.assign(new Error(nodeError.message), { nodeError });

describe('TC-ERR-005 FR-ERR-005 the run driver, with the inputs it passes today', () => {
  it('makes one call for an unrecognised adapter failure, however many retries are allowed', async () => {
    // A plain Error is classified provider / unknown, retryable: false (Arch §28).
    const { attempts, calls } = await runWriter([{ throws: new Error('adapter bug') }], {
      outputType: 'text',
      retries: 2,
    });

    expect(calls).toBe(1);
    expect(attempts).toMatchObject([
      { attempt: 1, status: 'FAILED', error: { kind: 'provider', retryable: false } },
    ]);
  });

  it('repairs a broken contract and still retries the 503 that follows, with retries: 1', async () => {
    const { attempts, calls } = await runWriter(
      [{ text: 'not json at all' }, { throws: thrown(http503) }, { text: '{"ok":true}' }],
      { outputType: 'json', retries: 1 },
    );

    expect(calls).toBe(3);
    expect(attempts).toMatchObject([
      { attempt: 1, status: 'FAILED', failureReason: 'CONTRACT_VIOLATION' },
      { attempt: 2, status: 'FAILED', error: { kind: 'provider', code: 'http_503' } },
      { attempt: 3, status: 'COMPLETED' },
    ]);
  });
});
