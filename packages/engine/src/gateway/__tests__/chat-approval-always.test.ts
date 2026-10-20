import { ApiErrorSchema } from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { ChatService } from '../../chat/index.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth } from '../../ports/index.js';
import { createEngineApp } from '../index.js';

/**
 * D376: the decision body gained `always: true`, and the chat approval routes share it (PG-2.2).
 * A chat never asks about a command, so there is nothing to always-allow: 400 `validation_failed`,
 * and the chat is not asked to decide anything.
 */

const TOKEN = 'a'.repeat(64);
const auth: Auth = { verifyToken: async (_scope, token) => token === TOKEN };
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
const THREAD = '01JBXQ8Z9KQ4R7N2VWXYZ0THRD';
const REQUEST = '01JBXQ8Z9KQ4R7N2VWXYZ0REQS';

function app() {
  const repository = new FakeRepository();
  const decideApproval = vi.fn(async () => ({
    requestId: REQUEST,
    decision: 'approve',
    decidedAt: '2026-10-20T10:00:00.000Z',
  }));
  const built = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: 'test',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    chat: { decideApproval } as unknown as ChatService,
  });
  const post = (body: unknown) =>
    built.request(`/api/v1/chat/threads/${THREAD}/approvals/${REQUEST}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, decideApproval };
}

describe('D376 a chat approval has nothing to always-allow', () => {
  it('answers 400 validation_failed to always: true and decides nothing', async () => {
    const { post, decideApproval } = app();

    const response = await post({ always: true });

    expect(response.status).toBe(400);
    const { error } = ApiErrorSchema.parse(await response.json());
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe("This command can't be always-allowed.");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it('decides as before without it', async () => {
    const { post, decideApproval } = app();
    expect((await post({ note: 'fine' })).status).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith(THREAD, REQUEST, 'approve', 'fine');
  });
});
