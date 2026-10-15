import { z } from 'zod';

import { closestHandles, parseAddressing, type RosterEntry } from './domain.js';
import { PartSchema } from './envelope.js';
import { IdSchema, TimestampSchema, type Id } from './graph.js';
import { ChatVerdictSchema } from './guardrails.js';
import { NodeErrorSchema, RunSchema, UsageSchema } from './runs.js';

/**
 * The timeline and direct chat (round 4 §2.3, FR-CHAT-001..008, Arch §12.2, §20.2).
 *
 * Two separate things live here. A `Message` is one row of the workflow's timeline — what the user
 * sent, what an agent answered, what an Output node produced, and the run's own events and errors.
 * A `ChatThread` is a conversation with one agent that uses its model, instructions, context policy
 * and tools but **never reads or writes `runs`/`node_runs`** (FR-CHAT-005), which is why its
 * messages are a different type with a different id space. D285 opens one door the other way: a
 * finished run of the node writes its goal and result into the node's session as two turns tagged
 * with the run's id, so the chat is where a node's results are read.
 *
 * Every body is strict, as round 3's are: content is `Part[]`, so a file in a message is an
 * artifact reference and never bytes (FR-MM-004, BR-02), and a stray key cannot turn a chat into
 * the raw conversation history BR-02 rules out of a handoff.
 */

/* -------------------------------------------------------------------------- */
/* Timeline messages (§2.3, FR-CHAT-001..003)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The six styles the timeline distinguishes (FR-CHAT-001), in §2.3's order: what the user sent,
 * what an agent or model node answered, an Output node's final result, run lifecycle events, node
 * errors, and the engine's own notices (shutdown, crash recovery, provider status changes).
 */
