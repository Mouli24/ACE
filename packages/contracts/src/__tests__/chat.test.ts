import { describe, expect, it } from 'vitest';

import {
  CHAT_ROLES,
  ChatMessageSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ChatThreadDetailSchema,
  ChatThreadSchema,
  MESSAGE_TYPES,
  MessageListResponseSchema,
  MessageQuerySchema,
  MessageSchema,
  MessageTypeSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  blockedChatReply,
  messageMatchesQuery,
  type Message,
} from '../chat.js';
import {
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  GuardrailBlockedDetailsSchema,
} from '../errors.js';
import { ChatVerdictSchema } from '../guardrails.js';
import {
  CHAT_MESSAGE_ID,
  MESSAGE_ID,
  NODE_A,
  NODE_B,
  NODE_RUN_ID,
  NOW,
  RUN_ID,
  THREAD_ID,
  VERDICT_ID,
  WORKFLOW_ID,
} from './fixtures.js';

const text = [{ type: 'text', text: 'Summarise the brief.' }];

const message = {
  id: MESSAGE_ID,
  workflowId: WORKFLOW_ID,
  runId: RUN_ID,
  nodeId: NODE_A,
  nodeRunId: NODE_RUN_ID,
  type: 'agent',
  content: text,
  at: NOW,
};

const thread = {
  id: THREAD_ID,
  nodeId: NODE_A,
  title: 'Summarise the brief',
  createdAt: NOW,
  updatedAt: NOW,
};

const chatVerdict = {
  id: VERDICT_ID,
  point: 'input',
  checkType: 'prompt_injection',
  action: 'block',
  passed: false,
  reason: 'The message asks the agent to ignore its instructions.',
  at: NOW,
};

const chatMessage = {
  id: CHAT_MESSAGE_ID,
  threadId: THREAD_ID,
  role: 'agent',
  content: [{ type: 'text', text: 'You said: hello' }],
  verdicts: [],
  usage: { tokensIn: 8, tokensOut: 4, costUsd: 0, priceTableVersion: 'mock-v1' },
  at: NOW,
};

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-001 MessageType (round 4 §2.3)', () => {
  it('declares exactly the six literals §2.3 names, in its order (round 4 §3)', () => {
    expect([...MESSAGE_TYPES]).toEqual(['user', 'agent', 'output', 'event', 'error', 'system']);
  });

  it.each([...MESSAGE_TYPES])('parses a %s message', (type) => {
    expect(MessageSchema.safeParse({ ...message, type }).success).toBe(true);
  });

  it.each(['assistant', 'tool', 'info', 'User', ''])('refuses the type %s', (type) => {
    expect(MessageTypeSchema.safeParse(type).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, type }).success).toBe(false);
  });
});

describe('FR-CHAT-001 Message', () => {
  it('is exactly the shape §2.3 writes', () => {
    expect(MessageSchema.parse(message)).toEqual(message);
  });

  it('belongs to a workflow always, and to a run and a node when there is one', () => {
    const bare = { id: MESSAGE_ID, workflowId: WORKFLOW_ID, type: 'user', content: text, at: NOW };

    expect(MessageSchema.parse(bare)).toEqual(bare);
    expect(MessageSchema.safeParse({ ...bare, workflowId: undefined }).success).toBe(false);
  });

  it('holds its content as Parts, never as a string (BR-02)', () => {
    expect(MessageSchema.safeParse({ ...message, content: 'just text' }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, text: 'just text' }).success).toBe(false);
  });

  it.each(['messages', 'history', 'conversation'])('refuses a `%s` key (BR-02)', (key) => {
    expect(MessageSchema.safeParse({ ...message, [key]: [] }).success).toBe(false);
  });
});

