import {
  ArtifactSchema,
  ChatMessageSchema,
  ChatThreadSchema,
  McpServerSchema,
  MessageSchema,
  ToolCallSchema,
  type Artifact,
  type ChatMessage,
  type ChatThread,
  type Id,
  type McpServer,
  type McpServerStatus,
  type McpTransport,
  type Message,
  type MessageQuery,
  type MessageType,
  type Page,
  type ToolCall,
  type ToolCallStatus,
} from '@ace/contracts';
import type {
  ArtifactRepository,
  ChatMessageRepository,
  ChatThreadRepository,
  McpServerPatch,
  McpServerRepository,
  MessageRepository,
  Scope,
  ToolCallRepository,
} from '@ace/engine';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { InTransaction } from './repository-guardrails.js';
import type * as schema from './schema.js';
import {
  artifacts,
  chatMessages,
  chatThreads,
  kbDocuments,
  mcpServers,
  messages,
  nodeRuns,
  nodes,
  toolCalls,
} from './schema.js';
import { toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The round 4 repositories (Arch §15.3): artifacts, tool calls, MCP servers, timeline messages and
 * direct chat.
 *
 * Split out of `repository.ts` so one file stays one round's worth of tables; `SqliteRepository`
 * composes them. Every JSON column goes through `toJsonColumn`, so BR-07 is enforced by the storage
 * layer — an artifact reference in a message, or a redacted tool-call arg, cannot smuggle a key
 * into a table.
 */

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type ArtifactRow = typeof artifacts.$inferSelect;
type ToolCallRow = typeof toolCalls.$inferSelect;
type McpServerRow = typeof mcpServers.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type ChatThreadRow = typeof chatThreads.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;

function toArtifact(row: ArtifactRow): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    hash: row.hash,
    mime: row.mime,
    name: row.name,
    size: row.size,
    createdAt: row.createdAt,
    ...(row.lastReferencedAt === null ? {} : { lastReferencedAt: row.lastReferencedAt }),
  });
}

function toToolCall(row: ToolCallRow): ToolCall {
  return ToolCallSchema.parse({
    id: row.id,
    nodeRunId: row.nodeRunId,
    toolName: row.toolName,
    args: JSON.parse(row.args),
    resultSummary: row.resultSummary,
    durationMs: row.durationMs,
    status: row.status as ToolCallStatus,
    verdicts: JSON.parse(row.verdicts),
    at: row.at,
  });
}

function toMcpServer(row: McpServerRow): McpServer {
  return McpServerSchema.parse({
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    ...(row.command === null ? {} : { command: row.command }),
    ...(row.args === null ? {} : { args: JSON.parse(row.args) }),
    ...(row.url === null ? {} : { url: row.url }),
    status: row.status as McpServerStatus,
    toolCount: row.toolCount,
    ...(row.lastCheckedAt === null ? {} : { lastCheckedAt: row.lastCheckedAt }),
    ...(row.error === null ? {} : { error: row.error }),
  });
}

function toMessage(row: MessageRow): Message {
  return MessageSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.nodeId === null ? {} : { nodeId: row.nodeId }),
    ...(row.nodeRunId === null ? {} : { nodeRunId: row.nodeRunId }),
    type: row.type as MessageType,
    content: JSON.parse(row.content),
    at: row.at,
  });
}

