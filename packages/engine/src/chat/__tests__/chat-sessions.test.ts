import type { ChatMessage, Part } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { AceNodeError } from '../../errors/index.js';
import { newId } from '../../ids.js';
import type { EngineEvent, ProviderAdapter, StreamChunk } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { ChatModelError } from '../errors.js';
import type { ChatService } from '../service.js';
import {
  makeAdapter,
  makeAgentNode,
  makeBus,
  makeChatService,
  makeClock,
  makeProject,
  makeRouter,
  makeWorkflow,
  scope,
} from './harness.js';

/**
 * A node's chat session: every reply — or the reason there is none — reaches the chat as a stored
 * turn the client is told about, and a workflow run of the node writes its goal and its result into
 * the same session, so the chat panel is the one place a node's conversation lives.
 */

const hi: Part[] = [{ type: 'text', text: 'hi there' }];

const textOf = (message: ChatMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('');

/** An adapter that streams a little text and then fails the way a CLI that is signed out does. */
function failingAdapter(): ProviderAdapter {
  return {
    ...makeAdapter(),
    async *generate(): AsyncIterable<StreamChunk> {
      yield { type: 'text', delta: 'partial ' };
      throw new AceNodeError({
        kind: 'auth',
        code: 'cli_not_signed_in',
        message: 'Claude Code is not signed in — run `claude auth login`.',
        retryable: false,
      });
    },
  };
}

describe('chat sessions: replies, failures and run turns reach the node chat', () => {
  let repository: FakeRepository;
  let events: EngineEvent[];
  let service: ChatService;
  const now = makeClock();

  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const agent = makeAgentNode(workflow.id, {
    instructions: 'Write a haiku about rain.',
  });
  const other = makeAgentNode(workflow.id, {
    name: 'Critic',
    instructions: 'Critique it.',
  });

  async function setup(overrides: Parameters<typeof makeChatService>[2] = {}): Promise<void> {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.nodes.insert(scope, agent);
    await repository.nodes.insert(scope, other);
    const bus = makeBus(repository, now);
    events = bus.events;
    service = makeChatService(repository, bus.bus, {
      workflowId: workflow.id,
      now,
      ...overrides,
    });
  }

  beforeEach(() => setup());

  const chatMessages = () =>
    events
      .filter((event) => event.type === 'chat.message')
      .map((event) => (event.payload as { message: ChatMessage }).message);

  it('refuses a node with no usable model before anything is stored (no silent 202)', async () => {
    await setup({
      router: makeRouter({
        refuse: {
          ok: false,
          code: 'missing_model',
          reason: '"Writer" has no provider and model chosen yet.',
        },
      }),
    });

    await expect(service.chat(agent.id, { content: hi })).rejects.toBeInstanceOf(ChatModelError);
    await expect(service.chat(agent.id, { content: hi })).rejects.toThrow(/no provider and model/);
    expect(await service.listThreads(agent.id)).toHaveLength(0);
    expect(chatMessages()).toHaveLength(0);
  });

  it('turns a failed model call into a stored agent turn with the error, and announces it', async () => {
    await setup({ adapterFor: async () => failingAdapter() });

    const begun = await service.chat(agent.id, { content: hi });
    const reply = await begun.done;

    expect(reply.role).toBe('agent');
    expect(reply.error).toMatchObject({
      kind: 'auth',
      code: 'cli_not_signed_in',
    });
    expect(textOf(reply)).toContain('not signed in');
    // the half-streamed text is not passed off as the answer
    expect(textOf(reply)).not.toContain('partial');

    const detail = await service.getThread(begun.threadId);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(detail.messages[1]?.error?.code).toBe('cli_not_signed_in');
    expect(chatMessages().map((m) => m.id)).toContain(reply.id);
  });

  it('never feeds a failed turn back to the model as if it had said it', async () => {
    let prompts: string[] = [];
    let fail = true;
    await setup({
      adapterFor: async () =>
        fail
          ? failingAdapter()
          : makeAdapter({
              reply: (prompt) => {
                prompts = [...prompts, prompt];
                return 'ok';
              },
            }),
    });

    const first = await service.chat(agent.id, { content: hi });
    await first.done;
    fail = false;
    const second = await service.chat(agent.id, {
      threadId: first.threadId,
      content: [{ type: 'text', text: 'try again' }],
    });
    await second.done;

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('hi there');
    expect(prompts[0]).toContain('try again');
    expect(prompts[0]).not.toContain('not signed in');
  });

  it('records the model the provider says actually answered', async () => {
    await setup({
      adapterFor: async () => ({
        ...makeAdapter(),
        async *generate(): AsyncIterable<StreamChunk> {
          yield { type: 'model', modelId: 'claude-opus-5-5' };
          yield { type: 'text', delta: 'hello' };
          yield { type: 'usage', tokensIn: 3, tokensOut: 1 };
          yield { type: 'finish', reason: 'stop' };
        },
      }),
    });

    const begun = await service.chat(agent.id, { content: hi });
    const reply = await begun.done;
    expect(reply.modelId).toBe('claude-opus-5-5');
    expect(textOf(reply)).toBe('hello');
  });

  it('D263: prices a reply with the cost the provider reported, as a run does', async () => {
    await setup({
      adapterFor: async () => ({
        ...makeAdapter(),
        async *generate(): AsyncIterable<StreamChunk> {
          yield { type: 'text', delta: 'hello' };
          yield { type: 'usage', tokensIn: 3, tokensOut: 1, costUsd: 0.0123 };
          yield { type: 'finish', reason: 'stop' };
        },
      }),
    });

    const begun = await service.chat(agent.id, { content: hi });
    const reply = await begun.done;
    expect(reply.usage).toMatchObject({ tokensIn: 3, tokensOut: 1, costUsd: 0.0123 });
  });

  describe('a run of the node writes into its session', () => {
    it('opens a session when the node has none: the goal, then the result, both tagged with the run', async () => {
      const runId = newId();
      const { threadId } = await service.recordRunTurn({
        nodeId: agent.id,
        runId,
        goal: [{ type: 'text', text: 'Write a haiku about rain.' }],
        output: [{ type: 'text', text: 'Soft rain on the roof' }],
        usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
        modelId: 'claude-opus-5-5',
      });

      const threads = await service.listThreads(agent.id);
      expect(threads.map((t) => t.id)).toEqual([threadId]);
      expect(threads[0]?.title).toBe('Write a haiku about rain.');

      const detail = await service.getThread(threadId);
      expect(detail.messages.map((m) => [m.role, textOf(m), m.runId])).toEqual([
        ['user', 'Write a haiku about rain.', runId],
        ['agent', 'Soft rain on the roof', runId],
      ]);
      expect(detail.messages[1]?.usage?.tokensOut).toBe(5);
      expect(detail.messages[1]?.modelId).toBe('claude-opus-5-5');
      expect(chatMessages().map((m) => m.threadId)).toEqual([threadId, threadId]);
    });

    it('continues the session the node was last talked to in, and never another node’s', async () => {
      const chatted = await service.chat(agent.id, { content: hi });
      await chatted.done;
      const elsewhere = await service.chat(other.id, { content: hi });
      await elsewhere.done;

      const { threadId } = await service.recordRunTurn({
        nodeId: agent.id,
        runId: newId(),
        goal: [{ type: 'text', text: 'Write a haiku about rain.' }],
        output: [{ type: 'text', text: 'Soft rain' }],
      });

      expect(threadId).toBe(chatted.threadId);
      expect((await service.listThreads(agent.id)).length).toBe(1);
      const otherDetail = await service.getThread(elsewhere.threadId);
      expect(otherDetail.messages.every((m) => m.runId === undefined)).toBe(true);
    });

    it('records a failed run as an error turn', async () => {
      const { threadId } = await service.recordRunTurn({
        nodeId: agent.id,
        runId: newId(),
        goal: [{ type: 'text', text: 'Write a haiku about rain.' }],
        error: {
          kind: 'invalid_config',
          code: 'model_unavailable',
          message: 'Claude Code cannot use the model "bogus".',
          retryable: false,
        },
      });

      const detail = await service.getThread(threadId);
      const last = detail.messages.at(-1);
      expect(last?.role).toBe('agent');
      expect(last?.error?.code).toBe('model_unavailable');
      expect(last === undefined ? '' : textOf(last)).toContain('cannot use the model');
    });

    it('lets a direct chat follow up on what the run produced', async () => {
      let prompt = '';
      await setup({
        adapterFor: async () =>
          makeAdapter({
            reply: (p) => {
              prompt = p;
              return 'Shorter: rain.';
            },
          }),
      });
      const { threadId } = await service.recordRunTurn({
        nodeId: agent.id,
        runId: newId(),
        goal: [{ type: 'text', text: 'Write a haiku about rain.' }],
        output: [{ type: 'text', text: 'Soft rain on the roof' }],
      });

      const begun = await service.chat(agent.id, {
        threadId,
        content: [{ type: 'text', text: 'make it shorter' }],
      });
      await begun.done;
      expect(prompt).toContain('Soft rain on the roof');
      expect(prompt).toContain('make it shorter');
    });
  });
});
