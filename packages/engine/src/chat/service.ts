import {
  DEFAULT_CONTEXT_POLICY,
  blockedChatReply,
  type ChatMessage,
  type ChatRequest,
  type ChatThread,
  type ChatThreadDetail,
  type ChatVerdict,
  type Id,
  type Message,
  type MessageListResponse,
  type MessageQuery,
  type Model,
  type ModelUsed,
  type Node,
  type NodeError,
  type Part,
  type PostMessageRequest,
  type PostMessageResponse,
  type Run,
  type StartRunRequest,
  type Usage,
} from '@ace/contracts';

import { classifyError } from '../errors/index.js';
import { createBatcher } from '../events/batcher.js';
import { workflowUpdatedEvent, type EventBus } from '../events/index.js';
import type { CheckRunner, SecretMasker } from '../guardrails/checks.js';
import type { PolicyService } from '../guardrails/policy-service.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { ModelRouter, ProviderAdapter, Repository, Scope, StreamChunk } from '../ports/index.js';
import { usageFor } from '../runs/cost.js';
import { maskSecrets } from '../security/secret-patterns.js';
import {
  ChatInputBlockedError,
  ChatModelError,
  ChatNodeNotFoundError,
  ChatRunNotAvailableError,
  ChatThreadNodeMismatchError,
  ChatThreadNotFoundError,
  ChatWorkflowNotFoundError,
  NotAnAgentNodeError,
} from './errors.js';
import {
  evaluateChatInput,
  evaluateChatReply,
  type ChatGuardrailDeps,
} from './guardrails.js';
import { buildChatPrompt } from './prompt.js';

/**
 * The chat service (FR-CHAT-001..008, round 4 §2.3, Arch §12.2).
 *
 * Two jobs live here. The **timeline** is the workflow's shared log — `postMessage` writes the one
 * `user` row and the timeline populator (`./timeline.ts`) derives the rest from run events, so
 * `listMessages` reads a log that replays identically after a reconnect. **Direct chat** is a
 * conversation with one agent that uses its model, instructions, context policy and guardrails, and
 * **never reads or writes `runs`/`node_runs`** (FR-CHAT-005): its turns are `ChatMessage`s on a
 * `ChatThread`, its verdicts are `ChatVerdict`s, and its reply streams as `chat.token` before the
 * `chat.message` that ends it.
 */

/** A `agent` or `model` node — the only kinds with a direct chat. */
type ChatNode = Extract<Node, { kind: 'agent' | 'model' }>;

/** What `resolveNode` returns: the node and the project whose default policy guards it. */
export interface ResolvedChatNode {
  node: Node;
  projectId: Id;
}

/** What `POST /nodes/:id/chat` answers with — plus `done`, the reply the gateway logs but does not await. */
export interface ChatBegun {
  threadId: Id;
  /** The stored **user** turn, which the client echoes while the reply streams (§2.3). */
  messageId: Id;
  /**
   * Settles with the persisted agent turn: the reply, a blocked reply, or — when the model call
   * failed — a turn carrying the `error`, which the client has been sent as `chat.message` too. It
   * rejects only when not even that turn could be stored.
   */
  done: Promise<ChatMessage>;
}

/**
 * What one finished workflow run of a node writes into that node's chat session: the goal it was
 * run with and what it produced, or why it failed. The run service hands this over before it
 * announces the node's final state, so a client that hears the state can already read the turns.
 */
export interface NodeRunTurn {
  nodeId: Id;
  runId: Id;
  /** What the node was asked: its goal, or — with no goal of its own — what it was handed. */
  goal: Part[];
  output?: Part[];
  error?: NodeError;
  usage?: Usage;
  /** The model the provider reported actually answering (`ModelUsed.resolvedModelId`). */
  modelId?: string;
}

