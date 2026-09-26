import { AgentConfigSchema, type Model, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../../../events/index.js';
import { createLogger } from '../../../logging/index.js';
import { LOCAL_SCOPE, type ModelRouter, type ProviderAdapter, type StreamChunk } from '../../../ports/index.js';
import { createNodeExecutor } from '../../executor.js';
import { FakeRepository } from '../../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../../__tests__/pubsub-stub.js';
import { createRunGate, createRunGateRegistry } from '../gate.js';
import { createRunControls } from '../service.js';
import {
  NOW,
  PROVIDER_ID,
  createCapturedBus,
  createFakeStores,
  makeEnvelope,
  makeNodeRun,
  makeRun,
  tickingClock,
} from './harness.js';

/**
 * TC-CTL-003 with a number on it (FR-CTL-003: "Provider streams closed within 2 s").
 *
 * This one deliberately goes through the real node executor rather than a stand-in. The claim being
 * measured is not "the controls set a flag quickly" — that would be trivially true — it is that the
 * signal the controls abort is the same signal a provider stream is reading, and that the stream
 * closes when it is aborted. Only the executor can make that true, so the executor is in the loop.
 */

const WRITER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WRITR';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN99';

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'mock-slow',
  displayName: 'Mock slow',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

const writer: Node = {
  id: WRITER_ID,
  workflowId: '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW',
  kind: 'agent',
  name: 'Writer',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${WRITER_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${WRITER_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'mock-slow',
    instructions: 'Write slowly.',
    inputTypes: ['text'],
    outputTypes: ['text'],
  }),
};

const route = (): ReturnType<ModelRouter['resolve']> => ({
  ok: true,
  route: { providerId: PROVIDER_ID, modelId: 'mock-slow', viaFallback: false },
});

const router: ModelRouter = { resolve: route, resolveForBench: route };

/**
 * `mock-slow`: a stream that keeps yielding until it is aborted. It records the moment its
 * generator actually finishes, which is the moment the provider stream is closed.
 */
function slowAdapter(): { adapter: ProviderAdapter; closedAt: () => number | undefined } {
  let closed: number | undefined;

  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(_request, signal) {
      return (async function* (): AsyncGenerator<StreamChunk> {
        try {
          for (let index = 0; index < 10_000; index += 1) {
            if (signal.aborted) {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            yield { type: 'text', delta: `token ${index} ` };
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 5);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          yield { type: 'finish', reason: 'stop' };
        } finally {
          closed = performance.now();
        }
      })();
    },
  };

  return { adapter, closedAt: () => closed };
}

describe('TC-CTL-003 Stop closes provider streams within 2 s (FR-CTL-003)', () => {
  it('measures the latency from the stop call to the stream closing', async () => {
    const scope = LOCAL_SCOPE;
    const repository = new FakeRepository();
    const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
    const bus = createEventBus({ repository, scope, pubsub: new InProcessPubSubStub(), now: () => NOW });

    const run = makeRun({ snapshot: { version: 1, nodes: [writer], edges: [] }, status: 'RUNNING' });
    const nodeRun = makeNodeRun(run, writer.id, { id: NODE_RUN_ID, status: 'RUNNING' });
    const stores = createFakeStores({ runs: [run], nodeRuns: [nodeRun] });

    const gates = createRunGateRegistry();
    const gate = createRunGate(run.id);
    gates.register(gate);

    const controls = createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus: createCapturedBus(),
      gates,
      now: tickingClock(),
      driveRecordedRun: async (value) => value,
      drivePartialRun: async (plan) => plan.run,
    });

    const { adapter, closedAt } = slowAdapter();
    const executor = createNodeExecutor({
      bus,
      logger,
      adapterFor: async () => adapter,
      modelsFor: async () => [model],
      runGated: (_providerId, fn) => fn(),
      router,
      tokenBatchMs: 5,
    });

    const release = gate.track(writer.id);
    const executing = executor.execute({
      runId: run.id,
      workflowId: run.workflowId,
      nodeRunId: NODE_RUN_ID,
      node: writer,
      envelopes: [makeEnvelope(run, '01JBXQ8Z9KQ4R7N2VWXYZ0BRIEF', writer.id, 'the brief')],
      iteration: 1,
      attempt: 1,
      runInputs: {},
      signal: gate.signal,
    });

    // Let the stream get going, so the stop lands mid-flight rather than before the first token.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    const stopCalledAt = performance.now();
    const halted = await controls.stop(run.id);
    const outcome = await executing;
    release();
    await gate.idle();

    const latencyMs = (closedAt() ?? performance.now()) - stopCalledAt;

    // eslint-disable-next-line no-console
    console.log(
      `TC-CTL-003: provider stream closed ${latencyMs.toFixed(1)} ms after the stop call ` +
        `(budget 2000 ms)`,
    );

    expect(latencyMs).toBeLessThan(2_000);
    expect(closedAt()).toBeDefined();

    // The stop is what ended it, and the node run and the run both say so (BR-03, BR-12).
    expect(outcome.status).toBe('STOPPED');
    expect(outcome.error?.kind).toBe('user_cancelled');
    expect(halted).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(stores.nodeRunRows.get(NODE_RUN_ID)?.status).toBe('STOPPED');
    expect(gate.abortCause()).toBe('stopped');
  });

  it('a stop before the stream starts closes it just as fast', async () => {
    const run = makeRun({ snapshot: { version: 1, nodes: [writer], edges: [] }, status: 'RUNNING' });
    const stores = createFakeStores({ runs: [run] });
    const gates = createRunGateRegistry();
    const gate = createRunGate(run.id);
    gates.register(gate);

    const controls = createRunControls({
      runs: stores.runs,
      nodeRuns: stores.nodeRuns,
      bus: createCapturedBus(),
      gates,
      now: tickingClock(),
      driveRecordedRun: async (value) => value,
      drivePartialRun: async (plan) => plan.run,
    });

    const startedAt = performance.now();
    await controls.stop(run.id);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(gate.signal.aborted).toBe(true);
  });
});
