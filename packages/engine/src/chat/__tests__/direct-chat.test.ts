import type { Part } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { estimateTokens } from '../../envelopes/index.js';
import { newId } from '../../ids.js';
import type { EngineEvent } from '../../ports/index.js';
import { CONVERSATION_SECTION, UNTRUSTED_LABEL } from '../../prompts/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import {
  ChatModelError,
  ChatNodeNotFoundError,
  ChatThreadNodeMismatchError,
  ChatThreadNotFoundError,
  NotAnAgentNodeError,
} from '../errors.js';
import type { ChatService } from '../service.js';
import {
  makeAdapter,
  makeBus,
  makeAgentNode,
  makeChatService,
  makeClock,
  makeProject,
  makeRouter,
  makeRun,
  makeSimpleNode,
  makeWorkflow,
  scope,
} from './harness.js';

const hi: Part[] = [{ type: 'text', text: 'hi there' }];

describe('direct chat with an agent (FR-CHAT-004..007)', () => {
  let repository: FakeRepository;
  let events: EngineEvent[];
  let service: ChatService;
  const now = makeClock();

  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  const agent = makeAgentNode(workflow.id, { instructions: 'Be helpful.' });

  async function setup(overrides: Parameters<typeof makeChatService>[2] = {}): Promise<void> {
    repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.nodes.insert(scope, agent);
    const bus = makeBus(repository, now);
    events = bus.events;
    service = makeChatService(repository, bus.bus, { workflowId: workflow.id, now, ...overrides });
  }

  beforeEach(() => setup());

  it('TC-CHAT-006: streams chat.token frames before the chat.message that ends the turn', async () => {
    const begun = await service.chat(agent.id, { content: hi });
    const reply = await begun.done;

    const chatTokens = events.filter((e) => e.type === 'chat.token');
    const chatMessage = events.find((e) => e.type === 'chat.message');
    expect(chatTokens.length).toBeGreaterThan(0);
    expect(chatMessage).toBeDefined();

    const lastTokenIndex = events.map((e) => e.type).lastIndexOf('chat.token');
    const messageIndex = events.map((e) => e.type).indexOf('chat.message');
    expect(lastTokenIndex).toBeLessThan(messageIndex);

    // Every frame rides the thread and the final message is the reply.
    for (const token of chatTokens) {
      expect((token.payload as { threadId: string }).threadId).toBe(begun.threadId);
    }
    expect((chatMessage?.payload as { message: { id: string } }).message.id).toBe(reply.id);
    expect(reply.role).toBe('agent');
  });

  it('TC-CHAT-004: an agent told to answer in French replies in French', async () => {
    await setup({ adapterFor: async () => makeAdapter() });
    const frenchAgent = makeAgentNode(workflow.id, { instructions: 'Please answer in French.' });
    await repository.nodes.insert(scope, frenchAgent);

    const begun = await service.chat(frenchAgent.id, { content: hi });
    const reply = await begun.done;
    const text = reply.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain('Bonjour');
  });

  it('returns the stored user turn as messageId and opens a thread', async () => {
    const begun = await service.chat(agent.id, { content: hi });
    await begun.done;

    const threads = await service.listThreads(agent.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(begun.threadId);

    const detail = await service.getThread(begun.threadId);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(detail.messages[0]?.id).toBe(begun.messageId);
  });

  it('reuses a named thread and appends to it', async () => {
    const first = await service.chat(agent.id, { content: hi });
    await first.done;
    const second = await service.chat(agent.id, { threadId: first.threadId, content: [{ type: 'text', text: 'again' }] });
    await second.done;

    expect(second.threadId).toBe(first.threadId);
    const detail = await service.getThread(first.threadId);
    expect(detail.messages).toHaveLength(4); // user, agent, user, agent
    expect(await service.listThreads(agent.id)).toHaveLength(1);
  });

  it('TC-CHAT-007: an attachment reaches the stored turn as an artifact reference', async () => {
    const image: Part = {
      type: 'image',
      artifactId: newId(),
      mime: 'image/png',
      name: 'shot.png',
      size: 1234,
    };
    const begun = await service.chat(agent.id, { content: [{ type: 'text', text: 'describe' }, image] });
    await begun.done;

    const detail = await service.getThread(begun.threadId);
    const userTurn = detail.messages.find((m) => m.role === 'user');
    expect(userTurn?.content).toContainEqual(image);
  });

  it('TC-CHAT-005: chat never reads or writes runs or node runs', async () => {
    // A run and a node run exist before the chat; both must be byte-identical afterwards.
    const run = makeRun(newId(), workflow.id, projectId, [agent]);
    await repository.runs.create(scope, run);
    await repository.nodeRuns.create(scope, {
      id: newId(),
      runId: run.id,
      nodeId: agent.id,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      usage: { tokensIn: 9, tokensOut: 9, costUsd: 0.02 },
      verdicts: [],
      toolCalls: [],
    });

    const runsBefore = JSON.stringify(await repository.runs.get(scope, run.id));
    const nodeRunsBefore = JSON.stringify(await repository.nodeRuns.listByRun(scope, run.id));

    const begun = await service.chat(agent.id, { content: hi });
    await begun.done;

    expect(JSON.stringify(await repository.runs.get(scope, run.id))).toBe(runsBefore);
    expect(JSON.stringify(await repository.nodeRuns.listByRun(scope, run.id))).toBe(nodeRunsBefore);
  });

  it('404s on an unknown node and rejects a non-agent node', async () => {
    await expect(service.chat(newId(), { content: hi })).rejects.toBeInstanceOf(ChatNodeNotFoundError);

    const output = makeSimpleNode(workflow.id, 'output');
    await repository.nodes.insert(scope, output);
    await expect(service.chat(output.id, { content: hi })).rejects.toBeInstanceOf(NotAnAgentNodeError);
  });

  it('rejects a threadId of a node in another workflow, and one that does not exist', async () => {
    // D302: a thread of a node in the same workflow may be continued; another workflow's may not.
    const elsewhere = makeWorkflow(projectId);
    await setup({ workflowIds: [elsewhere.id] });
    await repository.workflows.create(scope, elsewhere);
    const other = makeAgentNode(elsewhere.id, { name: 'Other' });
    await repository.nodes.insert(scope, other);
    const foreign = await repository.chatThreads.create(scope, {
      id: newId(),
      nodeId: other.id,
      title: 'x',
      createdAt: '2026-09-30T09:00:00.000Z',
      updatedAt: '2026-09-30T09:00:00.000Z',
    });
    await expect(service.chat(agent.id, { threadId: foreign.id, content: hi })).rejects.toBeInstanceOf(
      ChatThreadNodeMismatchError,
    );

    await expect(service.chat(agent.id, { threadId: newId(), content: hi })).rejects.toBeInstanceOf(
      ChatThreadNotFoundError,
    );
  });

  it('refuses with ChatModelError up front when the router refuses a model — no thread is opened', async () => {
    await setup({
      router: makeRouter({ refuse: { ok: false, code: 'incompatible_model', reason: 'no model' } }),
    });
    await expect(service.chat(agent.id, { content: hi })).rejects.toBeInstanceOf(ChatModelError);
    expect(await service.listThreads(agent.id)).toHaveLength(0);
  });

  it('404s on an unknown thread and deletes a thread with its messages', async () => {
    await expect(service.getThread(newId())).rejects.toBeInstanceOf(ChatThreadNotFoundError);

    const begun = await service.chat(agent.id, { content: hi });
    await begun.done;
    await service.deleteThread(begun.threadId);

    expect(await service.listThreads(agent.id)).toHaveLength(0);
    await expect(service.getThread(begun.threadId)).rejects.toBeInstanceOf(ChatThreadNotFoundError);
  });
});

/*
 * D-079. Round 4 §4 item 5: a direct thread is assembled "with thread messages as `## Conversation`
 * inside the node's own bounded context … capped to contextPolicy.budgetTokens". The user's turn had
 * been sent as `## Input — UNTRUSTED CONTENT`, the prior turns as an untrusted context summary.
 */
describe('FR-CHAT-004 FR-CHAT-005 TC-CHAT-005 D-079 the prompt a direct chat sends', () => {
  const now = makeClock();
  const projectId = newId();
  const workflow = makeWorkflow(projectId);
  // The smallest budget a context policy allows (256 tokens, about a thousand characters).
  const budgetTokens = 256;
  const agent = makeAgentNode(workflow.id, { budgetTokens });

  /** The Conversation section of the prompt the model was sent, without its header. */
  function conversationOf(prompt: string): string {
    const start = prompt.indexOf(`${CONVERSATION_SECTION}\n`);
    const end = prompt.indexOf('\n## Input\n');
    return start === -1 || end === -1
      ? ''
      : prompt.slice(start + CONVERSATION_SECTION.length + 1, end).trim();
  }

  it('sends the thread under ## Conversation within the budget, and never touches runs or node runs', async () => {
    const repository = new FakeRepository();
    await repository.projects.create(scope, makeProject());
    await repository.workflows.create(scope, workflow);
    await repository.nodes.insert(scope, agent);
    const { bus } = makeBus(repository, now);

    const prompts: string[] = [];
    const service = makeChatService(repository, bus, {
      workflowId: workflow.id,
      now,
      adapterFor: async () =>
        makeAdapter({
          reply: (prompt) => {
            prompts.push(prompt);
            return `Reply ${prompts.length}: ${'the answer goes on '.repeat(10).trim()}`;
          },
        }),
    });

    // A run and a node run exist before the chat; both must be byte-identical afterwards (FR-CHAT-005).
    const run = makeRun(newId(), workflow.id, projectId, [agent]);
    await repository.runs.create(scope, run);
    await repository.nodeRuns.create(scope, {
      id: newId(),
      runId: run.id,
      nodeId: agent.id,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      usage: { tokensIn: 9, tokensOut: 9, costUsd: 0.02 },
      verdicts: [],
      toolCalls: [],
    });
    const runsBefore = JSON.stringify(
      await repository.runs.listByWorkflow(scope, workflow.id, { limit: 100 }),
    );
    const nodeRunsBefore = JSON.stringify(await repository.nodeRuns.listByRun(scope, run.id));

    // Six turns of about fifty tokens each, with replies as long: the thread outgrows the budget.
    const first = await service.chat(agent.id, {
      content: [{ type: 'text', text: 'The opening question.' }],
    });
    await first.done;
    for (let i = 2; i <= 5; i += 1) {
      const next = await service.chat(agent.id, {
        threadId: first.threadId,
        content: [
          { type: 'text', text: `Follow-up number ${i}: ${'more detail '.repeat(12).trim()}` },
        ],
      });
      await next.done;
    }
    const last = await service.chat(agent.id, {
      threadId: first.threadId,
      content: [{ type: 'text', text: 'And the newest question?' }],
    });
    await last.done;

    // The first turn's prompt: the user's words are the conversation, not untrusted input.
    expect(conversationOf(prompts[0]!)).toBe('User: The opening question.');
    expect(prompts[0]).not.toContain(UNTRUSTED_LABEL);

    // The last turn's prompt: roles labelled, the newest turn last, within the budget, oldest gone.
    const conversation = conversationOf(prompts.at(-1)!);
    expect(conversation.split('\n').at(-1)).toBe('User: And the newest question?');
    // D302: each assistant turn names its speaker, and the node answering sees its own.
    expect(conversation).toContain('Assistant (Writer, you): Reply 5: the answer goes on');
    expect(conversation).not.toContain('The opening question.');
    expect(estimateTokens(conversation)).toBeLessThanOrEqual(budgetTokens);
    expect(prompts.at(-1)).not.toContain(UNTRUSTED_LABEL);

    expect(
      JSON.stringify(await repository.runs.listByWorkflow(scope, workflow.id, { limit: 100 })),
    ).toBe(runsBefore);
    expect(JSON.stringify(await repository.nodeRuns.listByRun(scope, run.id))).toBe(nodeRunsBefore);
  });
});