export interface ChatService {
  /** `POST /workflows/:id/messages` (FR-CHAT-003): store a `user` row, set the Input node, maybe run. */
  postMessage(workflowId: Id, request: PostMessageRequest): Promise<PostMessageResponse>;
  /** `GET /workflows/:id/messages` (FR-CHAT-002): the filtered timeline. */
  listMessages(workflowId: Id, query: MessageQuery): Promise<MessageListResponse>;
  /** `POST /nodes/:id/chat` (FR-CHAT-004..008): a direct chat turn; the reply streams over the socket. */
  chat(nodeId: Id, request: ChatRequest): Promise<ChatBegun>;
  /** `GET /nodes/:id/chat/threads` (§2.4). */
  listThreads(nodeId: Id): Promise<ChatThread[]>;
  /** `GET /chat/threads/:id` (§2.4). */
  getThread(threadId: Id): Promise<ChatThreadDetail>;
  /** `DELETE /chat/threads/:id` (§2.4): the thread and its messages, in one transaction. */
  deleteThread(threadId: Id): Promise<void>;
  /**
   * Write a finished run of the node into its session — the thread it was last talked to in, or a
   * new one — and announce both turns on the thread (see {@link NodeRunTurn}).
   */
  recordRunTurn(turn: NodeRunTurn): Promise<{ threadId: Id }>;
}

export interface ChatServiceDeps {
  scope: Scope;
  repository: Repository;
  bus: EventBus;
  logger: Logger;
  router: ModelRouter;
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  /** The catalog the chat reply is priced against (the same rows the run executor uses). */
  modelsFor: () => Promise<Model[]>;
  /** Runs the provider call inside that provider's concurrency gate (FR-PRV-009). */
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  /**
   * Resolves a node id to the node and its project. The `NodeRepository` port has no node-by-id
   * lookup, so the composition root supplies this (see the A4 report): a `POST /nodes/:id/chat`
   * knows only the node id, and a chat must reach the node's model, context policy and — through the
   * project — its default guardrail policy.
   */
  resolveNode: (nodeId: Id) => Promise<ResolvedChatNode | null>;
  /** Resolves the agent's guardrail policy (FR-GRD-002). Absent → a chat runs unchecked. */
  policies?: PolicyService;
  /** The pure checks and the data masker for chat guardrails (FR-CHAT-008). Absent → unchecked. */
  checks?: CheckRunner;
  masker?: SecretMasker;
  /** Starts a run for `postMessage({ run: true })` — the run service's `beginRun`, via the root. */
  startRun?: (workflowId: Id, request: StartRunRequest) => Promise<Run>;
  now?: () => string;
  nextId?: () => string;
  tokenBatchMs?: number;
}

/** Arch §24: stream frames are batched ~50 ms before they reach a client. */
const TOKEN_BATCH_MS = 50;

