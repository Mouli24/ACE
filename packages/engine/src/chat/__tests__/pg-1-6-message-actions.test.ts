/**
 * PG-1.6 Message actions in chat (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red tests, over the real gateway (`createEngineApp`) and the real chat service, on a
 * scripted adapter that records every prompt it is sent. The contract the prompt names:
 *
 * - `POST /chat/threads/:id/messages/:messageId/retry` — re-runs the turn; the old one is kept,
 *   marked `superseded`.
 * - `POST /chat/threads/:id/messages/:messageId/edit { content }` — a user message: the messages
 *   after it are marked `superseded`, and the edited text goes as a new turn.
 * - `DELETE /chat/threads/:id/messages/:messageId` — hides one message; never sent to the model
 *   again.
 * - `POST /chat/threads/:id/stop` — aborts the turn in flight, stored as `user_cancelled`.
 *
 * None of the four routes exists today, so each answers 404; that is the failure these record.
 */
import type { ChatMessage, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEngineApp, type EngineApp } from '../../gateway/index.js';
import { createGraphService } from '../../graph/index.js';
import type { ModelInfo, ProviderAdapter, ProviderStatus, StreamChunk } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { AUTH, JSON_HEADERS, TOKEN } from '../../__tests__/graph-helpers.js';
import type { ChatService } from '../service.js';
import {
  makeAgentNode,
  makeBus,
  makeChatService,
  makeClock,
  makeProject,
  makeWorkflow,
  scope,
  silentLogger,
} from './harness.js';

const text = (value: string): Part[] => [{ type: 'text', text: value }];

interface World {
  app: EngineApp;
  service: ChatService;
  repository: FakeRepository;
  agentId: string;
  /** Every prompt the adapter was sent, system and prompt joined. */
  prompts: string[];
  /** Hold the next generate() open until this resolves or the call is aborted. */
  hold: { next?: Promise<void> };
}

async function world(): Promise<World> {
  const repository = new FakeRepository();
  const now = makeClock();
  const project = makeProject();
  const workflow = makeWorkflow(project.id);
  const agent = makeAgentNode(workflow.id);
  await repository.projects.create(scope, project);
  await repository.workflows.create(scope, workflow);
  await repository.nodes.insert(scope, agent);
  const { bus } = makeBus(repository, now);

  const prompts: string[] = [];
  const hold: { next?: Promise<void> } = {};
  let count = 0;
  const adapter: ProviderAdapter = {
    type: 'openai_compatible',
    check: async (): Promise<ProviderStatus> => ({ status: 'CONNECTED' }),
    listModels: async (): Promise<ModelInfo[]> => [],
    async *generate(request, signal): AsyncIterable<StreamChunk> {
      prompts.push(`${request.system ?? ''}\n${request.prompt}`);
      count += 1;
      const held = hold.next;
      hold.next = undefined;
      if (held !== undefined) {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
          void held.then(resolve);
        });
      }
      yield { type: 'text', delta: `REPLY-${count}` };
      yield { type: 'usage', tokensIn: 3, tokensOut: 2 };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const service = makeChatService(repository, bus, {
    workflowId: workflow.id,
    now,
    adapterFor: async () => adapter,
  });
  const app = createEngineApp({
    repository,
    auth: { verifyToken: async (_scope, token) => token === TOKEN },
    logger: silentLogger,
    scope,
    version: '0.1.0',
    graph: createGraphService({ repository, scope, logger: silentLogger }),
    selfOrigins: ['http://127.0.0.1:4747'],
    bus,
    chat: service,
  });
  return { app, service, repository, agentId: agent.id, prompts, hold };
}

