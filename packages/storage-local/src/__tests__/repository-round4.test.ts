import type {
  Artifact,
  ChatMessage,
  ChatThread,
  McpServer,
  Message,
  NodeRun,
  Part,
  ToolCall,
} from '@ace/contracts';
import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretWriteRejectedError } from '../secret-guard.js';
import { createTempDb, type TempDb } from './temp-db.js';
import { makeInputNode, scope } from './fixtures.js';

/**
 * The round 4 repositories (Arch §15.3): artifacts, tool calls, MCP servers, timeline messages and
 * direct chat. Every test runs against a real migrated SQLite file in a temp dir, so it exercises
 * the schema, the JSON columns and the secret guard exactly as the engine will.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const NOW = '2026-09-29T10:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const OTHER = { workspaceId: 'other' };

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: newId(),
    hash: HASH_A,
    mime: 'image/png',
    name: 'sample.png',
    size: 1234,
    createdAt: NOW,
    ...overrides,
  };
}

function filePart(artifactId: string): Part {
  return { type: 'file', artifactId, mime: 'application/zip', name: 'out.zip', size: 10 };
}

function toolCall(nodeRunId: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: newId(),
    nodeRunId,
    toolName: 'echo',
    args: { text: 'hello' },
    resultSummary: 'echo said: hello',
    durationMs: 12,
    status: 'ok',
    verdicts: [],
    at: NOW,
    ...overrides,
  };
}

function mcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: newId(),
    name: 'Test MCP',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    status: 'starting',
    toolCount: 0,
    ...overrides,
  };
}

function message(workflowId: string, overrides: Partial<Message> = {}): Message {
  return {
    id: newId(),
    workflowId,
    type: 'user',
    content: [{ type: 'text', text: 'hello' }],
    at: NOW,
    ...overrides,
  };
}

function chatThread(nodeId: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: newId(),
    nodeId,
    title: 'Thread 1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function chatMessage(threadId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: newId(),
    threadId,
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    verdicts: [],
    at: NOW,
    ...overrides,
  };
}

function nodeRun(runId: string, overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    id: newId(),
    runId,
    nodeId: newId(),
    iteration: 1,
    attempt: 1,
    status: 'RUNNING',
    inputEnvelopes: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    verdicts: [],
    toolCalls: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                   */
/* -------------------------------------------------------------------------- */