function titleFor(content: readonly Part[]): string {
  const firstText = content.find((part): part is Extract<Part, { type: 'text' }> => part.type === 'text');
  const raw = firstText?.text.trim() ?? '';
  if (raw === '') return 'New chat';
  return raw.length <= 60 ? raw : `${raw.slice(0, 59)}…`;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { scope, repository, bus, logger, router } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const batchMs = deps.tokenBatchMs ?? TOKEN_BATCH_MS;

  /** The guardrail dependency bundle, present only when both a runner and a masker were wired. */
  function guardrailDeps(): ChatGuardrailDeps | undefined {
    if (deps.checks === undefined || deps.masker === undefined) return undefined;
    return { checks: deps.checks, masker: deps.masker, now, nextId };
  }

  /** Store one turn, move its thread's `updatedAt`, and announce it on the thread (FR-CHAT-006). */
  async function store(message: ChatMessage): Promise<ChatMessage> {
    await repository.chatMessages.append(scope, message);
    await repository.chatThreads.touch(scope, message.threadId, now());
    await bus.emit({ type: 'chat.message', payload: { threadId: message.threadId, message } });
    return message;
  }

  /**
   * The agent turn that stands where a reply could not be produced: the error itself for the client
   * to style, and the same words as content so every renderer shows something. Only the kind, code
   * and message are kept — `details` can carry whatever the provider returned — and the message is
   * masked, because a provider's refusal can quote the key it refused (BR-07).
   */
  function failedTurn(
    threadId: Id,
    error: NodeError,
    extra: Pick<ChatMessage, 'runId' | 'usage'> = {},
  ): ChatMessage {
    const message = maskSecrets(error.message);
    return {
      id: nextId(),
      threadId,
      role: 'agent',
      content: [{ type: 'text', text: message }],
      verdicts: [],
      error: {
        kind: error.kind,
        code: error.code,
        message,
        retryable: error.retryable,
        ...(error.providerId === undefined ? {} : { providerId: error.providerId }),
      },
      at: now(),
      ...extra,
    };
  }

  /**
   * The model a chat with this node uses (FR-RTR-002), resolved before anything is stored: a node
   * with no model, a model that is gone or one that cannot answer in text is refused with the
   * router's own reason, as the 400 the client shows — never a 202 whose reply silently never comes.
   */
  function routeFor(node: ChatNode): ModelUsed {
    const routing =
      node.kind === 'agent'
        ? node.config.routing
        : { policy: 'fixed' as const, fallbackModelIds: [] as string[] };
    const route = router.resolve(
      {
        ...(node.config.providerId === undefined ? {} : { providerId: node.config.providerId }),
        ...(node.config.modelId === undefined ? {} : { modelId: node.config.modelId }),
        routing,
      },
      { inputTypes: node.config.inputTypes, outputTypes: ['text'] },
      { failures: [] },
    );
    if (!route.ok) throw new ChatModelError(route.code, route.reason);
    return route.route;
  }

  /**
   * Generate, guard and persist one reply (FR-CHAT-004, FR-CHAT-006, FR-CHAT-008). Never touches a
   * run: it calls the adapter directly, prices with `usageFor`, and writes only a `ChatMessage`. A
   * failed call is written too, as a turn carrying its `error`, so the client always hears how the
   * turn ended.
   */
  async function generateReply(context: {
    node: ChatNode;
    chosen: ModelUsed;
    policy: Awaited<ReturnType<PolicyService['resolve']>> | null;
    threadId: Id;
    history: readonly ChatMessage[];
    userParts: readonly Part[];
    guardrails: ChatGuardrailDeps | undefined;
  }): Promise<ChatMessage> {
    const { node, chosen, policy, threadId, history, userParts, guardrails } = context;

    const instructions =
      node.kind === 'agent' ? node.config.instructions : (node.config.systemPrompt ?? '');
    const budgetTokens =
      node.kind === 'agent' ? node.config.contextPolicy.budgetTokens : DEFAULT_CONTEXT_POLICY.budgetTokens;

    const prompt = buildChatPrompt({
      conversationId: nextId(),
      nodeId: node.id,
      instructions,
      inputTypes: node.config.inputTypes,
      budgetTokens,
      // A failed turn is the engine speaking, not the model: it is never replayed as its answer.
      history: history.filter((message) => message.error === undefined),
      userParts,
      now: now(),
    });

    const catalog = await deps.modelsFor();
    const pricing = catalog.find(
      (model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId,
    )?.pricing;

    /* Stream: `chat.token` deltas batched ~50 ms, then the accumulated text is the reply. */
    const tokens = createBatcher<string>({
      intervalMs: batchMs,
      flush: (deltas) => {
        void bus.emitTransient({
          type: 'chat.token',
          payload: { threadId, delta: deltas.join('') },
        });
      },
    });

    const timeoutMs = node.config.execution.timeoutMs;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : new AbortController().signal;

    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let answeredBy: string | undefined;
    /** What the provider itself said the call cost — a CLI's own figure (D263), as a run uses it. */
    let reportedCostUsd: number | undefined;
    let failure: NodeError | undefined;

    try {
      await deps.runGated(chosen.providerId, async () => {
        const adapter = await deps.adapterFor(chosen.providerId);
        // No `tools` and no `runId`: chat is text-only here and belongs to no run (FR-CHAT-005). A
        // tool loop in direct chat needs the executor's tool machinery, which is out of scope — see
        // the A4 report.
        const stream = adapter.generate(
          {
            modelId: chosen.modelId,
            system: prompt.system,
            prompt: prompt.text,
            outputTypes: ['text'],
            temperature: node.config.execution.temperature,
            maxTokens: node.config.execution.maxTokens,
          },
          signal,
        );

        for await (const chunk of stream as AsyncIterable<StreamChunk>) {
          if (chunk.type === 'text') {
            text += chunk.delta;
            tokens.push(chunk.delta);
          } else if (chunk.type === 'usage') {
            tokensIn = chunk.tokensIn;
            tokensOut = chunk.tokensOut;
            if (chunk.costUsd !== undefined) reportedCostUsd = chunk.costUsd;
          } else if (chunk.type === 'model') {
            answeredBy = chunk.modelId;
          }
        }
      });
    } catch (error) {
      failure = classifyError(error, { providerId: chosen.providerId });
    } finally {
      // Before the closing `chat.message`: a token flushed after it would restart the stream.
      tokens.stop();
    }

    const priced = usageFor(tokensIn, tokensOut, pricing);
    const usage = reportedCostUsd === undefined ? priced : { ...priced, costUsd: reportedCostUsd };

    if (failure !== undefined) {
      logger.warn(
        { subsystem: 'chat', threadId, code: failure.code, kind: failure.kind },
        'chat reply failed',
      );
      return store(
        failedTurn(threadId, failure, { usage }),
      );
    }

    /* The output point (FR-CHAT-008): a block turns the reply into `[blocked by guardrail: …]`. */
    let replyParts: Part[] = [{ type: 'text', text }];
    let verdicts: ChatVerdict[] = [];
    if (guardrails !== undefined) {
      const checked = evaluateChatReply(policy, replyParts, guardrails);
      replyParts =
        checked.kind === 'blocked'
          ? [{ type: 'text', text: blockedChatReply(checked.reason) }]
          : checked.parts;
      verdicts = checked.verdicts;
    }

    return store({
      id: nextId(),
      threadId,
      role: 'agent',
      content: replyParts,
      verdicts,
      usage,
      at: now(),
      ...(answeredBy === undefined ? {} : { modelId: answeredBy }),
    });
  }

  return {
    async postMessage(workflowId, request) {
      const workflow = await repository.workflows.get(scope, workflowId);
      if (workflow === null) throw new ChatWorkflowNotFoundError(workflowId);

      const nodes = await repository.nodes.listByWorkflow(scope, workflowId);
      const inputNodes = nodes.filter((node) => node.kind === 'input');

      const textValue = request.content
        .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const artifactIds = request.content.flatMap((part) =>
        'artifactId' in part ? [part.artifactId] : [],
      );

      /* FR-CHAT-003: the message becomes the Input node's pending text (and attachments). */
      const inputs: Record<Id, Part[]> = {};
      for (const node of inputNodes) {
        if (node.kind !== 'input') continue;
        const updated: Node = {
          ...node,
          config: { ...node.config, text: textValue, artifactIds },
        };
        await repository.nodes.update(scope, updated);
        inputs[node.id] = [...request.content];
      }

      /* BR-01: bump the version so an open Canvas refetches the Input node it just changed. */
      if (inputNodes.length > 0) {
        const version = workflow.version + 1;
        await repository.workflows.update(scope, workflowId, { version, updatedAt: now() });
        await bus.emit(workflowUpdatedEvent(workflowId, version));
      }

      let run: Run | undefined;
      if (request.run) {
        if (deps.startRun === undefined) throw new ChatRunNotAvailableError();
        run = await deps.startRun(workflowId, { inputs });
      }

      const message: Message = {
        id: nextId(),
        workflowId,
        ...(run === undefined ? {} : { runId: run.id }),
        type: 'user',
        content: request.content,
        at: now(),
      };
      await repository.messages.append(scope, message);
      await bus.emit({ type: 'message.created', workflowId, payload: { workflowId, message } });

      return { message, ...(run === undefined ? {} : { run }) };
    },

    async listMessages(workflowId, query) {
      const workflow = await repository.workflows.get(scope, workflowId);
      if (workflow === null) throw new ChatWorkflowNotFoundError(workflowId);

      const result = await repository.messages.query(scope, workflowId, query);
      return {
        items: result.items,
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    },

    async chat(nodeId, request) {
      const resolved = await deps.resolveNode(nodeId);
      if (resolved === null) throw new ChatNodeNotFoundError(nodeId);
      const { node, projectId } = resolved;
      if (node.kind !== 'agent' && node.kind !== 'model') throw new NotAnAgentNodeError(nodeId);

      // First, before a thread or a turn exists: a node that cannot answer says so in the 400.
      const chosen = routeFor(node);

      const policy =
        deps.policies === undefined ? null : await deps.policies.resolve(projectId, node);

      /* Input point first (FR-CHAT-008): a block leaves no thread or message, only the 422. */
      const guardrails = guardrailDeps();
      let inputParts: Part[] = [...request.content];
      let inputVerdicts: ChatVerdict[] = [];
      if (guardrails !== undefined) {
        const checked = evaluateChatInput(policy, request.content, guardrails);
        if (checked.kind === 'blocked') {
          throw new ChatInputBlockedError(checked.verdicts, checked.reason);
        }
        inputParts = checked.parts;
        inputVerdicts = checked.verdicts;
      }

      /* Reuse the named thread or open a new one; a named thread must belong to this node. */
      let thread: ChatThread;
      if (request.threadId !== undefined) {
        const found = await repository.chatThreads.get(scope, request.threadId);
        if (found === null) throw new ChatThreadNotFoundError(request.threadId);
        if (found.nodeId !== nodeId) throw new ChatThreadNodeMismatchError(request.threadId, nodeId);
        thread = found;
      } else {
        const at = now();
        thread = await repository.chatThreads.create(scope, {
          id: nextId(),
          nodeId,
          title: titleFor(request.content),
          createdAt: at,
          updatedAt: at,
        });
      }

      /* The prompt sees the turns before this one; the stored user turn carries the input verdicts. */
      const history = await repository.chatMessages.listByThread(scope, thread.id);
      const userMessage: ChatMessage = {
        id: nextId(),
        threadId: thread.id,
        role: 'user',
        content: inputParts,
        verdicts: inputVerdicts,
        at: now(),
      };
      await repository.chatMessages.append(scope, userMessage);
      await repository.chatThreads.touch(scope, thread.id, now());

      const done = generateReply({
        node,
        chosen,
        policy,
        threadId: thread.id,
        history,
        userParts: inputParts,
        guardrails,
      });
      // The gateway answers 202 and does not await the reply, so its own branch logs a failure and
      // stops it becoming an unhandled rejection; `done` itself still rejects for a caller that awaits.
      done.catch((error: unknown) => {
        logger.error({ subsystem: 'chat', err: error, threadId: thread.id }, 'chat reply failed');
      });

      return { threadId: thread.id, messageId: userMessage.id, done };
    },

    listThreads: (nodeId) => repository.chatThreads.listByNode(scope, nodeId),

    async getThread(threadId) {
      const thread = await repository.chatThreads.get(scope, threadId);
      if (thread === null) throw new ChatThreadNotFoundError(threadId);
      const messages = await repository.chatMessages.listByThread(scope, threadId);
      return { thread, messages };
    },

    async deleteThread(threadId) {
      const removed = await repository.chatThreads.delete(scope, threadId);
      if (!removed) throw new ChatThreadNotFoundError(threadId);
    },

    async recordRunTurn(turn) {
      /*
       * The node's session is the thread it was last talked to in — what the chat panel opens on —
       * or a new one named after the goal. Recency is `updatedAt`, with the ULID id breaking a tie,
       * so the choice does not depend on the order the repository lists threads in.
       */
      const threads = await repository.chatThreads.listByNode(scope, turn.nodeId);
      const latest = threads.reduce<ChatThread | undefined>(
        (best, thread) =>
          best === undefined ||
          thread.updatedAt > best.updatedAt ||
          (thread.updatedAt === best.updatedAt && thread.id > best.id)
            ? thread
            : best,
        undefined,
      );
      const goal: Part[] = turn.goal.length > 0 ? turn.goal : [{ type: 'text', text: 'Run' }];
      let thread = latest;
      if (thread === undefined) {
        const at = now();
        thread = await repository.chatThreads.create(scope, {
          id: nextId(),
          nodeId: turn.nodeId,
          title: titleFor(goal),
          createdAt: at,
          updatedAt: at,
        });
      }

      await store({
        id: nextId(),
        threadId: thread.id,
        role: 'user',
        content: goal,
        verdicts: [],
        at: now(),
        runId: turn.runId,
      });

      const extra = {
        runId: turn.runId,
        ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      };
      await store(
        turn.error !== undefined
          ? failedTurn(thread.id, turn.error, extra)
          : {
              id: nextId(),
              threadId: thread.id,
              role: 'agent',
              content: turn.output ?? [],
              verdicts: [],
              at: now(),
              ...extra,
              ...(turn.modelId === undefined ? {} : { modelId: turn.modelId }),
            },
      );

      return { threadId: thread.id };
    },
  };
}