export const MESSAGE_TYPES = ['user', 'agent', 'output', 'event', 'error', 'system'] as const;
export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageSchema = z.strictObject({
  id: IdSchema,
  workflowId: IdSchema,
  /** Absent on a message that belongs to no run — a user message posted before a run starts. */
  runId: IdSchema.optional(),
  nodeId: IdSchema.optional(),
  nodeRunId: IdSchema.optional(),
  type: MessageTypeSchema,
  content: z.array(PartSchema),
  at: TimestampSchema,
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * `GET /workflows/:id/messages?runId&nodeId&type&cursor&limit` (§2.4, FR-CHAT-002). Filters
 * combine. `type` arrives as a repeated query parameter, and a single value reads as a list of one,
 * the way `ModelQuery.available` reads a query string as readily as a body (D52's reasoning).
 */
export const MessageQuerySchema = z.object({
  runId: IdSchema.optional(),
  nodeId: IdSchema.optional(),
  type: z
    .union([z.array(MessageTypeSchema), MessageTypeSchema.transform((type) => [type])])
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export type MessageQuery = z.infer<typeof MessageQuerySchema>;

/** Does one timeline row satisfy a filter? Pure, so the engine and the Timeline tab agree (D52). */
export function messageMatchesQuery(message: Message, query: MessageQuery): boolean {
  if (query.runId !== undefined && message.runId !== query.runId) return false;
  if (query.nodeId !== undefined && message.nodeId !== query.nodeId) return false;
  if (query.type !== undefined && !query.type.includes(message.type)) return false;
  return true;
}

/**
 * `POST /workflows/:id/messages` (FR-CHAT-003): the content is stored as a `user` message and set
 * as the Input node's pending text; with `run: true` a run starts with it.
 */
export const PostMessageRequestSchema = z.strictObject({
  content: z.array(PartSchema).min(1),
  run: z.boolean(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

/** `GET /workflows/:id/messages` → `{ items: Message[] }` (§2.4, D64). */
export const MessageListResponseSchema = z.strictObject({
  items: z.array(MessageSchema),
  nextCursor: z.string().optional(),
});
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

/**
 * `POST /workflows/:id/messages` → `{ message, run? }` (§2.4). `run` is the whole `Run`, exactly
 * what `POST /workflows/:id/runs` answers with, so a message that starts a run leaves the client
 * with the same thing the Start button does — pre-flight issues, `allowedActions` and all (D65).
 */
export const PostMessageResponseSchema = z.strictObject({
  message: MessageSchema,
  run: RunSchema.optional(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Direct chat (§2.3, FR-CHAT-004..008)                                        */
/* -------------------------------------------------------------------------- */

/**
 * A conversation with one agent. `GET /nodes/:id/chat/threads` answers a bare `ChatThread[]`, as
 * §2.4 writes it and as `GET /runs/:id/approvals` does (D78).
 */
export const ChatThreadSchema = z.strictObject({
  id: IdSchema,
  /** The agent this thread talks to; its model, instructions and tools are the ones used. */
  nodeId: IdSchema,
  title: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

export const CHAT_ROLES = ['user', 'agent'] as const;
export const ChatRoleSchema = z.enum(CHAT_ROLES);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * D302: what an agent did in the project during one chat turn — a CLI's own `activity` or an API
 * model's project tool call. Only the tool, the path and a short summary: never a file's contents
 * (design §7), which is why the summary is capped and the object is strict.
 */
export const ACTIVITY_KINDS = ['read', 'write', 'edit', 'command', 'search', 'other'] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export const ACTIVITY_SUMMARY_MAX = 200;

export const ActivityItemSchema = z.strictObject({
  kind: ActivityKindSchema,
  tool: z.string().min(1),
  /** Project-relative where it could be made so. */
  path: z.string().min(1).optional(),
  summary: z.string().max(ACTIVITY_SUMMARY_MAX),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

/**
 * One turn of a direct chat. `verdicts` are `ChatVerdict`s — the same verdicts, without a
 * `nodeRunId`, because the thread touches no node run (FR-CHAT-005). A reply the output point
 * blocked arrives as content `[blocked by guardrail: <reason>]` with the verdicts that say why
 * (FR-CHAT-008).
 */
export const ChatMessageSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  role: ChatRoleSchema,
  content: z.array(PartSchema),
  verdicts: z.array(ChatVerdictSchema),
  /** What the reply cost; a user turn has none. */
  usage: UsageSchema.optional(),
  at: TimestampSchema,
  /**
   * Set on the two turns a workflow run writes into its node's session: the goal the node was
   * run with, and what it produced (or why it failed). A direct-chat turn has none.
   */
  runId: IdSchema.optional(),
  /**
   * Set on an agent turn that failed — the model call, the provider or the CLI did not answer. Its
   * content then says the same thing in words; the turn is never part of a later prompt.
   */
  error: NodeErrorSchema.optional(),
  /** The model that actually answered, as the provider reported it (an alias resolved). */
  modelId: z.string().min(1).optional(),
  /**
   * D302: the node that replied. The thread's `nodeId` stays the conversation's main node; an
   * `@handle` in the user turn brings another node of the workflow in, and its reply says so here.
   */
  speakerNodeId: IdSchema.optional(),
  /** D302: what the turn did in the project folder, in order. Absent when it did nothing. */
  activity: z.array(ActivityItemSchema).optional(),
  /** D302/D300: the checkpoint of the files this turn changed; absent when it changed none. */
  checkpointId: IdSchema.optional(),
  /**
   * PG-1.6 (D352): a retry or an edit replaced this turn. It stays in the thread, collapsed as an
   * earlier version, and is never part of a later prompt.
   */
  supersededAt: TimestampSchema.optional(),
  /**
   * PG-1.6 (D352): the person deleted this turn. `GET /chat/threads/:id` leaves it out; it stays in
   * the event log and is never part of a later prompt.
   */
  deletedAt: TimestampSchema.optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * `POST /nodes/:id/chat` (FR-CHAT-004, FR-CHAT-007). Without a `threadId` the engine opens a new
 * thread. Files attach as `Part` references, as everywhere else.
 */
export const ChatRequestSchema = z.strictObject({
  threadId: IdSchema.optional(),
  content: z.array(PartSchema).min(1),
  /**
   * D302: the node that answers this turn — an agent or model node of the same workflow, named by
   * an `@handle` in the message (`resolveChatTarget`). Absent: the thread's own node answers.
   */
  targetNodeId: IdSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** What `resolveChatTarget` decided: the node to send to, or why the message cannot go. */
export type ChatTarget =
  { targetNodeId: Id; error?: undefined } | { targetNodeId?: undefined; error: string };

/** Same length, so every offset `parseAddressing` reports still points into the original text. */
const blank = (span: string): string => span.replace(/[^\n]/g, ' ');

/** A fenced code block, to its closing fence or the end of the message. */
const FENCED_CODE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
/** An inline code span: a run of backticks, to the same run. */
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const AT_TOKEN = /@[A-Za-z0-9][A-Za-z0-9-]*/g;
const QUOTES = new Set(["'", '"', '`']);
const NOT_A_HANDLE_AFTER = new Set(['/', '(']);

/**
 * D302 fix B-M3: the message with everything chat never reads as an address blanked out — code
 * (fenced blocks and inline spans), an `@token` followed by `/` or `(` (a scoped package such as
 * `@types/node`, a decorator call such as `@Injectable()`) and an `@` straight after a quote
 * (`'@ace/contracts'`). Chat only: Domain's parser is not changed by it.
 */
function chatAddressText(text: string): string {
  let kept = text.replace(FENCED_CODE, blank).replace(CODE_SPAN, blank);
  for (const match of text.matchAll(AT_TOKEN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (QUOTES.has(text[start - 1] ?? '') || NOT_A_HANDLE_AFTER.has(text[end] ?? '')) {
      kept = `${kept.slice(0, start)}${blank(match[0])}${kept.slice(end)}`;
    }
  }
  return kept;
}

/**
 * D302: who a chat message is for. Domain's parser reads the text (D324), but chat honours only
 * its `@handle` spans: a plain name stays a word. No handle sends to the conversation's main node;
 * exactly one node sends to it; `@all` or two different nodes is an error, in Domain's words where
 * they fit, and nothing is sent. The mention stays in the message: it is part of what the person
 * said, and the prompt shows it.
 *
 * In a coding chat `@` is often just text (fix B-M3): code, scoped packages, decorators and quoted
 * `@`s are never addresses, and an `@word` that matches no node is plain text — except as the
 * message's first word, where it is most likely a typo of a real handle and is refused with the
 * nearest handles.
 */
export function resolveChatTarget(
  text: string,
  roster: readonly RosterEntry[],
  mainNodeId: Id,
): ChatTarget {
  const parsed = parseAddressing(chatAddressText(text), roster);
  const handleError = parsed.errors.find(
    (error) =>
      (error.code === 'unknown_handle' || error.code === 'no_brain') &&
      text.slice(0, error.span?.start ?? 0).trim() === '',
  );
  if (handleError !== undefined) {
    if (handleError.code === 'unknown_handle') {
      const near = handleError.suggestions ?? closestHandles(handleError.handle ?? '', roster);
      const hint = near.length === 0 ? '' : ` — did you mean ${near.join(' or ')}?`;
      return { error: `${handleError.message}${hint}` };
    }
    return { error: handleError.message };
  }
  if (parsed.all) {
    return { error: '@all is for team runs — in a chat, ask one node at a time' };
  }
  const targets: Id[] = [];
  for (const span of parsed.spans) {
    if (span.via !== 'handle' || span.nodeId === undefined) continue;
    if (!targets.includes(span.nodeId)) targets.push(span.nodeId);
  }
  const [only, ...others] = targets;
  if (only === undefined) return { targetNodeId: mainNodeId };
  if (others.length > 0) {
    return { error: 'a chat message goes to one node at a time — mention just one @handle' };
  }
  return { targetNodeId: only };
}

/**
 * `POST /nodes/:id/chat` → 202 `{ threadId, messageId }` (§2.3). The answer comes back over the
 * socket: `chat.token` deltas on the thread's subscription, ending with `chat.message`
 * (FR-CHAT-006). `messageId` is the stored **user** turn, which is what the client echoes while it
 * waits.
 */
export const ChatResponseSchema = z.strictObject({
  threadId: IdSchema,
  messageId: IdSchema,
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/**
 * PG-1.6 (D352), message actions. Each answers like `POST /nodes/:id/chat`: 202 with the new user
 * turn's `{ threadId, messageId }`, the reply following over the socket.
 *
 * - `POST /chat/threads/:id/messages/:messageId/retry` (no body): re-run the turn that produced an
 *   agent message, or a failed one. The old reply is marked `supersededAt`; a new turn is appended.
 * - `POST /chat/threads/:id/messages/:messageId/edit` (`ChatEditRequest`): a user message. It and
 *   every turn after it are marked `supersededAt`, and the edited text is sent as a new turn.
 * - `DELETE /chat/threads/:id/messages/:messageId` → 204: hides one message (`deletedAt`).
 * - `POST /chat/threads/:id/stop` → 200 `ChatStopResponse`: aborts the turn in flight, which is
 *   stored as a failed turn of kind `user_cancelled`.
 *
 * Every change to an existing row is announced by a `chat.update` frame on the thread.
 */
export const ChatEditRequestSchema = z.strictObject({
  content: z.array(PartSchema).min(1),
});
export type ChatEditRequest = z.infer<typeof ChatEditRequestSchema>;

export const ChatStopResponseSchema = z.strictObject({
  /** `false` when no turn was in flight. */
  stopped: z.boolean(),
});
export type ChatStopResponse = z.infer<typeof ChatStopResponseSchema>;

/** `GET /chat/threads/:id` → `{ thread, messages: ChatMessage[] }` (§2.4). */
export const ChatThreadDetailSchema = z.strictObject({
  thread: ChatThreadSchema,
  messages: z.array(ChatMessageSchema),
});
export type ChatThreadDetail = z.infer<typeof ChatThreadDetailSchema>;

/**
 * The content of a reply the output point blocked (§2.3, FR-CHAT-008). One text part, so the chat
 * panel needs no special case, and the verdicts on the message carry the detail.
 */
export const blockedChatReply = (reason: string): string => `[blocked by guardrail: ${reason}]`;