describe('FR-MM-002 artifacts repository', () => {
  it('round-trips an artifact through SQLite unchanged', async () => {
    const a = artifact({ lastReferencedAt: NOW });
    await db.repository.artifacts.create(scope, a);
    expect(await db.repository.artifacts.getById(scope, a.id)).toEqual(a);
  });

  it('finds an existing row by its content hash — the dedupe lookup', async () => {
    const a = artifact();
    await db.repository.artifacts.create(scope, a);
    expect(await db.repository.artifacts.getByHash(scope, HASH_A)).toEqual(a);
    expect(await db.repository.artifacts.getByHash(scope, HASH_B)).toBeNull();
  });

  it('refuses a second row for the same bytes (the unique hash constraint)', async () => {
    await db.repository.artifacts.create(scope, artifact({ hash: HASH_A }));
    await expect(
      db.repository.artifacts.create(scope, artifact({ hash: HASH_A })),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('keeps the same bytes distinct across workspaces (BR-18)', async () => {
    await db.repository.artifacts.create(scope, artifact({ hash: HASH_A }));
    // Same hash, different workspace: the unique index is per workspace, so this is allowed.
    await expect(
      db.repository.artifacts.create(OTHER, artifact({ hash: HASH_A })),
    ).resolves.toBeDefined();
    expect(await db.repository.artifacts.getByHash(scope, HASH_A)).not.toBeNull();
  });

  it('lists newest first and pages by cursor', async () => {
    const ids = [newId(), newId(), newId()].sort();
    for (const [n, id] of ids.entries()) {
      await db.repository.artifacts.create(scope, artifact({ id, hash: String(n).repeat(64) }));
    }

    const first = await db.repository.artifacts.list(scope, { limit: 2 });
    expect(first.items.map((a) => a.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).toBe(ids[1]);

    const next = await db.repository.artifacts.list(scope, { limit: 2, cursor: first.nextCursor });
    expect(next.items.map((a) => a.id)).toEqual([ids[0]]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('touch moves the lastReferencedAt clock', async () => {
    const a = artifact();
    await db.repository.artifacts.create(scope, a);
    const touched = await db.repository.artifacts.touch(scope, a.id, '2026-09-30T00:00:00.000Z');
    expect(touched?.lastReferencedAt).toBe('2026-09-30T00:00:00.000Z');
    expect(await db.repository.artifacts.touch(scope, newId(), NOW)).toBeNull();
  });

  it('deletes a row', async () => {
    const a = artifact();
    await db.repository.artifacts.create(scope, a);
    expect(await db.repository.artifacts.delete(scope, a.id)).toBe(true);
    expect(await db.repository.artifacts.delete(scope, a.id)).toBe(false);
    expect(await db.repository.artifacts.getById(scope, a.id)).toBeNull();
  });
});

describe('Arch §15.4 artifact retention query', () => {
  const OLD = '2026-09-01T00:00:00.000Z';
  const CUTOFF = '2026-09-20T00:00:00.000Z';
  const RECENT = '2026-09-28T00:00:00.000Z';

  it('returns only artifacts unreferenced and older than the cutoff', async () => {
    // Old and never referenced → swept.
    const orphan = artifact({ id: newId(), hash: HASH_A, createdAt: OLD });
    // Old, but touched recently → survives.
    const touchedRecently = artifact({ id: newId(), hash: HASH_B, createdAt: OLD });
    // Created after the cutoff → survives.
    const fresh = artifact({ id: newId(), hash: 'c'.repeat(64), createdAt: RECENT });
    for (const a of [orphan, touchedRecently, fresh]) await db.repository.artifacts.create(scope, a);
    await db.repository.artifacts.touch(scope, touchedRecently.id, RECENT);

    const swept = await db.repository.artifacts.unreferencedBefore(scope, CUTOFF);
    expect(swept.map((a) => a.id)).toEqual([orphan.id]);
  });

  it('spares an artifact still referenced by an Input node config, a node run, a message or a chat', async () => {
    const workflowId = newId();
    const runId = newId();
    const threadId = newId();

    const byNode = artifact({ id: newId(), hash: 'd'.repeat(64), createdAt: OLD });
    const byNodeRun = artifact({ id: newId(), hash: 'e'.repeat(64), createdAt: OLD });
    const byMessage = artifact({ id: newId(), hash: 'f'.repeat(64), createdAt: OLD });
    const byChat = artifact({ id: newId(), hash: '1'.repeat(64), createdAt: OLD });
    for (const a of [byNode, byNodeRun, byMessage, byChat]) {
      await db.repository.artifacts.create(scope, a);
    }

    // An Input node whose config lists the artifact.
    const input = makeInputNode(workflowId);
    await db.repository.nodes.insert(scope, {
      ...input,
      config: { artifactIds: [byNode.id], outputTypes: ['text'] },
    });
    // A node run whose output is a file Part referencing the artifact.
    await db.repository.nodeRuns.create(scope, nodeRun(runId, { output: [filePart(byNodeRun.id)] }));
    // A timeline message and a chat message with a file Part each.
    await db.repository.messages.append(
      scope,
      message(workflowId, { content: [filePart(byMessage.id)] }),
    );
    await db.repository.chatThreads.create(scope, chatThread(input.id, { id: threadId }));
    await db.repository.chatMessages.append(
      scope,
      chatMessage(threadId, { content: [filePart(byChat.id)] }),
    );

    const swept = await db.repository.artifacts.unreferencedBefore(scope, CUTOFF);
    expect(swept).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                  */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-009 tool_calls repository', () => {
  it('appends a call and mirrors it onto its node run in one write path', async () => {
    const runId = newId();
    const nr = nodeRun(runId);
    await db.repository.nodeRuns.create(scope, nr);

    const call = toolCall(nr.id);
    const returned = await db.repository.toolCalls.append(scope, runId, call);
    expect(returned).toEqual(call);

    // The denormalised copy the NodeRun contract carries is kept in step.
    const reread = await db.repository.nodeRuns.get(scope, nr.id);
    expect(reread?.toolCalls).toEqual([call]);
  });

  it('lists by node run and by run, oldest first', async () => {
    const runId = newId();
    const nr = nodeRun(runId);
    await db.repository.nodeRuns.create(scope, nr);

    const ids = [newId(), newId()].sort();
    for (const id of ids) await db.repository.toolCalls.append(scope, runId, toolCall(nr.id, { id }));

    expect((await db.repository.toolCalls.listByNodeRun(scope, nr.id)).map((c) => c.id)).toEqual(ids);
    expect((await db.repository.toolCalls.listByRun(scope, runId)).map((c) => c.id)).toEqual(ids);
    expect(await db.repository.toolCalls.listByRun(scope, newId())).toEqual([]);
  });

  it('refuses a call whose args still carry a secret (BR-07 backstop)', async () => {
    const runId = newId();
    const nr = nodeRun(runId);
    await db.repository.nodeRuns.create(scope, nr);

    await expect(
      db.repository.toolCalls.append(
        scope,
        runId,
        // The `apiKey` field name is a secret by definition (BR-07); any non-empty value is refused.
        toolCall(nr.id, { args: { apiKey: 'a-value-that-was-not-redacted' } }),
      ),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
  });
});

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-007 mcp_servers repository', () => {
  it('round-trips a stdio server and an http server', async () => {
    const stdio = mcpServer();
    const http = mcpServer({
      id: newId(),
      name: 'HTTP MCP',
      transport: 'http',
      command: undefined,
      args: undefined,
      url: 'https://mcp.example.com',
    });
    await db.repository.mcpServers.create(scope, stdio);
    await db.repository.mcpServers.create(scope, http);

    expect(await db.repository.mcpServers.get(scope, stdio.id)).toEqual(stdio);
    expect(await db.repository.mcpServers.get(scope, http.id)).toEqual(http);
    expect((await db.repository.mcpServers.list(scope)).map((s) => s.id).sort()).toEqual(
      [stdio.id, http.id].sort(),
    );
  });

  it('updates status, tool count and error, and clears the error on reconnect', async () => {
    const server = mcpServer();
    await db.repository.mcpServers.create(scope, server);

    const failed = await db.repository.mcpServers.updateStatus(scope, server.id, {
      status: 'unreachable',
      error: 'spawn ENOENT',
      lastCheckedAt: NOW,
    });
    expect(failed?.status).toBe('unreachable');
    expect(failed?.error).toBe('spawn ENOENT');

    const recovered = await db.repository.mcpServers.updateStatus(scope, server.id, {
      status: 'connected',
      toolCount: 2,
      error: null,
    });
    expect(recovered?.status).toBe('connected');
    expect(recovered?.toolCount).toBe(2);
    expect(recovered?.error).toBeUndefined();
  });

  it('deletes a server', async () => {
    const server = mcpServer();
    await db.repository.mcpServers.create(scope, server);
    expect(await db.repository.mcpServers.delete(scope, server.id)).toBe(true);
    expect(await db.repository.mcpServers.get(scope, server.id)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Timeline messages                                                           */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-001 messages repository', () => {
  it('appends and reads back a timeline row unchanged', async () => {
    const workflowId = newId();
    const m = message(workflowId, {
      runId: newId(),
      nodeId: newId(),
      nodeRunId: newId(),
      type: 'agent',
    });
    await db.repository.messages.append(scope, m);
    const { items } = await db.repository.messages.query(scope, workflowId, {});
    expect(items).toEqual([m]);
  });

  it('combines run, node and type filters (FR-CHAT-002)', async () => {
    const workflowId = newId();
    const runId = newId();
    const nodeId = newId();

    const target = message(workflowId, { id: newId(), runId, nodeId, type: 'error' });
    await db.repository.messages.append(scope, message(workflowId, { id: newId(), type: 'user' }));
    await db.repository.messages.append(scope, message(workflowId, { id: newId(), runId, type: 'event' }));
    await db.repository.messages.append(scope, target);

    const filtered = await db.repository.messages.query(scope, workflowId, {
      runId,
      nodeId,
      type: ['error'],
    });
    expect(filtered.items).toEqual([target]);
  });

  it('accepts a type list of more than one', async () => {
    const workflowId = newId();
    await db.repository.messages.append(scope, message(workflowId, { id: newId(), type: 'event' }));
    await db.repository.messages.append(scope, message(workflowId, { id: newId(), type: 'error' }));
    await db.repository.messages.append(scope, message(workflowId, { id: newId(), type: 'user' }));

    const filtered = await db.repository.messages.query(scope, workflowId, {
      type: ['event', 'error'],
    });
    expect(filtered.items.map((m) => m.type).sort()).toEqual(['error', 'event']);
  });

  it('pages oldest first by cursor', async () => {
    const workflowId = newId();
    const ids = [newId(), newId(), newId()].sort();
    for (const id of ids) await db.repository.messages.append(scope, message(workflowId, { id }));

    const first = await db.repository.messages.query(scope, workflowId, { limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual([ids[0], ids[1]]);
    expect(first.nextCursor).toBe(ids[1]);

    const next = await db.repository.messages.query(scope, workflowId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next.items.map((m) => m.id)).toEqual([ids[2]]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('refuses content that carries a secret (BR-07)', async () => {
    const workflowId = newId();
    await expect(
      db.repository.messages.append(
        scope,
        message(workflowId, {
          content: [{ type: 'json', value: { apiKey: 'a-value-that-leaked' } }],
        }),
      ),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
  });
});

/* -------------------------------------------------------------------------- */
/* Direct chat                                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-004 chat threads and messages repository', () => {
  it('creates a thread, lists it by node, and touches its updatedAt', async () => {
    const nodeId = newId();
    const thread = chatThread(nodeId);
    await db.repository.chatThreads.create(scope, thread);

    expect(await db.repository.chatThreads.get(scope, thread.id)).toEqual(thread);
    expect(await db.repository.chatThreads.listByNode(scope, nodeId)).toEqual([thread]);
    expect(await db.repository.chatThreads.listByNode(scope, newId())).toEqual([]);

    const touched = await db.repository.chatThreads.touch(scope, thread.id, '2026-09-30T00:00:00.000Z');
    expect(touched?.updatedAt).toBe('2026-09-30T00:00:00.000Z');
  });

  it('appends chat messages and reads them oldest first, usage optional', async () => {
    const thread = chatThread(newId());
    await db.repository.chatThreads.create(scope, thread);

    const userTurn = chatMessage(thread.id, { id: newId(), role: 'user' });
    const agentTurn = chatMessage(thread.id, {
      id: newId(),
      role: 'agent',
      content: [{ type: 'text', text: 'You said: hi' }],
      usage: { tokensIn: 3, tokensOut: 4, costUsd: 0 },
    });
    // Insert in id order so "oldest first" is deterministic.
    const [first, second] = [userTurn, agentTurn].sort((a, b) => a.id.localeCompare(b.id));
    await db.repository.chatMessages.append(scope, first!);
    await db.repository.chatMessages.append(scope, second!);

    const messages = await db.repository.chatMessages.listByThread(scope, thread.id);
    expect(messages).toEqual([first, second]);
    expect(messages.find((m) => m.role === 'user')?.usage).toBeUndefined();
  });

  it('deletes a thread and cascades its messages in one transaction', async () => {
    const thread = chatThread(newId());
    await db.repository.chatThreads.create(scope, thread);
    await db.repository.chatMessages.append(scope, chatMessage(thread.id));
    await db.repository.chatMessages.append(scope, chatMessage(thread.id));

    expect(await db.repository.chatThreads.delete(scope, thread.id)).toBe(true);
    expect(await db.repository.chatThreads.get(scope, thread.id)).toBeNull();
    expect(await db.repository.chatMessages.listByThread(scope, thread.id)).toEqual([]);
    expect(await db.repository.chatThreads.delete(scope, thread.id)).toBe(false);
  });
});
