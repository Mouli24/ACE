import {
  NodeSchema,
  derivePorts,
  type DataType,
  type Id,
  type Model,
  type Node,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { ChatMessage } from '@ace/contracts';
import {
  MODEL_ID,
  PROVIDER_ID,
  makeBus,
  makeChatService,
  makeClock,
  makeProject,
  makeWorkflow,
  scope,
} from './harness.js';

/**
 * Direct chat with a `model` node (FR-CHAT-004), which exercises the branches the agent-node tests
 * never reach: the system prompt / context budget / routing all come from the model config's
 * defaults and `providerId`/`modelId` are absent so the router decides. A matching catalog row
 * also prices the reply.
 */
describe('direct chat with a model node', () => {
  const now = makeClock();
  const projectId = newId();
  const workflow = makeWorkflow(projectId);

  function modelNode(overrides: { systemPrompt?: string; timeoutMs?: number } = {}): Node {
    const id = newId();
    const config = {
      // No providerId / modelId: the router resolves the model (the `undefined` spread branches).
      ...(overrides.systemPrompt === undefined ? {} : { systemPrompt: overrides.systemPrompt }),
      inputTypes: ['text'] as DataType[],
      outputTypes: ['text'] as DataType[],
      execution: {
        maxTokens: 1000,
        temperature: 0.2,
        timeoutMs: overrides.timeoutMs ?? 30_000,
        retries: 0,
      },
    };
    return NodeSchema.parse({
      id,
      workflowId: workflow.id,
      kind: 'model',
      name: 'Raw model',
      position: { x: 0, y: 0 },
      config,
      ...derivePorts({ id, kind: 'model', config } as Parameters<typeof derivePorts>[0]),
    });
  }

  const catalog: Model[] = [
    {
      id: newId(),
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      displayName: 'Mock chat',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 200_000,
      supportsTools: false,
      supportsJson: true,
      available: true,
      source: 'discovered',
      lastCheckedAt: '2026-09-30T09:00:00.000Z',
      pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
    },
  ];

  async function chatWith(node: Node): Promise<ChatMessage> {
    const repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.nodes.insert(scope, node);
    const bus = makeBus(repository, now);
    const service = makeChatService(repository, bus.bus, {
      workflowId: workflow.id,
      now,
      modelsFor: async () => catalog,
    });

    const begun = await service.chat(node.id, { content: [{ type: 'text', text: 'hello' }] });
    return begun.done;
  }

  it('a model node with a system prompt prices the reply from the catalog', async () => {
    const reply = await chatWith(modelNode({ systemPrompt: 'You are terse.' }));
    // The catalog row matched, so the reply is priced (a non-zero cost from the mock usage).
    expect(reply.usage?.costUsd ?? 0).toBeGreaterThan(0);
    expect(reply.role).toBe('agent');
  });

  it('a model node without a system prompt still replies (falls back to an empty system)', async () => {
    const reply = await chatWith(modelNode({ timeoutMs: 30_000 }));
    const text = reply.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text.length).toBeGreaterThan(0);
  });
});

/**
 * `listMessages` and the postMessage no-input-node path — small branches the existing suite skips.
 */
describe('chat service — timeline reads and the no-input-node path', () => {
  const now = makeClock();
  const projectId = newId();

  it('listMessages 404s an unknown workflow and pages a known one', async () => {
    const repository = new FakeRepository();
    const workflow = makeWorkflow(projectId);
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    const bus = makeBus(repository, now);
    const service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now });

    await expect(service.listMessages(newId() as Id, { limit: 10 })).rejects.toThrow();

    const page = await service.listMessages(workflow.id, { limit: 10 });
    expect(page.items).toEqual([]);
  });

  it('listMessages returns a nextCursor when there are more rows than the limit', async () => {
    const repository = new FakeRepository();
    const workflow = makeWorkflow(projectId);
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    const bus = makeBus(repository, now);
    const service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now });

    for (let i = 0; i < 3; i += 1) {
      await repository.messages.append(scope, {
        id: newId(),
        workflowId: workflow.id,
        type: 'event',
        content: [{ type: 'text', text: `row ${i}` }],
        at: `2026-09-30T10:00:0${i}.000Z`,
      });
    }

    const firstPage = await service.listMessages(workflow.id, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await service.listMessages(workflow.id, {
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('deleteThread 404s a thread that does not exist', async () => {
    const repository = new FakeRepository();
    const workflow = makeWorkflow(projectId);
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    const bus = makeBus(repository, now);
    const service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now });

    await expect(service.deleteThread(newId() as Id)).rejects.toThrow();
  });

  it('postMessage with no Input node stores the user row and bumps no version', async () => {
    const repository = new FakeRepository();
    const workflow = makeWorkflow(projectId);
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    const bus = makeBus(repository, now);
    const service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now });

    const before = (await repository.workflows.get(scope, workflow.id))!.version;
    const result = await service.postMessage(workflow.id, {
      content: [{ type: 'text', text: 'just a note' }],
      run: false,
    });

    expect(result.message.type).toBe('user');
    expect(result.run).toBeUndefined();
    // No Input node → no version bump (BR-01 only fires when an Input node changed).
    expect((await repository.workflows.get(scope, workflow.id))!.version).toBe(before);
  });
});
