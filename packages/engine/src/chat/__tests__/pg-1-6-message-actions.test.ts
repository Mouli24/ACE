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
 * Phase 0 recorded each as a 404 (no route); they are green since PG-1.6 landed the routes.
 */
import type { ChatMessage, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEngineApp, type EngineApp } from '../../gateway/index.js';
import { createGraphService } from '../../graph/index.js';
import type {
  EngineEvent,
  ModelInfo,
  ProviderAdapter,
  ProviderStatus,
  StreamChunk,
} from '../../ports/index.js';
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
  /** Every event the bus emitted (persisted and transient). */
  events: EngineEvent[];
  /** Make the next generate() throw (a provider failure stored as a failed turn, D287). */
  fail: { next?: boolean };
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
  const { bus, events } = makeBus(repository, now);

  const prompts: string[] = [];
  const hold: { next?: Promise<void> } = {};
  const fail: { next?: boolean } = {};
  let count = 0;
  const adapter: ProviderAdapter = {
    type: 'openai_compatible',
    check: async (): Promise<ProviderStatus> => ({ status: 'CONNECTED' }),
    listModels: async (): Promise<ModelInfo[]> => [],
    async *generate(request, signal): AsyncIterable<StreamChunk> {
      prompts.push(`${request.system ?? ''}\n${request.prompt}`);
      count += 1;
      if (fail.next === true) {
        fail.next = false;
        throw Object.assign(new Error('upstream 500'), { status: 500 });
      }
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
  return {
    app,
    service,
    repository,
    agentId: agent.id,
    prompts,
    hold,
    events,
    fail,
  };
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

/**
 * The contract (D352, commit 3aadc6f) carries the flags as timestamps — `supersededAt` and
 * `deletedAt` — so a flag is set when its timestamp is.
 */
const flag = (message: ChatMessage | undefined, key: 'superseded' | 'deleted'): boolean =>
  message === undefined
    ? false
    : key === 'superseded'
      ? message.supersededAt !== undefined
      : message.deletedAt !== undefined;

describe('PG-1.6 POST /chat/threads/:id/messages/:messageId/retry', () => {
  it('re-runs the turn, appends a new reply and keeps the old one marked superseded', async () => {
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
  it('supersedes what followed the user message and sends the edited text as a new turn', async () => {
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
  it('hides one message (the route answers, the thread no longer lists it as live)', async () => {
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
  it('aborts the turn in flight and stores it as user_cancelled', async () => {
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
  it('a deleted user message is not in the next turn’s prompt', async () => {
    const w = await world();
    const first = await answered(w, 'alpha-secret-words');

    const response = await del(w.app, `/chat/threads/${first.threadId}/messages/${first.userId}`);
    expect(response.status).toBeLessThan(300);

    await answered(w, 'next question', first.threadId);
    expect(w.prompts.at(-1)).not.toContain('alpha-secret-words');
  });

  it('a superseded reply (after an edit) is not in the next turn’s prompt', async () => {
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

const updates = (w: World, threadId: string): ChatMessage[] =>
  w.events
    .filter(
      (event) =>
        event.type === 'chat.update' &&
        (event.payload as { threadId: string }).threadId === threadId,
    )
    .map((event) => (event.payload as { message: ChatMessage }).message);

describe('PG-1.6 every changed row is announced as chat.update [D352]', () => {
  it('retry announces the superseded reply; the route answers 202 with the question it re-asks', async () => {
    const w = await world();
    const { threadId, userId, reply } = await answered(w, 'hello');

    const response = await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/retry`);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ threadId, messageId: userId });
    await waitForAgentTurns(w, threadId, 2);

    const announced = updates(w, threadId);
    expect(announced.map((m) => m.id)).toEqual([reply.id]);
    expect(announced[0]?.supersededAt).toBeDefined();
  });

  it('edit announces the user message and the reply after it, and appends a new user turn', async () => {
    const w = await world();
    const { threadId, userId, reply } = await answered(w, 'first-draft');

    const response = await post(w.app, `/chat/threads/${threadId}/messages/${userId}/edit`, {
      content: text('second-draft'),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { messageId: string };
    expect(body.messageId).not.toBe(userId);
    const messages = await waitForAgentTurns(w, threadId, 2);

    expect(updates(w, threadId).map((m) => m.id)).toEqual([userId, reply.id]);
    const fresh = messages.find((m) => m.id === body.messageId);
    expect(fresh?.role).toBe('user');
    expect(fresh?.content).toEqual(text('second-draft'));
    expect(flag(fresh, 'superseded')).toBe(false);
  });

  it('DELETE answers 204, announces the deleted row, and GET leaves it out', async () => {
    const w = await world();
    const { threadId, userId } = await answered(w, 'hide me');

    const response = await del(w.app, `/chat/threads/${threadId}/messages/${userId}`);
    expect(response.status).toBe(204);
    expect(updates(w, threadId).map((m) => [m.id, m.deletedAt !== undefined])).toEqual([
      [userId, true],
    ]);

    const detail = await w.app.request(`/api/v1/chat/threads/${threadId}`, {
      headers: AUTH,
    });
    const listed = ((await detail.json()) as { messages: ChatMessage[] }).messages;
    expect(listed.map((m) => m.id)).not.toContain(userId);
    // Still kept in the store: deleting is hiding.
    const kept = await w.repository.chatMessages.listByThread(scope, threadId);
    expect(kept.find((m) => m.id === userId)?.deletedAt).toBeDefined();

    // A second delete is still deleted, and announces nothing new.
    expect((await del(w.app, `/chat/threads/${threadId}/messages/${userId}`)).status).toBe(204);
    expect(updates(w, threadId)).toHaveLength(1);
  });
});

describe('PG-1.6 message actions refuse what they cannot do', () => {
  it('404 for an unknown thread or message', async () => {
    const w = await world();
    const { threadId } = await answered(w, 'hello');
    const missing = '01JBXQ8Z9KQ4R7N2VWXYZ0NONE';
    expect((await post(w.app, `/chat/threads/${missing}/stop`)).status).toBe(404);
    expect((await post(w.app, `/chat/threads/${threadId}/messages/${missing}/retry`)).status).toBe(
      404,
    );
    expect((await del(w.app, `/chat/threads/${threadId}/messages/${missing}`)).status).toBe(404);
    expect(
      (
        await post(w.app, `/chat/threads/${threadId}/messages/${missing}/edit`, {
          content: text('x'),
        })
      ).status,
    ).toBe(404);
  });

  it('400 for an edit of an agent reply, a retry of a user turn, and a retry of a superseded one', async () => {
    const w = await world();
    const { threadId, userId, reply } = await answered(w, 'hello');
    expect(
      (
        await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/edit`, {
          content: text('x'),
        })
      ).status,
    ).toBe(400);
    expect((await post(w.app, `/chat/threads/${threadId}/messages/${userId}/retry`)).status).toBe(
      400,
    );
    expect((await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/retry`)).status).toBe(
      202,
    );
    await waitForAgentTurns(w, threadId, 2);
    expect((await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/retry`)).status).toBe(
      400,
    );
  });

  it('400 for an edit with no content (ChatEditRequest)', async () => {
    const w = await world();
    const { threadId, userId } = await answered(w, 'hello');
    const response = await post(w.app, `/chat/threads/${threadId}/messages/${userId}/edit`, {
      content: [],
    });
    expect(response.status).toBe(400);
  });

  it('stop with nothing in flight answers 200 { stopped: false }', async () => {
    const w = await world();
    const { threadId } = await answered(w, 'hello');
    const response = await post(w.app, `/chat/threads/${threadId}/stop`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: false });
  });
});

describe('PG-1.6 retry of a failed turn and the history a retry reads', () => {
  it('a failed turn (provider failure) is retried into an answer', async () => {
    const w = await world();
    w.fail.next = true;
    const { threadId, reply } = await answered(w, 'please');
    expect(reply.error).toBeDefined();

    const response = await post(w.app, `/chat/threads/${threadId}/messages/${reply.id}/retry`);
    expect(response.status).toBe(202);
    const messages = await waitForAgentTurns(w, threadId, 2);
    const live = messages.filter((m) => m.role === 'agent' && !flag(m, 'superseded'));
    expect(live).toHaveLength(1);
    expect(live[0]?.error).toBeUndefined();
    // The retried prompt still carries the question.
    expect(w.prompts.at(-1)).toContain('please');
  });

  it('a retried reply is not in the next turn’s prompt; the new one is', async () => {
    const w = await world();
    const first = await answered(w, 'question-one');
    const oldText = first.reply.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    await post(w.app, `/chat/threads/${first.threadId}/messages/${first.reply.id}/retry`);
    const messages = await waitForAgentTurns(w, first.threadId, 2);
    const newer = messages.find((m) => m.role === 'agent' && !flag(m, 'superseded'));
    const newText = newer?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';

    await answered(w, 'question-two', first.threadId);
    const last = w.prompts.at(-1) ?? '';
    expect(last).not.toContain(oldText);
    expect(last).toContain(newText);
  });
});

describe('PG-1.5 recoverOpenTurns closes only turns left open', () => {
  it('leaves an answered thread alone, even one whose reply was deleted', async () => {
    const w = await world();
    const { threadId, reply } = await answered(w, 'hello');
    await del(w.app, `/chat/threads/${threadId}/messages/${reply.id}`);
    expect(await w.service.recoverOpenTurns()).toBe(0);
  });

  it('closes a retry the engine died in the middle of (the old reply superseded, no new one)', async () => {
    const w = await world();
    const { threadId, reply } = await answered(w, 'hello');
    await w.repository.chatMessages.mark(scope, reply.id, {
      supersededAt: '2026-10-15T10:00:00.000Z',
    });
    expect(await w.service.recoverOpenTurns()).toBe(1);
    const messages = await messagesOf(w, threadId);
    const closed = messages.filter((m) => m.role === 'agent' && !flag(m, 'superseded'));
    expect(closed).toHaveLength(1);
    expect(closed[0]?.error?.code).toBe('crash');
    expect(closed[0]?.error?.message).toMatch(/shutdown or a crash/);
  });
});
