/**
 * PG-1.5 A failed message always shows (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red tests. Every accepted chat turn — `chat()` returned, so the gateway already answered
 * 202 — must end in exactly one stored agent message (a reply, or a failed turn carrying `error`)
 * and exactly one `chat.message` frame. Today a throw outside `generateReply`'s inner try (the
 * reverted-paths read before it, the final `store`) only reaches `done.catch`, which logs
 * (`chat/service.ts` ~823): nothing is stored, no frame goes out, the client shows "typing…".
 *
 * Startup: a turn left open by a crash or shutdown (a user message with no agent message after it)
 * is marked failed when the engine starts. The chat service has no such entry point yet; the test
 * names the one it expects, `recoverOpenTurns()`, as a proposal the fix may rename.
 */
import type { ChatMessage, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import type { CheckpointRecorder, EngineEvent } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { ChatService } from '../service.js';
import {
  makeAgentNode,
  makeBus,
  makeChatService,
  makeClock,
  makeProject,
  makeWorkflow,
  scope,
} from './harness.js';

const hi: Part[] = [{ type: 'text', text: 'hi there' }];

interface Setup {
  repository: FakeRepository;
  events: EngineEvent[];
  service: ChatService;
  agentId: string;
}

async function setup(
  overrides: Parameters<typeof makeChatService>[2] = {},
  repository: FakeRepository = new FakeRepository(),
): Promise<Setup> {
  const now = makeClock();
  const project = makeProject();
  const workflow = makeWorkflow(project.id);
  const agent = makeAgentNode(workflow.id);
  await repository.projects.create(scope, project);
  await repository.workflows.create(scope, workflow);
  await repository.nodes.insert(scope, agent);
  const bus = makeBus(repository, now);
  const service = makeChatService(repository, bus.bus, {
    workflowId: workflow.id,
    now,
    ...overrides,
  });
  return { repository, events: bus.events, service, agentId: agent.id };
}

/** Let `done` settle either way, then give its follow-ups a moment to land. */
async function settle(done: Promise<unknown>): Promise<void> {
  await done.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const agentTurns = (messages: ChatMessage[]) => messages.filter((m) => m.role === 'agent');
const chatMessageFrames = (events: EngineEvent[], threadId: string) =>
  events.filter(
    (event) =>
      event.type === 'chat.message' &&
      (event.payload as { threadId: string }).threadId === threadId,
  );

describe('PG-1.5 a throw after acceptance ends the turn as one stored failed message', () => {
  it('a throw before the model call (reading reverted paths) stores one failed turn and emits it', async () => {
    const checkpoints: CheckpointRecorder = {
      begin: async () => ({ id: 'cp', finish: async () => undefined }),
      takeRevertedPaths: () => {
        throw new Error('checkpoint notes unreadable');
      },
    };
    const s = await setup({ checkpoints });

      const begun = await s.service.chat(s.agentId, { content: hi });
      await settle(begun.done);

      const stored = agentTurns(
        await s.repository.chatMessages.listByThread(scope, begun.threadId),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.error).toBeDefined();
      expect(chatMessageFrames(s.events, begun.threadId)).toHaveLength(1);
    },
  );

  it('a throw while storing the reply stores one failed turn instead, and emits exactly one frame', async () => {
    const repository = new FakeRepository();
    const append = repository.chatMessages.append;
    let refused = false;
    // The first agent reply cannot be written; anything after it can (the store recovered).
    repository.chatMessages.append = async (sc, message) => {
      if (!refused && message.role === 'agent' && message.error === undefined) {
        refused = true;
        throw new Error('disk full');
      }
      return append(sc, message);
    };
    const s = await setup({}, repository);

      const begun = await s.service.chat(s.agentId, { content: hi });
      await settle(begun.done);

      const stored = agentTurns(await repository.chatMessages.listByThread(scope, begun.threadId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.error).toBeDefined();
      expect(chatMessageFrames(s.events, begun.threadId)).toHaveLength(1);
    },
  );

  it('control: a turn that answers stores one reply and emits one frame (passes today)', async () => {
    const s = await setup();
    const begun = await s.service.chat(s.agentId, { content: hi });
    await settle(begun.done);

    const stored = agentTurns(await s.repository.chatMessages.listByThread(scope, begun.threadId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.error).toBeUndefined();
    expect(chatMessageFrames(s.events, begun.threadId)).toHaveLength(1);
  });
});

describe('PG-1.5 open turns are marked failed on startup', () => {
  it('a user turn with no reply after it gets one failed agent turn when the engine starts', async () => {
    const s = await setup();
    const at = '2026-10-15T10:00:00.000Z';
    const threadId = newId();
    await s.repository.chatThreads.create(scope, {
      id: threadId,
      nodeId: s.agentId,
      title: 'left open',
      createdAt: at,
      updatedAt: at,
    });
    await s.repository.chatMessages.append(scope, {
      id: newId(),
      threadId,
      role: 'user',
      content: hi,
      verdicts: [],
      at,
    });

      // Proposed name (the fix may rename it): run once at engine start, like `recoverAfterCrash`.
      const recover = (s.service as unknown as Record<string, unknown>)['recoverOpenTurns'];
      expect(typeof recover).toBe('function');
      await (recover as () => Promise<unknown>).call(s.service);

      const stored = agentTurns(await s.repository.chatMessages.listByThread(scope, threadId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.error).toBeDefined();
    },
  );
});
