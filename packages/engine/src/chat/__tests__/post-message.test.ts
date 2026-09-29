import type { Id, Part, Run, StartRunRequest } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import type { EngineEvent } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { ChatRunNotAvailableError, ChatWorkflowNotFoundError } from '../errors.js';
import type { ChatService } from '../service.js';
import {
  makeBus,
  makeChatService,
  makeClock,
  makeProject,
  makeRun,
  makeSimpleNode,
  makeWorkflow,
  scope,
} from './harness.js';

/**
 * Posting a message into the workflow (FR-CHAT-003): it is stored as a `user` row and set as the
 * Input node's pending text, and with `run: true` it starts a run with that text.
 */
describe('TC-CHAT-003 post a message into the workflow', () => {
  let repository: FakeRepository;
  let events: EngineEvent[];
  let service: ChatService;
  let startedWith: { workflowId: Id; request: StartRunRequest }[];
  const now = makeClock();

  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const input = makeSimpleNode(workflow.id, 'input');

  beforeEach(async () => {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.nodes.insert(scope, input);

    const bus = makeBus(repository, now);
    events = bus.events;
    startedWith = [];

    const startRun = async (workflowId: Id, request: StartRunRequest): Promise<Run> => {
      startedWith.push({ workflowId, request });
      return makeRun(newId(), workflowId, projectId, []);
    };

    service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now, startRun });
  });

  const hello: Part[] = [{ type: 'text', text: 'hello' }];

  it('stores a user message and sets the Input node text, and starts a run when asked', async () => {
    const result = await service.postMessage(workflow.id, { content: hello, run: true });

    // Stored as a user message on the run it started.
    expect(result.message.type).toBe('user');
    expect(result.run).toBeDefined();
    expect(result.message.runId).toBe(result.run?.id);

    // The Input node now carries the text (FR-CHAT-003).
    const stored = (await repository.nodes.listByWorkflow(scope, workflow.id)).find((n) => n.id === input.id);
    expect(stored?.kind).toBe('input');
    if (stored?.kind === 'input') expect(stored.config.text).toBe('hello');

    // The run was started with the message as the Input node's input.
    expect(startedWith).toHaveLength(1);
    expect(startedWith[0]?.request.inputs?.[input.id]).toEqual(hello);
  });

  it('emits message.created and workflow.updated', async () => {
    await service.postMessage(workflow.id, { content: hello, run: false });
    expect(events.some((e) => e.type === 'message.created')).toBe(true);
    expect(events.some((e) => e.type === 'workflow.updated')).toBe(true);
  });

  it('does not start a run when run is false, and the message carries no runId', async () => {
    const result = await service.postMessage(workflow.id, { content: hello, run: false });
    expect(result.run).toBeUndefined();
    expect(result.message.runId).toBeUndefined();
    expect(startedWith).toHaveLength(0);
  });

  it('404s on an unknown workflow', async () => {
    await expect(service.postMessage(newId(), { content: hello, run: false })).rejects.toBeInstanceOf(
      ChatWorkflowNotFoundError,
    );
  });

  it('refuses run:true when no run starter is wired', async () => {
    const bare = makeChatService(repository, makeBus(repository, now).bus, { workflowId: workflow.id, now });
    await expect(bare.postMessage(workflow.id, { content: hello, run: true })).rejects.toBeInstanceOf(
      ChatRunNotAvailableError,
    );
  });

  it('carries a posted attachment onto the Input node as an artifact reference', async () => {
    const image: Part = { type: 'image', artifactId: newId(), mime: 'image/png', name: 'p.png', size: 10 };
    await service.postMessage(workflow.id, { content: [{ type: 'text', text: 'see' }, image], run: false });
    const stored = (await repository.nodes.listByWorkflow(scope, workflow.id)).find((n) => n.id === input.id);
    if (stored?.kind === 'input') expect(stored.config.artifactIds).toEqual([image.artifactId]);
  });
});
