import type { Message, MessageType } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { ChatService } from '../service.js';
import { makeBus, makeChatService, makeClock, makeProject, makeWorkflow, scope } from './harness.js';

/**
 * The timeline filter API (FR-CHAT-002): run, node and type combine, so a client can ask for exactly
 * the rows it wants and get no others.
 */
describe('TC-CHAT-002 timeline filters combine', () => {
  let repository: FakeRepository;
  let service: ChatService;
  const now = makeClock();

  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const runA = newId();
  const runB = newId();
  const nodeX = newId();
  const nodeY = newId();

  const row = (partial: Partial<Message> & Pick<Message, 'type'>): Message => ({
    id: newId(),
    workflowId: workflow.id,
    type: partial.type,
    content: [{ type: 'text', text: partial.type }],
    at: now(),
    ...(partial.runId === undefined ? {} : { runId: partial.runId }),
    ...(partial.nodeId === undefined ? {} : { nodeId: partial.nodeId }),
  });

  beforeEach(async () => {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    service = makeChatService(repository, makeBus(repository, now).bus, { workflowId: workflow.id, now });

    await repository.messages.append(scope, row({ type: 'event', runId: runA }));
    await repository.messages.append(scope, row({ type: 'agent', runId: runA, nodeId: nodeX }));
    await repository.messages.append(scope, row({ type: 'error', runId: runA, nodeId: nodeX }));
    await repository.messages.append(scope, row({ type: 'error', runId: runA, nodeId: nodeY }));
    await repository.messages.append(scope, row({ type: 'agent', runId: runB, nodeId: nodeX }));
  });

  async function types(query: Parameters<ChatService['listMessages']>[1]): Promise<MessageType[]> {
    const result = await service.listMessages(workflow.id, query);
    return result.items.map((m) => m.type);
  }

  it('filters by run', async () => {
    expect(await types({ runId: runB })).toEqual(['agent']);
  });

  it('filters by node and type together', async () => {
    // node X, errors only → the one error on node X, not the error on node Y nor the agent row.
    expect(await types({ nodeId: nodeX, type: ['error'] })).toEqual(['error']);
  });

  it('combines run, node and type', async () => {
    expect(await types({ runId: runA, nodeId: nodeX, type: ['agent', 'error'] })).toEqual([
      'agent',
      'error',
    ]);
  });

  it('returns the whole timeline with no filter', async () => {
    expect(await types({})).toHaveLength(5);
  });
});
