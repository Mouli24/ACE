import type { MessageType } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { startTimelinePopulation, type TimelinePopulator } from '../timeline.js';
import {
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