function toChatThread(row: ChatThreadRow): ChatThread {
  return ChatThreadSchema.parse({
    id: row.id,
    nodeId: row.nodeId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return ChatMessageSchema.parse({
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: JSON.parse(row.content),
    verdicts: JSON.parse(row.verdicts),
    ...(row.usage === null ? {} : { usage: JSON.parse(row.usage) }),
    at: row.at,
  });
}

/** The default page size when a `MessageQuery` names no limit. */
const DEFAULT_MESSAGE_LIMIT = 100;

/* -------------------------------------------------------------------------- */
/* Artifacts (FR-MM-001..004, Arch §15.4)                                      */
/* -------------------------------------------------------------------------- */

export function createArtifactRepository(db: Db): ArtifactRepository {
  return {
    create: async (scope: Scope, artifact: Artifact) => {
      db.insert(artifacts)
        .values({
          id: artifact.id,
          workspaceId: scope.workspaceId,
          hash: artifact.hash,
          mime: artifact.mime,
          name: artifact.name,
          size: artifact.size,
          createdAt: artifact.createdAt,
          lastReferencedAt: artifact.lastReferencedAt ?? null,
        })
        .run();
      return artifact;
    },

    getById: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.workspaceId, scope.workspaceId), eq(artifacts.id, id)))
        .get();
      return row === undefined ? null : toArtifact(row);
    },

    getByHash: async (scope: Scope, hash: string) => {
      const row = db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.workspaceId, scope.workspaceId), eq(artifacts.hash, hash)))
        .get();
      return row === undefined ? null : toArtifact(row);
    },

    list: async (scope: Scope, page) => {
      // Newest first: ids are monotonic ULIDs, so "newer" is "greater id" and the cursor is the
      // last id of the previous page.
      const rows = db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, scope.workspaceId),
            page.cursor === undefined ? undefined : lt(artifacts.id, page.cursor),
          ),
        )
        .orderBy(desc(artifacts.id))
        .limit(page.limit + 1)
        .all();

      const items = rows.slice(0, page.limit).map(toArtifact);
      const nextCursor = rows.length > page.limit ? items.at(-1)?.id : undefined;
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },

    touch: async (scope: Scope, id: Id, at) => {
      db.update(artifacts)
        .set({ lastReferencedAt: at })
        .where(and(eq(artifacts.workspaceId, scope.workspaceId), eq(artifacts.id, id)))
        .run();
      const row = db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.workspaceId, scope.workspaceId), eq(artifacts.id, id)))
        .get();
      return row === undefined ? null : toArtifact(row);
    },

    /**
     * Arch §15.4's sweep candidates, in one query: the reference time is before `before` and no
     * live row points at the id. "Points at" is a substring match on the quoted id — the same shape
     * as `nodes.listByProvider` — across every place a `Part` reference or an Input `artifactIds`
     * entry is stored. A ULID is high-entropy enough that a false match is not a real risk, and a
     * kept-alive artifact costs nothing; the danger the query guards against is deleting bytes that
     * are still referenced, which the `NOT EXISTS` clauses prevent. A knowledge-base document names
     * its source artifact in a column of its own, so that clause is an exact match: a reindex
     * reads the file again, however old it is (round 5, FR-RAG-009, final-review C1).
     */
    unreferencedBefore: async (scope: Scope, before) =>
      db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, scope.workspaceId),
            sql`COALESCE(${artifacts.lastReferencedAt}, ${artifacts.createdAt}) < ${before}`,
            sql`NOT EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.workspaceId} = ${artifacts.workspaceId} AND ${nodes.config} LIKE '%"' || ${artifacts.id} || '"%')`,
            sql`NOT EXISTS (SELECT 1 FROM ${nodeRuns} WHERE ${nodeRuns.workspaceId} = ${artifacts.workspaceId} AND (COALESCE(${nodeRuns.output}, '') LIKE '%"' || ${artifacts.id} || '"%' OR ${nodeRuns.inputEnvelopes} LIKE '%"' || ${artifacts.id} || '"%'))`,
            sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.workspaceId} = ${artifacts.workspaceId} AND ${messages.content} LIKE '%"' || ${artifacts.id} || '"%')`,
            sql`NOT EXISTS (SELECT 1 FROM ${chatMessages} WHERE ${chatMessages.workspaceId} = ${artifacts.workspaceId} AND ${chatMessages.content} LIKE '%"' || ${artifacts.id} || '"%')`,
            sql`NOT EXISTS (SELECT 1 FROM ${kbDocuments} WHERE ${kbDocuments.workspaceId} = ${artifacts.workspaceId} AND ${kbDocuments.artifactId} = ${artifacts.id})`,
          ),
        )
        .orderBy(asc(artifacts.id))
        .all()
        .map(toArtifact),

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(artifacts)
        .where(and(eq(artifacts.workspaceId, scope.workspaceId), eq(artifacts.id, id)))
        .run().changes > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Tool calls (FR-TOOL-009)                                                    */
/* -------------------------------------------------------------------------- */

export function createToolCallRepository(db: Db, inTransaction: InTransaction): ToolCallRepository {
  const mirrorOntoNodeRun = (scope: Scope, call: ToolCall): void => {
    const row = db
      .select({ toolCalls: nodeRuns.toolCalls })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, call.nodeRunId)))
      .get();
    if (row === undefined) return;

    const list = [...(JSON.parse(row.toolCalls) as unknown[]), call];
    db.update(nodeRuns)
      .set({ toolCalls: toJsonColumn(list, `nodeRun(${call.nodeRunId}).toolCalls`) })
      .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, call.nodeRunId)))
      .run();
  };

  return {
    append: async (scope: Scope, runId: Id, call: ToolCall) =>
      inTransaction(async () => {
        const at = `toolCall(${call.id})`;
        db.insert(toolCalls)
          .values({
            id: call.id,
            workspaceId: scope.workspaceId,
            runId,
            nodeRunId: call.nodeRunId,
            toolName: call.toolName,
            // Args are redacted by the data guardrail before they get here (FR-TOOL-009); the guard
            // refuses anything key-shaped that slipped through (BR-07).
            args: toJsonColumn(call.args, `${at}.args`),
            resultSummary: call.resultSummary,
            durationMs: call.durationMs,
            status: call.status,
            verdicts: toJsonColumn(call.verdicts, `${at}.verdicts`),
            at: call.at,
          })
          .run();

        mirrorOntoNodeRun(scope, call);
        return call;
      }),

    listByNodeRun: async (scope: Scope, nodeRunId: Id) =>
      db
        .select()
        .from(toolCalls)
        .where(
          and(eq(toolCalls.workspaceId, scope.workspaceId), eq(toolCalls.nodeRunId, nodeRunId)),
        )
        .orderBy(asc(toolCalls.id))
        .all()
        .map(toToolCall),

    listByRun: async (scope: Scope, runId: Id) =>
      db
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.workspaceId, scope.workspaceId), eq(toolCalls.runId, runId)))
        .orderBy(asc(toolCalls.id))
        .all()
        .map(toToolCall),
  };
}

/* -------------------------------------------------------------------------- */
/* MCP servers (FR-TOOL-007, D16)                                              */
/* -------------------------------------------------------------------------- */

export function createMcpServerRepository(db: Db): McpServerRepository {
  const read = (scope: Scope, id: Id): McpServer | null => {
    const row = db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, scope.workspaceId), eq(mcpServers.id, id)))
      .get();
    return row === undefined ? null : toMcpServer(row);
  };

  return {
    create: async (scope: Scope, server: McpServer) => {
      db.insert(mcpServers)
        .values({
          id: server.id,
          workspaceId: scope.workspaceId,
          name: server.name,
          transport: server.transport,
          command: server.command ?? null,
          args:
            server.args === undefined
              ? null
              : toJsonColumn(server.args, `mcpServer(${server.id}).args`),
          url: server.url ?? null,
          status: server.status,
          toolCount: server.toolCount,
          lastCheckedAt: server.lastCheckedAt ?? null,
          error: server.error ?? null,
        })
        .run();
      return server;
    },

    get: async (scope: Scope, id: Id) => read(scope, id),

    list: async (scope: Scope) =>
      db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.workspaceId, scope.workspaceId))
        .orderBy(asc(mcpServers.id))
        .all()
        .map(toMcpServer),

    updateStatus: async (scope: Scope, id: Id, patch: McpServerPatch) => {
      const values = {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.toolCount === undefined ? {} : { toolCount: patch.toolCount }),
        ...(patch.lastCheckedAt === undefined ? {} : { lastCheckedAt: patch.lastCheckedAt }),
        // `null` clears the error on a reconnect, `undefined` leaves it alone (D72's convention).
        ...(patch.error === undefined ? {} : { error: patch.error }),
      };
      if (Object.keys(values).length > 0) {
        db.update(mcpServers)
          .set(values)
          .where(and(eq(mcpServers.workspaceId, scope.workspaceId), eq(mcpServers.id, id)))
          .run();
      }
      return read(scope, id);
    },

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(mcpServers)
        .where(and(eq(mcpServers.workspaceId, scope.workspaceId), eq(mcpServers.id, id)))
        .run().changes > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Timeline messages (FR-CHAT-001..003)                                        */
/* -------------------------------------------------------------------------- */

export function createMessageRepository(db: Db): MessageRepository {
  return {
    append: async (scope: Scope, message: Message) => {
      const at = `message(${message.id})`;
      db.insert(messages)
        .values({
          id: message.id,
          workspaceId: scope.workspaceId,
          workflowId: message.workflowId,
          runId: message.runId ?? null,
          nodeId: message.nodeId ?? null,
          nodeRunId: message.nodeRunId ?? null,
          type: message.type,
          content: toJsonColumn(message.content, `${at}.content`),
          at: message.at,
        })
        .run();
      return message;
    },

    /**
     * The filters combine (FR-CHAT-002). `runId` and `nodeId` are columns and go into the WHERE;
     * `type` is a set, so `inArray` covers a repeated `?type=` as readily as one value, matching
     * how `MessageQuerySchema` reads a single value as a list of one. Ordered oldest first so a
     * reconnect replaying from a cursor sees the identical list.
     */
    query: async (scope: Scope, workflowId: Id, query: MessageQuery): Promise<Page<Message>> => {
      const limit = query.limit ?? DEFAULT_MESSAGE_LIMIT;
      const rows = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, scope.workspaceId),
            eq(messages.workflowId, workflowId),
            query.runId === undefined ? undefined : eq(messages.runId, query.runId),
            query.nodeId === undefined ? undefined : eq(messages.nodeId, query.nodeId),
            query.type === undefined || query.type.length === 0
              ? undefined
              : inArray(messages.type, query.type),
            query.cursor === undefined ? undefined : gt(messages.id, query.cursor),
          ),
        )
        .orderBy(asc(messages.id))
        .limit(limit + 1)
        .all();

      const items = rows.slice(0, limit).map(toMessage);
      const nextCursor = rows.length > limit ? items.at(-1)?.id : undefined;
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Direct chat (FR-CHAT-004..008)                                              */
/* -------------------------------------------------------------------------- */

export function createChatThreadRepository(
  db: Db,
  inTransaction: InTransaction,
): ChatThreadRepository {
  const read = (scope: Scope, id: Id): ChatThread | null => {
    const row = db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.workspaceId, scope.workspaceId), eq(chatThreads.id, id)))
      .get();
    return row === undefined ? null : toChatThread(row);
  };

  return {
    create: async (scope: Scope, thread: ChatThread) => {
      db.insert(chatThreads)
        .values({
          id: thread.id,
          workspaceId: scope.workspaceId,
          nodeId: thread.nodeId,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        })
        .run();
      return thread;
    },

    get: async (scope: Scope, id: Id) => read(scope, id),

    listByNode: async (scope: Scope, nodeId: Id) =>
      db
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.workspaceId, scope.workspaceId), eq(chatThreads.nodeId, nodeId)))
        .orderBy(asc(chatThreads.id))
        .all()
        .map(toChatThread),

    touch: async (scope: Scope, id: Id, updatedAt) => {
      db.update(chatThreads)
        .set({ updatedAt })
        .where(and(eq(chatThreads.workspaceId, scope.workspaceId), eq(chatThreads.id, id)))
        .run();
      return read(scope, id);
    },

    /** The thread and its messages go together, in one transaction (Arch §15.4: until deleted). */
    delete: async (scope: Scope, id: Id) =>
      inTransaction(async () => {
        const result = db
          .delete(chatThreads)
          .where(and(eq(chatThreads.workspaceId, scope.workspaceId), eq(chatThreads.id, id)))
          .run();
        if (result.changes === 0) return false;

        db.delete(chatMessages)
          .where(
            and(eq(chatMessages.workspaceId, scope.workspaceId), eq(chatMessages.threadId, id)),
          )
          .run();
        return true;
      }),
  };
}

export function createChatMessageRepository(db: Db): ChatMessageRepository {
  return {
    append: async (scope: Scope, message: ChatMessage) => {
      const at = `chatMessage(${message.id})`;
      db.insert(chatMessages)
        .values({
          id: message.id,
          workspaceId: scope.workspaceId,
          threadId: message.threadId,
          role: message.role,
          content: toJsonColumn(message.content, `${at}.content`),
          verdicts: toJsonColumn(message.verdicts, `${at}.verdicts`),
          usage: message.usage === undefined ? null : toJsonColumn(message.usage, `${at}.usage`),
          at: message.at,
        })
        .run();
      return message;
    },

    listByThread: async (scope: Scope, threadId: Id) =>
      db
        .select()
        .from(chatMessages)
        .where(
          and(eq(chatMessages.workspaceId, scope.workspaceId), eq(chatMessages.threadId, threadId)),
        )
        .orderBy(asc(chatMessages.id))
        .all()
        .map(toChatMessage),
  };
}
