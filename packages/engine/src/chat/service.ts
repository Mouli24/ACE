import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_MAX_TOOL_CALLS,
  blockedChatReply,
  isCliProviderType,
  type ActivityItem,
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
  type ToolDefinition,
  type Usage,
} from '@ace/contracts';

import type { ContextGuard } from '../context/guard.js';
import { classifyError } from '../errors/index.js';
import { createBatcher } from '../events/batcher.js';
import { workflowUpdatedEvent, type EventBus } from '../events/index.js';
import type { CheckRunner, SecretMasker } from '../guardrails/checks.js';
import type { PolicyService } from '../guardrails/policy-service.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  CheckpointRecorder,
  CheckpointRecording,
  ModelRouter,
  ProviderAdapter,
  Repository,
  Scope,
  StreamChunk,
  ToolResult,
} from '../ports/index.js';
import { createSemaphore, type Semaphore } from '../providers/semaphore.js';
import { usageFor } from '../runs/cost.js';
import { CLI_SESSION_MIN_TIMEOUT_MS } from '../runs/executor.js';
import type { ToolProvider } from '../runs/tool-loop.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { activityItemFor } from './activity.js';
import {
  ChatInputBlockedError,
  ChatModelError,
  ChatNodeNotFoundError,
  ChatRunNotAvailableError,
  ChatTargetInvalidError,
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
import {
  chatToolsFrom,
  runChatToolLoop,
  type ChatToolRequest,
  type ToolResultJudgement,
} from './tool-loop.js';

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

/**
 * What `resolveNode` returns: the node, the project whose default policy guards it and whose
 * folder a chat works in (D302), and the workflow a `targetNodeId` must share (D302).
 */
export interface ResolvedChatNode {
  node: Node;
  projectId: Id;
  workflowId: Id;
}

/**
 * D302: how long one model call of a chat turn may take. A coding-agent CLI working in the project
 * folder runs a whole session per call, so it gets a run's floor (`CLI_SESSION_MIN_TIMEOUT_MS`);
 * everything else keeps the node's own clock.
 */
export function chatTurnTimeoutMs(
  nodeTimeoutMs: number,
  options: { cli: boolean; workspace: boolean },
): number {
  return nodeTimeoutMs > 0 && options.cli && options.workspace
    ? Math.max(nodeTimeoutMs, CLI_SESSION_MIN_TIMEOUT_MS)
    : nodeTimeoutMs;
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
  /**
   * D302: the tool registry an API model's project chat draws its tools from — only the
   * non-destructive project six are ever offered (`CHAT_PROJECT_TOOLS`). Absent: no tools in chat.
   */
  tools?: ToolProvider;
  /**
   * D302/D300: records a checkpoint around each writing chat turn. Absent: turns still write, and
   * nothing is recorded to review or revert.
   */
  checkpoints?: CheckpointRecorder;
  /**
   * D302: the run's context point (FR-GRD-004). Every result of an API model's project tool passes
   * it before the model reads it — hidden instructions stripped, personal data redacted per the
   * speaker's policy — and its verdicts ride the reply. Only `inspect`: a chat has no node run to
   * record them against (FR-CHAT-005). Absent: tool results reach the model unchecked.
   */
  contextGuard?: Pick<ContextGuard, 'inspect'>;
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
    extra: Partial<
      Pick<
        ChatMessage,
        'runId' | 'usage' | 'speakerNodeId' | 'activity' | 'checkpointId' | 'verdicts'
      >
    > = {},
    id: Id = nextId(),
  ): ChatMessage {
    const message = maskSecrets(error.message);
    return {
      id,
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

  /** The project folder a chat with this project's nodes works in (D302); none without one. */
  async function workspaceOf(projectId: Id): Promise<string | undefined> {
    try {
      const project = await repository.projects.get(scope, projectId);
      return project === null || project.folderPath === '' ? undefined : project.folderPath;
    } catch {
      return undefined;
    }
  }

  /**
   * D302: writing turns go one at a time per project, so two agents' changes never interleave in
   * one checkpoint. A workflow run in the same project is not held back by this (a documented
   * limitation: its changes and a chat turn's can mix).
   */
  const writeQueues = new Map<Id, Semaphore>();
  function writeQueue(projectId: Id): Semaphore {
    let queue = writeQueues.get(projectId);
    if (queue === undefined) {
      queue = createSemaphore(1);
      writeQueues.set(projectId, queue);
    }
    return queue;
  }

  /** Node id → name across the thread's workflow, so the prompt can say who said what (D302). */
  async function namesOf(workflowId: Id): Promise<Map<string, string>> {
    try {
      const nodes = await repository.nodes.listByWorkflow(scope, workflowId);
      return new Map(nodes.map((each) => [each.id, each.name]));
    } catch {
      return new Map();
    }
  }

  interface ReplyContext {
    /** The node answering: the target, or the thread's own node (D302). */
    node: ChatNode;
    /** The thread's own node — who spoke a turn that names no speaker. */
    mainNodeId: Id;
    workflowId: Id;
    projectId: Id;
    /** The project folder (D302): set, the turn works in it and is a writing turn. */
    workspace: string | undefined;
    chosen: ModelUsed;
    policy: Awaited<ReturnType<PolicyService['resolve']>> | null;
    threadId: Id;
    /** The stored user turn this reply answers — left out of the history it reads. */
    userMessageId: Id;
    userParts: readonly Part[];
    guardrails: ChatGuardrailDeps | undefined;
  }

  /**
   * The thread as it is when the turn starts (D302): a turn that waited in the write queue reads
   * the replies that landed while it waited — a queued `@reviewer` sees what the coder just did.
   * The turn's own message is the new turn, so it is left out, and so is any later user message:
   * that is a question for a later turn.
   */
  async function historyFor(threadId: Id, userMessageId: Id): Promise<ChatMessage[]> {
    const messages = await repository.chatMessages.listByThread(scope, threadId);
    return messages.filter(
      (message) =>
        message.id !== userMessageId && !(message.role === 'user' && message.id > userMessageId),
    );
  }

  /**
   * Generate, guard and persist one reply (FR-CHAT-004, FR-CHAT-006, FR-CHAT-008). Never touches a
   * run: it calls the adapter directly, prices with `usageFor`, and writes only a `ChatMessage`. A
   * failed call is written too, as a turn carrying its `error`, so the client always hears how the
   * turn ended (D287). A turn in a project with a folder is a writing turn (D302): it waits for the
   * project's write queue and is checkpointed.
   */
  function generateReply(context: ReplyContext): Promise<ChatMessage> {
    if (context.workspace === undefined) return produceReply(context);
    return writeQueue(context.projectId).run(() => produceReply(context));
  }

  async function produceReply(context: ReplyContext): Promise<ChatMessage> {
    const { node, chosen, policy, threadId, userParts, guardrails, workspace } = context;
    // Known before the call, so the checkpoint can name the turn it belongs to.
    const replyId = nextId();
    // Read now, holding the project's queue — never the snapshot from before the turn waited.
    const history = await historyFor(threadId, context.userMessageId);

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
      speakers: {
        names: await namesOf(context.workflowId),
        mainNodeId: context.mainNodeId,
        selfNodeId: node.id,
      },
    });

    const catalog = await deps.modelsFor();
    const catalogRow = catalog.find(
      (model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId,
    );
    const pricing = catalogRow?.pricing;

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

    /* D300/D302: the files before the turn, so what it changed can be reviewed and reverted. */
    let recording: CheckpointRecording | undefined;
    if (workspace !== undefined && deps.checkpoints !== undefined) {
      try {
        recording = await deps.checkpoints.begin(context.projectId, {
          kind: 'chat',
          threadId,
          messageId: replyId,
          nodeId: node.id,
        });
      } catch (error) {
        logger.warn({ subsystem: 'chat', threadId, err: error }, 'chat checkpoint did not start');
      }
    }

    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let answeredBy: string | undefined;
    /** What the provider itself said the call cost — a CLI's own figure (D263), as a run uses it. */
    let reportedCostUsd: number | undefined;
    let failure: NodeError | undefined;
    /** D302: what the turn did in the project — a CLI's activity or the API tool calls. */
    const activity: ActivityItem[] = [];
    let toolsOffered = false;
    let limitReached = false;
    const maxToolCalls =
      node.kind === 'agent' ? node.config.tools.maxToolCalls : DEFAULT_MAX_TOOL_CALLS;
    /** The context point's verdicts on the tool results, in order; they ride the reply. */
    const toolVerdicts: ChatVerdict[] = [];
    const contextGuard = deps.contextGuard;
    const judge =
      contextGuard === undefined
        ? undefined
        : async (text: string): Promise<ToolResultJudgement> => {
            // The run's context point, judged as a node run of this turn would be (`tool` label,
            // the speaker's policy); nothing is recorded — the verdicts go on the reply instead.
            const judged = await contextGuard.inspect({
              target: {
                runId: replyId,
                workflowId: context.workflowId,
                nodeRunId: replyId,
                nodeId: node.id,
                nodeName: node.name,
                iteration: 1,
                policy,
              },
              label: 'tool',
              text,
            });
            for (const { nodeRunId: _noNodeRun, ...verdict } of judged.verdicts) {
              toolVerdicts.push(verdict);
            }
            return judged.kind === 'failed'
              ? { kind: 'failed', error: judged.error }
              : { kind: 'continue', text: judged.text };
          };

    try {
      const adapter: ProviderAdapter = await deps.adapterFor(chosen.providerId);
      const cli = isCliProviderType(adapter.type);
      const timeoutMs = chatTurnTimeoutMs(node.config.execution.timeoutMs, {
        cli,
        workspace: workspace !== undefined,
      });
      // D302: an API model in a project gets the non-destructive project tools, when its catalog
      // row says it can call tools; a CLI uses its own, under its provider's permission preset.
      const offered =
        workspace !== undefined && !cli && catalogRow?.supportsTools === true
          ? chatToolsFrom(deps.tools)
          : [];
      toolsOffered = offered.length > 0;

      /** One model call, inside this provider's concurrency gate (FR-PRV-009). */
      const turn = (options: {
        tools?: ToolDefinition[];
        toolResults?: ToolResult[];
      }): Promise<ChatToolRequest[]> =>
        deps.runGated(chosen.providerId, async () => {
          const signal =
            timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : new AbortController().signal;
          // No `runId`: a chat belongs to no run (FR-CHAT-005); `turnId` names the turn instead.
          const stream = adapter.generate(
            {
              modelId: chosen.modelId,
              system: prompt.system,
              prompt: prompt.text,
              outputTypes: ['text'],
              temperature: node.config.execution.temperature,
              maxTokens: node.config.execution.maxTokens,
              turnId: replyId,
              // D302: a CLI works in the project under its preset; without a folder it is read-only.
              ...(workspace === undefined ? {} : { workingDir: workspace }),
              ...(options.tools === undefined ? {} : { tools: options.tools }),
              ...(options.toolResults === undefined ? {} : { toolResults: options.toolResults }),
            },
            signal,
          );

          const requested: ChatToolRequest[] = [];
          for await (const chunk of stream as AsyncIterable<StreamChunk>) {
            if (chunk.type === 'text') {
              text += chunk.delta;
              tokens.push(chunk.delta);
            } else if (chunk.type === 'usage') {
              // Summed: every call of a tool loop is its own billed call.
              tokensIn += chunk.tokensIn;
              tokensOut += chunk.tokensOut;
              if (chunk.costUsd !== undefined) {
                reportedCostUsd = (reportedCostUsd ?? 0) + chunk.costUsd;
              }
            } else if (chunk.type === 'model') {
              answeredBy = chunk.modelId;
            } else if (chunk.type === 'tool_call') {
              requested.push({ callId: chunk.callId, name: chunk.name, args: chunk.args });
            } else if (chunk.type === 'activity') {
              // The CLI already did this (D261): kept as what it did, never what it read.
              activity.push(
                activityItemFor({
                  tool: chunk.tool,
                  args: chunk.args,
                  status: chunk.status,
                  ...(workspace === undefined ? {} : { projectDir: workspace }),
                }),
              );
            }
          }
          return requested;
        });

      const loop = await runChatToolLoop({
        tools: offered,
        // With nothing offered a stray tool request ends the turn rather than being refused.
        maxToolCalls: toolsOffered ? maxToolCalls : 0,
        context: {
          runId: replyId,
          sandboxDir: '',
          ...(workspace === undefined ? {} : { projectDir: workspace }),
          signal: new AbortController().signal,
        },
        turn,
        activity,
        onCall: (tool, status) =>
          logger.info({ subsystem: 'chat', threadId, tool, status }, 'chat tool call'),
        ...(judge === undefined ? {} : { judge }),
      });
      limitReached = loop.limitReached;
      // D287: a result the context point blocked ends the turn as a stored error, with its reason.
      if (loop.blocked !== undefined) failure = loop.blocked;
    } catch (error) {
      failure = classifyError(error, { providerId: chosen.providerId });
    } finally {
      // Before the closing `chat.message`: a token flushed after it would restart the stream.
      tokens.stop();
    }

    /* The files after the turn — whether it answered or failed, what it changed is reviewable. */
    let checkpointId: Id | undefined;
    if (recording !== undefined) {
      try {
        checkpointId = (await recording.finish())?.id;
      } catch (error) {
        logger.warn({ subsystem: 'chat', threadId, err: error }, 'chat checkpoint did not finish');
      }
    }
    const extra = {
      speakerNodeId: node.id,
      ...(activity.length === 0 ? {} : { activity }),
      ...(checkpointId === undefined ? {} : { checkpointId }),
    };
    const failedExtra = toolVerdicts.length === 0 ? extra : { ...extra, verdicts: toolVerdicts };

    const priced = usageFor(tokensIn, tokensOut, pricing);
    const usage = reportedCostUsd === undefined ? priced : { ...priced, costUsd: reportedCostUsd };

    if (failure !== undefined) {
      logger.warn(
        { subsystem: 'chat', threadId, code: failure.code, kind: failure.kind },
        'chat reply failed',
      );
      return store(failedTurn(threadId, failure, { usage, ...failedExtra }, replyId));
    }

    if (limitReached && toolsOffered && text.trim() === '') {
      text = `I stopped after ${maxToolCalls} tool calls, the most one chat turn may make.`;
    }

    /* The output point (FR-CHAT-008): a block turns the reply into `[blocked by guardrail: …]`. */
    let replyParts: Part[] = [{ type: 'text', text }];
    let verdicts: ChatVerdict[] = [...toolVerdicts];
    if (guardrails !== undefined) {
      const checked = evaluateChatReply(policy, replyParts, guardrails);
      replyParts =
        checked.kind === 'blocked'
          ? [{ type: 'text', text: blockedChatReply(checked.reason) }]
          : checked.parts;
      verdicts = [...toolVerdicts, ...checked.verdicts];
    }

    return store({
      id: replyId,
      threadId,
      role: 'agent',
      content: replyParts,
      verdicts,
      usage,
      at: now(),
      ...(answeredBy === undefined ? {} : { modelId: answeredBy }),
      ...extra,
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
      const { node: addressed, projectId, workflowId } = resolved;
      if (addressed.kind !== 'agent' && addressed.kind !== 'model') {
        throw new NotAnAgentNodeError(nodeId);
      }

      /*
       * The named thread, read before anything is decided: with no target, its own node answers.
       * D302 relaxes the old check — a thread of any node of the same workflow may be continued
       * from this node — but a thread of another workflow is still refused.
       */
      let found: ChatThread | undefined;
      let owner: ChatNode = addressed;
      if (request.threadId !== undefined) {
        const thread = await repository.chatThreads.get(scope, request.threadId);
        if (thread === null) throw new ChatThreadNotFoundError(request.threadId);
        if (thread.nodeId !== nodeId) {
          const other = await deps.resolveNode(thread.nodeId);
          if (other === null || other.workflowId !== workflowId) {
            throw new ChatThreadNodeMismatchError(request.threadId, nodeId);
          }
          if (other.node.kind !== 'agent' && other.node.kind !== 'model') {
            throw new NotAnAgentNodeError(thread.nodeId);
          }
          owner = other.node;
        }
        found = thread;
      }

      /* D302: the node that answers — the `@handle` target, or the thread's own node. */
      let node: ChatNode = owner;
      const targetId = request.targetNodeId;
      if (targetId !== undefined && targetId !== owner.id) {
        const target = targetId === addressed.id ? resolved : await deps.resolveNode(targetId);
        if (target === null || target.workflowId !== workflowId) {
          throw new ChatTargetInvalidError(targetId, `Node ${targetId} is not in this workflow.`);
        }
        if (target.node.kind !== 'agent' && target.node.kind !== 'model') {
          throw new ChatTargetInvalidError(
            targetId,
            `"${target.node.name}" is not an agent or model node, so it cannot answer in chat.`,
          );
        }
        node = target.node;
      }

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

      /* Reuse the named thread or open a new one; the thread keeps its node, the main one. */
      let thread: ChatThread;
      if (found !== undefined) {
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

      /* The stored user turn carries the input verdicts; the reply reads the thread when it starts. */
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
        mainNodeId: thread.nodeId,
        workflowId,
        projectId,
        workspace: await workspaceOf(projectId),
        chosen,
        policy,
        threadId: thread.id,
        userMessageId: userMessage.id,
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
