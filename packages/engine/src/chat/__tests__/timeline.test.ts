import type { Message, MessageType, Provider, ProviderState } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { EventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import type {
  EngineEvent,
  ProviderAdapter,
  ProviderStatus,
  SecretStore,
} from '../../ports/index.js';
import { createProviderService, type ProviderService } from '../../providers/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { startTimelinePopulation, type TimelinePopulator } from '../timeline.js';
import {
  PROVIDER_ID,
  makeAgentNode,
  makeBus,
  makeClock,
  makeProject,
  makeRun,
  makeSimpleNode,
  makeWorkflow,
  scope,
  silentLogger,
} from './harness.js';

/**
 * The timeline is derived from the persisted event log (FR-CHAT-001, round 4 §2.3): the same run
 * events always produce the same `messages` rows, which is what makes a reconnect show the identical
 * list.
 */
describe('TC-CHAT-001 timeline population from run events', () => {
  let repository: FakeRepository;
  let populator: TimelinePopulator;
  const now = makeClock();

  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const agent = makeAgentNode(workflow.id);
  const output = makeSimpleNode(workflow.id, 'output');
  const runId = newId();

  beforeEach(async () => {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.runs.create(scope, makeRun(runId, workflow.id, projectId, [agent, output]));

    const { bus } = makeBus(repository, now);
    populator = await startTimelinePopulation({ repository, bus, logger: silentLogger, scope, now, nextId: newId });

    const emit = async (
      type: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      await bus.emit({ type, workflowId: workflow.id, runId, payload });
    };

    await emit('run.started', { run: { id: runId } });
    await emit('node.output', {
      runId,
      nodeRunId: newId(),
      nodeId: agent.id,
      output: [{ type: 'text', text: 'The agent answered.' }],
      usage: { tokensIn: 1, tokensOut: 2, costUsd: 0 },
    });
    await emit('node.error', {
      runId,
      nodeRunId: newId(),
      nodeId: agent.id,
      error: { kind: 'agent', code: 'refusal', message: 'The model declined.', retryable: false },
      failureReason: 'RUN_FAILED',
    });
    await emit('node.output', {
      runId,
      nodeRunId: newId(),
      nodeId: output.id,
      output: [{ type: 'text', text: 'Final result.' }],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    await emit('run.completed', {
      runId,
      status: 'HALTED',
      haltReason: 'shutdown',
      totals: { tokensIn: 1, tokensOut: 2, costUsd: 0 },
    });

    await populator.idle();
    await populator.idle();
  });

  async function timeline(): Promise<{ type: MessageType; nodeId?: string }[]> {
    const page = await repository.messages.query(scope, workflow.id, { limit: 100 });
    return page.items.map((message) => ({
      type: message.type,
      ...(message.nodeId === undefined ? {} : { nodeId: message.nodeId }),
    }));
  }

  it('turns run/agent/output/error/system events into distinct message types', async () => {
    const rows = await timeline();
    const types = rows.map((row) => row.type);

    // event (run.started), agent (agent output), error (node.error), output (Output node), event
    // (run.completed) + system (shutdown notice).
    expect(types).toEqual(['event', 'agent', 'error', 'output', 'event', 'system']);
  });

  it('files the agent and output rows on their node', async () => {
    const rows = await timeline();
    expect(rows.find((r) => r.type === 'agent')?.nodeId).toBe(agent.id);
    expect(rows.find((r) => r.type === 'output')?.nodeId).toBe(output.id);
  });

  it('emits message.created for every derived row (FR-CHAT-001)', async () => {
    // The populator re-subscribes to the bus, so a fresh recorder would double count; instead assert
    // the stored rows carry the run and are replayable.
    const page = await repository.messages.query(scope, workflow.id, { limit: 100 });
    expect(page.items).toHaveLength(6);
    expect(page.items.every((m) => m.runId === runId)).toBe(true);
  });

  it('replays identically — a second read returns the same rows in the same order', async () => {
    const first = await timeline();
    const second = await timeline();
    expect(second).toEqual(first);
  });
});

describe('timeline population — lifecycle and skip cases', () => {
  const now = makeClock();
  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const input = makeSimpleNode(workflow.id, 'input');
  const runId = newId();

  async function run(events: { type: string; workflowId?: string; runId?: string; payload: Record<string, unknown> }[]): Promise<MessageType[]> {
    const repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.runs.create(scope, makeRun(runId, workflow.id, projectId, [input]));
    const { bus } = makeBus(repository, now);
    const populator = await startTimelinePopulation({ repository, bus, logger: silentLogger, scope, now, nextId: newId });
    for (const e of events) {
      await bus.emit({ type: e.type, ...(e.workflowId ? { workflowId: e.workflowId } : {}), ...(e.runId ? { runId: e.runId } : {}), payload: e.payload });
    }
    await populator.idle();
    await populator.idle();
    const page = await repository.messages.query(scope, workflow.id, { limit: 100 });
    return page.items.map((m) => m.type);
  }

  it('turns pause and resume into event rows', async () => {
    expect(
      await run([
        { type: 'run.paused', workflowId: workflow.id, runId, payload: { runId } },
        { type: 'run.resumed', workflowId: workflow.id, runId, payload: { runId } },
      ]),
    ).toEqual(['event', 'event']);
  });

  it('a normal completion is one event row with no system notice', async () => {
    expect(
      await run([
        { type: 'run.completed', workflowId: workflow.id, runId, payload: { runId, status: 'COMPLETE', totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 } } },
      ]),
    ).toEqual(['event']);
  });

  it('a crash halt adds a system notice after the event row', async () => {
    expect(
      await run([
        { type: 'run.completed', workflowId: workflow.id, runId, payload: { runId, status: 'HALTED', haltReason: 'crash', totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 } } },
      ]),
    ).toEqual(['event', 'system']);
  });

  it('produces no row for an input node output, an engine-scope event, or an unknown type', async () => {
    expect(
      await run([
        { type: 'node.output', workflowId: workflow.id, runId, payload: { runId, nodeRunId: newId(), nodeId: input.id, output: [{ type: 'text', text: 'brief' }], usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } } },
        { type: 'provider.status', payload: { providerId: newId(), status: 'CONNECTED' } },
        { type: 'tool.call', workflowId: workflow.id, runId, payload: {} },
      ]),
    ).toEqual([]);
  });
});