describe('FR-CHAT-002 MessageQuery filters combine', () => {
  const rows: Message[] = [
    MessageSchema.parse(message),
    MessageSchema.parse({ ...message, id: MESSAGE_ID, type: 'error', nodeId: NODE_B }),
    MessageSchema.parse({
      id: MESSAGE_ID,
      workflowId: WORKFLOW_ID,
      type: 'user',
      content: text,
      at: NOW,
    }),
  ];

  it('reads every filter §2.4 names', () => {
    const query = {
      runId: RUN_ID,
      nodeId: NODE_A,
      type: ['agent', 'error'],
      cursor: 'abc',
      limit: 10,
    };

    expect(MessageQuerySchema.parse(query)).toEqual(query);
    expect(MessageQuerySchema.parse({})).toEqual({});
  });

  it('reads a single type as a list of one, the way a query string sends it', () => {
    expect(MessageQuerySchema.parse({ type: 'error' }).type).toEqual(['error']);
    expect(MessageQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('refuses a type it does not know and a limit of zero', () => {
    expect(MessageQuerySchema.safeParse({ type: 'assistant' }).success).toBe(false);
    expect(MessageQuerySchema.safeParse({ type: ['user', 'assistant'] }).success).toBe(false);
    expect(MessageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('narrows by run, node and type together', () => {
    expect(rows.filter((row) => messageMatchesQuery(row, { type: ['error'] }))).toHaveLength(1);
    expect(rows.filter((row) => messageMatchesQuery(row, { nodeId: NODE_A }))).toHaveLength(1);
    expect(rows.filter((row) => messageMatchesQuery(row, { runId: RUN_ID }))).toHaveLength(2);
    expect(
      rows.filter((row) => messageMatchesQuery(row, { runId: RUN_ID, type: ['agent', 'error'] })),
    ).toHaveLength(2);
    expect(
      rows.filter((row) => messageMatchesQuery(row, { runId: RUN_ID, nodeId: NODE_B })),
    ).toHaveLength(1);
    expect(rows.filter((row) => messageMatchesQuery(row, {}))).toHaveLength(3);
  });
});

describe('FR-CHAT-003 POST /workflows/:id/messages', () => {
  it('stores the content and may start a run with it', () => {
    const body = { content: text, run: true };

    expect(PostMessageRequestSchema.parse(body)).toEqual(body);
    expect(PostMessageRequestSchema.safeParse({ content: text }).success, 'run is stated').toBe(
      false,
    );
  });

  it('refuses an empty message', () => {
    expect(PostMessageRequestSchema.safeParse({ content: [], run: false }).success).toBe(false);
  });

  it('answers { message, run? } — the whole run, as the Start button gets (D65)', () => {
    const parsed = PostMessageResponseSchema.parse({ message });

    expect(parsed.run).toBeUndefined();
    expect(
      PostMessageResponseSchema.safeParse({ message, run: { id: RUN_ID } }).success,
      'a partial run is not a Run',
    ).toBe(false);
  });

  it('answers the list as { items } with a cursor (§2.4, D64)', () => {
    expect(MessageListResponseSchema.parse({ items: [message] })).toEqual({ items: [message] });
    expect(MessageListResponseSchema.parse({ items: [], nextCursor: 'x' }).nextCursor).toBe('x');
  });
});

/* -------------------------------------------------------------------------- */
/* Direct chat                                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-004 FR-CHAT-005 chat threads are separate from runs', () => {
  it('is exactly the shape §2.3 writes', () => {
    expect(ChatThreadSchema.parse(thread)).toEqual(thread);
    expect(ChatMessageSchema.parse(chatMessage)).toEqual(chatMessage);
  });

  it('has two roles, and no node run to belong to', () => {
    expect([...CHAT_ROLES]).toEqual(['user', 'agent']);
    expect(ChatMessageSchema.safeParse({ ...chatMessage, role: 'system' }).success).toBe(false);
    for (const key of ['nodeRunId', 'iteration']) {
      expect(
        ChatMessageSchema.safeParse({ ...chatMessage, [key]: RUN_ID }).success,
        `${key} would tie a chat to a node run (FR-CHAT-005)`,
      ).toBe(false);
    }
    expect(ChatThreadSchema.safeParse({ ...thread, runId: RUN_ID }).success).toBe(false);
  });

  it('D285: a turn a run wrote into its node’s session names the run, and only by id', () => {
    expect(ChatMessageSchema.parse({ ...chatMessage, runId: RUN_ID }).runId).toBe(RUN_ID);
    expect(ChatMessageSchema.safeParse({ ...chatMessage, runId: 'not-a-ulid' }).success).toBe(false);
  });

  it('D285: a failed reply carries its error, and the model that answered is named', () => {
    const failed = {
      ...chatMessage,
      error: { kind: 'auth', code: 'cli_not_signed_in', message: 'Not signed in.', retryable: false },
      modelId: 'claude-opus-5-5',
    };
    expect(ChatMessageSchema.parse(failed)).toMatchObject({
      error: { code: 'cli_not_signed_in' },
      modelId: 'claude-opus-5-5',
    });
    expect(
      ChatMessageSchema.safeParse({ ...chatMessage, error: { kind: 'nonsense', code: 'x', message: '', retryable: false } })
        .success,
    ).toBe(false);
  });

  it('carries usage on a reply and none on a user turn', () => {
    const { usage: _usage, ...userTurn } = chatMessage;

    expect(ChatMessageSchema.parse({ ...userTurn, role: 'user' }).usage).toBeUndefined();
  });

  it('answers GET /chat/threads/:id as { thread, messages } (§2.4)', () => {
    const body = { thread, messages: [chatMessage] };

    expect(ChatThreadDetailSchema.parse(body)).toEqual(body);
  });
});

describe('FR-CHAT-006 POST /nodes/:id/chat streams its reply', () => {
  it('takes content and, to continue a thread, its id', () => {
    expect(ChatRequestSchema.parse({ content: text })).toEqual({ content: text });
    expect(ChatRequestSchema.parse({ threadId: THREAD_ID, content: text }).threadId).toBe(
      THREAD_ID,
    );
    expect(ChatRequestSchema.safeParse({ content: [] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ content: text, nodeId: NODE_A }).success).toBe(false);
  });

  it('answers 202 with the thread and the stored user turn', () => {
    const body = { threadId: THREAD_ID, messageId: CHAT_MESSAGE_ID };

    expect(ChatResponseSchema.parse(body)).toEqual(body);
    expect(ChatResponseSchema.safeParse({ threadId: THREAD_ID }).success).toBe(false);
  });
});

describe('FR-CHAT-008 the agent policy applies to a direct chat', () => {
  it('refuses a blocked input with 422 guardrail_blocked and the verdicts', () => {
    expect(ERROR_CODES).toContain('guardrail_blocked');
    expect(ERROR_CODE_HTTP_STATUS.guardrail_blocked).toBe(422);

    const details = { verdicts: [chatVerdict] };
    expect(GuardrailBlockedDetailsSchema.parse(details)).toEqual(details);
  });

  it('carries verdicts that name no node run (FR-CHAT-005) and no redacted value (FR-GRD-014)', () => {
    expect(ChatVerdictSchema.parse(chatVerdict)).toEqual(chatVerdict);
    expect(
      ChatVerdictSchema.safeParse({ ...chatVerdict, nodeRunId: NODE_RUN_ID }).success,
      'a chat verdict has no node run',
    ).toBe(false);
    expect(
      ChatVerdictSchema.safeParse({ ...chatVerdict, value: 'ada@example.com' }).success,
    ).toBe(false);
    expect(
      GuardrailBlockedDetailsSchema.safeParse({
        verdicts: [{ ...chatVerdict, nodeRunId: NODE_RUN_ID }],
      }).success,
    ).toBe(false);
  });

  it('says in the reply itself when the output point blocked it', () => {
    expect(blockedChatReply('secret leak')).toBe('[blocked by guardrail: secret leak]');

    const blocked = {
      ...chatMessage,
      content: [{ type: 'text', text: blockedChatReply('secret leak') }],
      verdicts: [{ ...chatVerdict, point: 'output', checkType: 'secret_leak' }],
    };
    expect(ChatMessageSchema.parse(blocked).verdicts).toHaveLength(1);
  });
});