const post = (app: EngineApp, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const del = (app: EngineApp, path: string) =>
  app.request(`/api/v1${path}`, { method: 'DELETE', headers: AUTH });

async function messagesOf(w: World, threadId: string): Promise<ChatMessage[]> {
  return (await w.service.getThread(threadId)).messages;
}

async function waitForAgentTurns(
  w: World,
  threadId: string,
  count: number,
): Promise<ChatMessage[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const messages = await messagesOf(w, threadId);
    if (messages.filter((m) => m.role === 'agent').length >= count) return messages;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} agent turns`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One answered turn: the thread, the user message and the agent reply. */
async function answered(w: World, words: string, threadId?: string) {
  const begun = await w.service.chat(w.agentId, {
    content: text(words),
    ...(threadId === undefined ? {} : { threadId }),
  });
  const reply = await begun.done;
  return { threadId: begun.threadId, userId: begun.messageId, reply };
}

const flag = (message: ChatMessage | undefined, key: string): unknown =>
  message === undefined ? undefined : (message as unknown as Record<string, unknown>)[key];

describe('PG-1.6 POST /chat/threads/:id/messages/:messageId/retry', () => {
  it.fails(
    're-runs the turn, appends a new reply and keeps the old one marked superseded',
    async () => {
      const w = await world();
      const { threadId, reply } = await answered(w, 'hello');

      const response = await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/retry`);
      expect(response.status).toBeLessThan(300);

      const messages = await waitForAgentTurns(w, threadId, 2);
      const old = messages.find((m) => m.id === reply.id);
      expect(flag(old, 'superseded')).toBe(true);
      expect(
        messages.filter((m) => m.role === 'agent' && flag(m, 'superseded') !== true),
      ).toHaveLength(1);
    },
  );
});

describe('PG-1.6 POST /chat/threads/:id/messages/:messageId/edit', () => {
  it.fails(
    'supersedes what followed the user message and sends the edited text as a new turn',
    async () => {
      const w = await world();
      const { threadId, userId, reply } = await answered(w, 'first-draft');

      const response = await post(w.app, `/chat/threads/${threadId}/messages/${userId}/edit`, {
        content: text('second-draft'),
      });
      expect(response.status).toBeLessThan(300);

      const messages = await waitForAgentTurns(w, threadId, 2);
      expect(
        flag(
          messages.find((m) => m.id === reply.id),
          'superseded',
        ),
      ).toBe(true);
      expect(w.prompts.at(-1)).toContain('second-draft');
    },
  );
});

describe('PG-1.6 DELETE /chat/threads/:id/messages/:messageId', () => {
  it.fails(
    'hides one message (the route answers, the thread no longer lists it as live)',
    async () => {
      const w = await world();
      const { threadId, userId } = await answered(w, 'hide me');

      const response = await del(w.app, `/chat/threads/${threadId}/messages/${userId}`);
      expect(response.status).toBeLessThan(300);

      const hidden = (await messagesOf(w, threadId)).find((m) => m.id === userId);
      // Kept in the log, but marked: either gone from the thread or flagged deleted.
      expect(hidden === undefined || flag(hidden, 'deleted') === true).toBe(true);
    },
  );
});

describe('PG-1.6 POST /chat/threads/:id/stop', () => {
  it.fails('aborts the turn in flight and stores it as user_cancelled', async () => {
    const w = await world();
    w.hold.next = new Promise<void>(() => undefined); // never answers by itself
    const begun = await w.service.chat(w.agentId, {
      content: text('long job'),
    });
    // The adapter has the call open.
    const deadline = Date.now() + 2_000;
    while (w.prompts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const response = await post(w.app, `/chat/threads/${begun.threadId}/stop`);
    expect(response.status).toBeLessThan(300);

    const settled = await Promise.race([
      begun.done,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
    ]);
    expect(settled?.error?.kind).toBe('user_cancelled');
  });
});

describe('PG-1.6 a superseded or deleted message never reaches the next prompt', () => {
  it.fails('a deleted user message is not in the next turn’s prompt', async () => {
    const w = await world();
    const first = await answered(w, 'alpha-secret-words');

    const response = await del(w.app, `/chat/threads/${first.threadId}/messages/${first.userId}`);
    expect(response.status).toBeLessThan(300);

    await answered(w, 'next question', first.threadId);
    expect(w.prompts.at(-1)).not.toContain('alpha-secret-words');
  });

  it.fails('a superseded reply (after an edit) is not in the next turn’s prompt', async () => {
    const w = await world();
    const first = await answered(w, 'first-draft');
    const oldReply = first.reply.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

    const response = await post(
      w.app,
      `/chat/threads/${first.threadId}/messages/${first.userId}/edit`,
      {
        content: text('second-draft'),
      },
    );
    expect(response.status).toBeLessThan(300);
    await waitForAgentTurns(w, first.threadId, 2);

    await answered(w, 'third question', first.threadId);
    const last = w.prompts.at(-1) ?? '';
    expect(last).not.toContain('first-draft');
    expect(last).not.toContain(oldReply);
  });

  it('control: without any action, the earlier turn is in the next prompt (passes today)', async () => {
    const w = await world();
    const first = await answered(w, 'alpha-secret-words');
    await answered(w, 'next question', first.threadId);
    expect(w.prompts.at(-1)).toContain('alpha-secret-words');
  });
});