/*
 * D-073. §2.3: "engine notices (shutdown, crash recovery, provider status changes) → `system`". A
 * provider is engine-wide while a Message belongs to one workflow, so the notice is filed on every
 * workflow with a node configured on that provider — the workflows whose runs the change affects —
 * and only when the status actually changes, so a provider re-checked every 60 s (or flapping)
 * cannot flood a timeline with the same news.
 */
describe('TC-CHAT-001 FR-CHAT-001 a provider status change is a system notice (D-073)', () => {
  const now = makeClock();
  const projectId = newId();
  /** Two workflows on the provider (one of them twice over), one that never names it. */
  const first = makeWorkflow(projectId);
  const second = makeWorkflow(projectId);
  const unrelated = makeWorkflow(projectId);
  const firstWriter = makeAgentNode(first.id);
  const firstReviewer = makeAgentNode(first.id, { name: 'Reviewer' });
  const secondWriter = makeAgentNode(second.id);
  const unrelatedInput = makeSimpleNode(unrelated.id, 'input');

  let repository: FakeRepository;
  let bus: EventBus;
  let providers: ProviderService;
  let populator: TimelinePopulator;
  /** What the provider answers when it is asked (FR-PRV-003); a test moves it. */
  let answer: ProviderStatus;

  function makeProvider(status: ProviderState): Provider {
    const at = '2026-09-30T09:00:00.000Z';
    return {
      id: PROVIDER_ID,
      type: 'openai_compatible',
      name: 'Mock (timeline)',
      keySet: false,
      status,
      concurrency: 2,
      createdAt: at,
      updatedAt: at,
    };
  }

  /** The real provider service, so the event is the persisted one it emits after storing the row. */
  function makeProviders(): ProviderService {
    const adapter: ProviderAdapter = {
      type: 'openai_compatible',
      check: async () => answer,
      listModels: async () => [],
      generate: () => ({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      }),
    };
    const secrets: SecretStore = {
      isAvailable: async () => true,
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    };
    return createProviderService({
      repository,
      scope,
      secrets,
      factory: {
        create: () => adapter,
        manifestFor: () => [],
        mergeCatalog: () => [],
        detect: async () => ({}),
      },
      bus,
      logger: silentLogger,
      now,
    });
  }

  async function setup(seeded: ProviderState): Promise<void> {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    for (const workflow of [first, second, unrelated]) {
      await repository.workflows.create(scope, workflow);
    }
    for (const node of [firstWriter, firstReviewer, secondWriter, unrelatedInput]) {
      await repository.nodes.insert(scope, node);
    }
    await repository.providers.create(scope, makeProvider(seeded));
    bus = makeBus(repository, now).bus;
    providers = makeProviders();
    answer = { status: 'CONNECTED' };
    populator = await startTimelinePopulation({
      repository,
      bus,
      logger: silentLogger,
      scope,
      now,
      nextId: newId,
    });
  }

  async function settle(): Promise<void> {
    await populator.idle();
    await populator.idle();
  }

  async function notices(workflowId: string): Promise<Message[]> {
    const page = await repository.messages.query(scope, workflowId, { limit: 100 });
    return page.items;
  }

  const textOf = (message: Message | undefined): string =>
    (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

  beforeEach(() => setup('UNKNOWN'));

  it('files one system row on each workflow that uses the provider, and none elsewhere', async () => {
    await providers.check(PROVIDER_ID);
    await settle();

    for (const workflow of [first, second]) {
      const rows = await notices(workflow.id);
      // One per workflow, although `first` has two nodes on the provider.
      expect(rows.map((row) => row.type)).toEqual(['system']);
      expect(rows[0]).toMatchObject({ workflowId: workflow.id });
      // An engine notice belongs to no run and no single node.
      expect(rows[0]?.runId).toBeUndefined();
      expect(rows[0]?.nodeId).toBeUndefined();
      expect(textOf(rows[0])).toBe('Provider Mock (timeline) changed from UNKNOWN to CONNECTED.');
    }
    expect(await notices(unrelated.id)).toEqual([]);
  });

  it('announces each row as message.created, like every other timeline row', async () => {
    const created: EngineEvent[] = [];
    await bus.subscribe((event) => {
      if (event.type === 'message.created') created.push(event);
    });

    await providers.check(PROVIDER_ID);
    await settle();

    expect(created.map((event) => event.workflowId).sort()).toEqual([first.id, second.id].sort());
  });

  it('writes a row only on a transition: the same status re-checked writes nothing', async () => {
    // Every 60 s the engine re-checks and re-announces the provider (FR-PRV-004).
    for (let i = 0; i < 20; i += 1) await providers.check(PROVIDER_ID);
    answer = { status: 'UNREACHABLE', message: 'connect ECONNREFUSED 127.0.0.1:9' };
    for (let i = 0; i < 20; i += 1) await providers.check(PROVIDER_ID);
    // A key refused mid-run is recorded the same way (Arch §28), and is a change of its own.
    await providers.recordStatus(PROVIDER_ID, { status: 'AUTH_FAILED', message: 'HTTP 401' });
    await providers.recordStatus(PROVIDER_ID, { status: 'AUTH_FAILED', message: 'HTTP 401' });
    await settle();

    const rows = await notices(first.id);
    expect(rows.map(textOf)).toEqual([
      'Provider Mock (timeline) changed from UNKNOWN to CONNECTED.',
      'Provider Mock (timeline) changed from CONNECTED to UNREACHABLE: connect ECONNREFUSED 127.0.0.1:9',
      'Provider Mock (timeline) changed from UNREACHABLE to AUTH_FAILED: HTTP 401',
    ]);
    expect(rows.every((row) => row.type === 'system')).toBe(true);
  });

  it('a status the provider already had when the engine started is not a change', async () => {
    // The row says CONNECTED, as it would after a restart; the first check agrees.
    await setup('CONNECTED');
    await providers.check(PROVIDER_ID);
    await settle();
    expect(await notices(first.id)).toEqual([]);

    answer = { status: 'RATE_LIMITED' };
    await providers.check(PROVIDER_ID);
    await settle();
    expect((await notices(first.id)).map(textOf)).toEqual([
      'Provider Mock (timeline) changed from CONNECTED to RATE_LIMITED.',
    ]);
  });

  it('CHECKING is a probe in flight, not a status: it neither writes nor resets the last status', async () => {
    await setup('CONNECTED');
    await bus.emit({
      type: 'provider.status',
      payload: { providerId: PROVIDER_ID, status: 'CHECKING' },
    });
    await bus.emit({
      type: 'provider.status',
      payload: { providerId: PROVIDER_ID, status: 'CONNECTED' },
    });
    await settle();
    expect(await notices(first.id)).toEqual([]);
  });

  it('masks anything in the provider’s message that looks like a key (BR-07)', async () => {
    const key = `sk-proj-${'api03'}-AAAABBBBCCCCDDDDEEEE0000`;
    answer = { status: 'AUTH_FAILED', message: `Incorrect API key provided: ${key}` };
    await providers.check(PROVIDER_ID);
    await settle();

    const text = textOf((await notices(first.id))[0]);
    expect(text).toContain('changed from UNKNOWN to AUTH_FAILED: Incorrect API key provided:');
    expect(text).not.toContain(key);
  });

  it('names a provider that is gone by its id rather than dropping the notice', async () => {
    await bus.emit({
      type: 'provider.status',
      payload: { providerId: PROVIDER_ID, status: 'UNREACHABLE' },
    });
    await repository.providers.delete(scope, PROVIDER_ID);
    await bus.emit({
      type: 'provider.status',
      payload: { providerId: PROVIDER_ID, status: 'CONNECTED' },
    });
    await settle();

    const texts = (await notices(first.id)).map(textOf);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(`Provider ${PROVIDER_ID} changed from UNREACHABLE to CONNECTED.`);
  });

  it('replays identically: the rows are stored, and a restarted populator does not re-announce', async () => {
    await providers.check(PROVIDER_ID);
    answer = { status: 'UNREACHABLE' };
    await providers.check(PROVIDER_ID);
    await settle();
    const before = await notices(first.id);
    expect(before).toHaveLength(2);

    // A reconnecting client reads the same rows in the same order.
    expect(await notices(first.id)).toEqual(before);

    // An engine restart: a fresh populator seeds from the stored provider rows, so the next
    // periodic check that finds the provider as it was adds nothing.
    populator.unsubscribe();
    populator = await startTimelinePopulation({
      repository,
      bus,
      logger: silentLogger,
      scope,
      now,
      nextId: newId,
    });
    await providers.check(PROVIDER_ID);
    await settle();
    expect(await notices(first.id)).toEqual(before);
  });
});
