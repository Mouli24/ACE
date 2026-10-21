import {
  APPROVAL_PREVIEW_MAX,
  DEFAULT_CLI_PERMISSION,
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_MAX_TOOL_CALLS,
  agentWorkspaceOf,
  blockedChatReply,
  estimateTokens,
  isAgentic,
  isCliProviderType,
  type WorkspaceAccess,
  type ActivityItem,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type GuardrailCheck,
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

import {
  PROJECT_WRITING_TOOLS,
  nodeWrites,
  undoUnavailableMessage,
} from '../checkpoints/writing.js';
import type { ContextGuard } from '../context/guard.js';
import { classifyError } from '../errors/index.js';
import { createBatcher } from '../events/batcher.js';
import { workflowUpdatedEvent, type EventBus } from '../events/index.js';
import type { CheckRunner, SecretMasker } from '../guardrails/checks.js';
import type { PolicyService } from '../guardrails/policy-service.js';
import { guardrailStoreFor } from '../guardrails/store.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  CheckpointRecorder,
  CheckpointRecording,
  GenerateRequest,
  ModelRouter,
  ProviderAdapter,
  Repository,
  Scope,
  StreamChunk,
  ToolResult,
} from '../ports/index.js';
import { createSemaphore, type Semaphore } from '../providers/semaphore.js';
import { usageFor, withReportedCost, type PricedProvider } from '../runs/cost.js';
import { agentSystemPrompt } from '../runs/agentic/system-prompt.js';
import { CLI_SESSION_MIN_TIMEOUT_MS } from '../runs/executor.js';
import { redactArgs, type ToolProvider } from '../runs/tool-loop.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { activityItemFor } from './activity.js';
import {
  ChatActionInvalidError,
  ChatApprovalNotFoundError,
  ChatInputBlockedError,
  ChatMessageNotFoundError,
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
  evaluateChatTool,
  type ChatGuardrailDeps,
} from './guardrails.js';
import { buildChatPrompt, revertedFilesNote } from './prompt.js';
import {
  chatToolsFrom,
  runChatToolLoop,
  type ChatToolRequest,
  type ChatToolStep,
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
  /** D378: what an agentic node's step did in the project folder, in order — "What it did". */
  activity?: ActivityItem[];
  /** D378: the step's checkpoint of the files it changed — the Changes card. */
  checkpointId?: Id;
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
  /**
   * PG-1.6 (D352) `POST /chat/threads/:id/messages/:messageId/retry`: re-run the turn that produced
   * this agent message (a reply or a failed turn). The old turn is marked `supersededAt` and a new
   * reply is appended; `messageId` is the user turn it answers.
   */
  retryMessage(
    threadId: Id,
    messageId: Id,
    options?: { withoutUndo?: boolean },
  ): Promise<ChatBegun>;
  /** PG-2.2 (D359) `GET /chat/threads/:id/approvals`: the tool calls on the thread waiting on a person. */
  listApprovals(threadId: Id): Promise<ApprovalRequest[]>;
  /**
   * PG-2.2 (D359) `POST /chat/threads/:id/approvals/:requestId/approve` and `/reject`: settle a chat
   * tool call's approval. Approve runs the tool; reject refuses it and the turn goes on without it.
   */
  decideApproval(
    threadId: Id,
    requestId: Id,
    kind: ApprovalDecisionKind,
    note?: string,
  ): Promise<ApprovalDecision>;
  /**
   * PG-1.6 (D352) `POST /chat/threads/:id/messages/:messageId/edit`: the user message and every
   * turn after it are marked `supersededAt`, and the edited content goes as a new turn.
   */
  editMessage(threadId: Id, messageId: Id, content: Part[]): Promise<ChatBegun>;
  /** PG-1.6 (D352) `DELETE /chat/threads/:id/messages/:messageId`: hide one turn (`deletedAt`). */
  deleteMessage(threadId: Id, messageId: Id): Promise<void>;
  /**
   * PG-1.6 (D352) `POST /chat/threads/:id/stop`: abort the turn(s) in flight on the thread; each is
   * stored as a failed turn of kind `user_cancelled`. `false` when nothing was in flight.
   */
  stopThread(threadId: Id): Promise<{ stopped: boolean }>;
  /**
   * PG-1.5: run once at engine start. Every user turn the last process accepted but never answered
   * (a crash or a shutdown in the middle of it) gets one stored failed agent turn, announced as
   * `chat.message`, so no client waits on it forever. Returns how many turns it closed.
   */
  recoverOpenTurns(): Promise<number>;
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

/**
 * Ends a turn with a stored failed turn carrying this error, rather than the classified throw:
 * a budget the turn crossed (PG-2.2) or a checkpoint it could not begin (PG-2.4).
 */
class TurnRefusal extends Error {
  override readonly name = 'TurnRefusal';

  constructor(readonly nodeError: NodeError) {
    super(nodeError.message);
  }
}

const money = (usd: number): string => `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;

/** PG-2.2: a chat turn's caps, from the project and the settings unless the policy says otherwise. */
interface TurnCaps {
  /** The project's `maxCostPerRunUsd`, applied to each turn. */
  turn?: number;
  /** `dailyBudgetUsd`, with what today has already cost before this turn. */
  daily?: { capUsd: number; spentUsd: number };
}

/** The budget refusal a chat turn ends with (PG-2.2), in the run's budget words. */
function budgetError(scope: 'turn' | 'daily', costUsd: number, capUsd: number): NodeError {
  return {
    kind: 'guardrail',
    code: 'budget_exceeded',
    message:
      scope === 'turn'
        ? `Budget exceeded: this turn cost ${money(costUsd)}, over the project's ${money(capUsd)} cost cap.`
        : `Budget exceeded: today has cost ${money(costUsd)}, at or over the ${money(capUsd)} daily budget.`,
    retryable: false,
  };
}

function titleFor(content: readonly Part[]): string {
  const firstText = content.find(
    (part): part is Extract<Part, { type: 'text' }> => part.type === 'text',
  );
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

  /**
   * Store one turn, move its thread's `updatedAt`, and announce it on the thread (FR-CHAT-006).
   * `onAppended` is told the moment the row exists, so a caller recovering from a later throw never
   * stores the same turn twice (PG-1.5). A thread whose `updatedAt` cannot move still announces it.
   */
  async function store(message: ChatMessage, onAppended?: () => void): Promise<ChatMessage> {
    await repository.chatMessages.append(scope, message);
    onAppended?.();
    try {
      await repository.chatThreads.touch(scope, message.threadId, now());
    } catch (error) {
      logger.warn(
        { subsystem: 'chat', threadId: message.threadId, err: error },
        'thread not touched',
      );
    }
    await bus.emit({
      type: 'chat.message',
      payload: { threadId: message.threadId, message },
    });
    return message;
  }

  /** PG-1.6 (D352): mark an existing turn and announce it as `chat.update` on its thread. */
  async function markAndAnnounce(
    message: ChatMessage,
    patch: { supersededAt?: string; deletedAt?: string },
  ): Promise<ChatMessage> {
    const marked = (await repository.chatMessages.mark(scope, message.id, patch)) ?? {
      ...message,
      ...patch,
    };
    await bus.emit({
      type: 'chat.update',
      payload: { threadId: message.threadId, message: marked },
    });
    return marked;
  }

  /** A turn still part of the conversation: neither replaced by a retry or edit, nor deleted. */
  const standing = (message: ChatMessage): boolean =>
    message.supersededAt === undefined && message.deletedAt === undefined;

  /**
   * PG-1.6 (D352): the turns in flight on each thread, so `stopThread` can abort them. A turn is
   * registered before it waits for its project's write queue, so a stop reaches a queued turn too.
   */
  const inFlight = new Map<Id, Set<AbortController>>();

  /** What a turn the person stopped records (PG-1.6): Arch §28's `user_cancelled`, never retried by itself. */
  const cancelledError = (): NodeError => ({
    kind: 'user_cancelled',
    code: 'stopped',
    message: 'You stopped this reply before it finished.',
    retryable: true,
  });

  /** What a turn the last process never answered records (PG-1.5, as D323's crashed turn). */
  const openTurnError = (): NodeError => ({
    kind: 'workflow',
    code: 'crash',
    message:
      'The engine stopped (a shutdown or a crash) before this turn was answered, so it has no reply.',
    retryable: true,
  });

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

  /**
   * PG-2.2: the caps a chat turn obeys. The project's `maxCostPerRunUsd` caps each turn and
   * `dailyBudgetUsd` caps the day, chat spend included. The policy's own cost checks speak first,
   * as they do for a run (D79): `params.usd` sets the cap, and a check that is off or only `warn`s
   * or `pass`es does not stop a turn. With no such check the project's and settings' caps apply.
   */
  async function capsFor(
    projectId: Id,
    policy: Awaited<ReturnType<PolicyService['resolve']>> | null,
  ): Promise<TurnCaps> {
    const checkOf = (type: string): GuardrailCheck | undefined =>
      policy?.checks.find((check) => check.point === 'cost' && check.type === type);
    const stops = (check: GuardrailCheck | undefined): boolean =>
      check === undefined || (check.enabled && check.action !== 'pass' && check.action !== 'warn');
    const paramUsd = (check: GuardrailCheck | undefined): number | undefined => {
      const raw = check?.params['usd'];
      return typeof raw === 'number' && raw > 0 ? raw : undefined;
    };

    const caps: TurnCaps = {};
    try {
      const runCheck = checkOf('max_cost_per_run');
      if (stops(runCheck)) {
        const project = await repository.projects.get(scope, projectId);
        const usd = paramUsd(runCheck) ?? project?.maxCostPerRunUsd ?? undefined;
        if (usd !== undefined && usd !== null && usd > 0) caps.turn = usd;
      }
      const dailyCheck = checkOf('daily_budget');
      if (stops(dailyCheck)) {
        const settings = await repository.settings.get(scope);
        const usd = paramUsd(dailyCheck) ?? settings.dailyBudgetUsd ?? undefined;
        if (usd !== undefined && usd !== null && usd > 0) {
          const day = now().slice(0, 10);
          const spentUsd = await guardrailStoreFor(repository, scope).usage.costUsdForDay(
            scope,
            day,
          );
          caps.daily = { capUsd: usd, spentUsd };
        }
      }
    } catch (error) {
      logger.warn({ subsystem: 'chat', projectId, err: error }, 'chat budget caps not read');
    }
    return caps;
  }

  /**
   * PG-2.2 (D359): the chat tool calls waiting on a person, by request id. They live as long as the
   * turn waits — in this process, as a run's approval wait does (FR-SYS-009); a turn a restart cut
   * short is closed by `recoverOpenTurns`.
   */
  const chatApprovals = new Map<
    Id,
    { request: ApprovalRequest; settle: (decision: ApprovalDecision) => void }
  >();

  /** Store-less decision: announced on the thread, then the waiting turn resumes. */
  async function settleApproval(
    threadId: Id,
    requestId: Id,
    kind: ApprovalDecisionKind,
    note?: string,
  ): Promise<ApprovalDecision> {
    const pending = chatApprovals.get(requestId);
    if (pending === undefined || pending.request.threadId !== threadId) {
      throw new ChatApprovalNotFoundError(threadId, requestId);
    }
    chatApprovals.delete(requestId);
    const decision: ApprovalDecision = {
      requestId,
      decision: kind,
      ...(note === undefined ? {} : { note }),
      decidedAt: now(),
    };
    try {
      await bus.emit({ type: 'chat.approval_decided', payload: { threadId, decision } });
    } finally {
      pending.settle(decision);
    }
    return decision;
  }

  /** Ask a person about one chat tool call and wait; a stop of the turn ends the wait (PG-1.6). */
  async function askApproval(input: {
    threadId: Id;
    node: ChatNode;
    check: GuardrailCheck;
    reason: string;
    call: ChatToolRequest;
    signal: AbortSignal;
  }): Promise<ApprovalDecision> {
    if (input.signal.aborted) throw new Error('stopped before the approval was asked');
    const request: ApprovalRequest = {
      id: nextId(),
      threadId: input.threadId,
      nodeId: input.node.id,
      nodeName: input.node.name,
      point: 'tool',
      checkType: input.check.type,
      reason: input.reason,
      // The card shows the tool and its arguments with secret-shaped values masked (BR-07).
      preview: maskSecrets(
        `${input.call.name} ${JSON.stringify(redactArgs(input.call.args))}`,
      ).slice(0, APPROVAL_PREVIEW_MAX),
      requestedAt: now(),
    };
    const decided = new Promise<ApprovalDecision>((resolve, reject) => {
      const abandon = (): void => {
        if (!chatApprovals.has(request.id)) return;
        void settleApproval(
          input.threadId,
          request.id,
          'reject',
          'The turn was stopped before this was decided.',
        ).catch(() => undefined);
        reject(new Error('stopped while waiting for an approval'));
      };
      chatApprovals.set(request.id, {
        request,
        settle: (decision) => {
          input.signal.removeEventListener('abort', abandon);
          resolve(decision);
        },
      });
      input.signal.addEventListener('abort', abandon, { once: true });
    });
    await bus.emit({
      type: 'chat.approval_required',
      payload: { threadId: input.threadId, request },
    });
    return decided;
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
    /**
     * PG-1.6: a retry reads the thread as it stood when the turn it replaces ran — only turns
     * before this id. Absent: the thread as it is now (D302).
     */
    historyBefore?: Id;
    /** PG-2.4 (D361): the person chose "Run without undo" for this one turn. */
    withoutUndo?: boolean;
  }

  /** Set as a reply's path runs, so a throw anywhere can be closed out exactly once (PG-1.5). */
  interface TurnProgress {
    /** The reply's row exists: a later throw must not store a second turn. */
    appended: boolean;
    /** R-1: the reverted paths taken for this turn, handed back if it never told the model. */
    reverted: string[];
  }

  /**
   * The thread as it is when the turn starts (D302): a turn that waited in the write queue reads
   * the replies that landed while it waited — a queued `@reviewer` sees what the coder just did.
   * The turn's own message is the new turn, so it is left out, and so is any later user message:
   * that is a question for a later turn. A superseded or deleted turn is never read (PG-1.6).
   */
  async function historyFor(threadId: Id, userMessageId: Id, before?: Id): Promise<ChatMessage[]> {
    const messages = await repository.chatMessages.listByThread(scope, threadId);
    return messages.filter(
      (message) =>
        standing(message) &&
        message.id !== userMessageId &&
        !(message.role === 'user' && message.id > userMessageId) &&
        (before === undefined || message.id < before),
    );
  }

  /**
   * Generate, guard and persist one reply (FR-CHAT-004, FR-CHAT-006, FR-CHAT-008). Never touches a
   * run: it calls the adapter directly, prices with `usageFor`, and writes only a `ChatMessage`. A
   * failed call is written too, as a turn carrying its `error`, so the client always hears how the
   * turn ended (D287). A turn in a project with a folder is a writing turn (D302): it waits for the
   * project's write queue and is checkpointed.
   *
   * PG-1.5: the whole path is wrapped. A throw anywhere — the write queue, the reverted-paths read,
   * the output guardrail, pricing, the final store — ends the turn as one stored failed turn and one
   * `chat.message`, never as a log line and a client left "typing…". PG-1.6: a stop aborts it, and
   * it is stored as `user_cancelled`.
   */
  async function generateReply(context: ReplyContext): Promise<ChatMessage> {
    const { threadId } = context;
    const controller = new AbortController();
    let running = inFlight.get(threadId);
    if (running === undefined) {
      running = new Set();
      inFlight.set(threadId, running);
    }
    running.add(controller);
    // Known before the call, so the checkpoint can name the turn it belongs to.
    const replyId = nextId();
    const progress: TurnProgress = { appended: false, reverted: [] };
    const produce = (): Promise<ChatMessage> =>
      produceReply(context, replyId, controller.signal, progress);
    try {
      return context.workspace === undefined
        ? await produce()
        : await writeQueue(context.projectId).run(produce);
    } catch (error) {
      // The reply is stored; only its announcement failed. Never a second turn for it.
      if (progress.appended) throw error;
      logger.error({ subsystem: 'chat', threadId, err: error }, 'chat reply path failed');
      if (progress.reverted.length > 0) {
        deps.checkpoints?.restoreRevertedPaths?.(threadId, progress.reverted);
      }
      const failure = controller.signal.aborted
        ? cancelledError()
        : classifyError(error, { providerId: context.chosen.providerId });
      return store(failedTurn(threadId, failure, { speakerNodeId: context.node.id }, replyId));
    } finally {
      running.delete(controller);
      if (running.size === 0) inFlight.delete(threadId);
    }
  }

  async function produceReply(
    context: ReplyContext,
    replyId: Id,
    stopSignal: AbortSignal,
    progress: TurnProgress,
  ): Promise<ChatMessage> {
    const { node, chosen, policy, threadId, userParts, guardrails, workspace } = context;
    // Stopped while it waited for the project's write queue: it never starts.
    if (stopSignal.aborted) throw new Error('stopped before it started');
    // R-1: the files the person reverted in this thread since its last turn, told once, here.
    const reverted = deps.checkpoints?.takeRevertedPaths?.(threadId) ?? [];
    progress.reverted = reverted;
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
    /** PG-2.4 (D361): why the checkpoint could not begin; judged once the turn's tools are known. */
    let checkpointFailure: string | undefined;
    if (workspace !== undefined && deps.checkpoints !== undefined) {
      try {
        recording = await deps.checkpoints.begin(context.projectId, {
          kind: 'chat',
          threadId,
          messageId: replyId,
          nodeId: node.id,
        });
        checkpointFailure = recording.failed;
      } catch (error) {
        checkpointFailure = error instanceof Error ? error.message : String(error);
      }
    }
    /** PG-1.4 (D359): the provider that answers, for the cost rule (local $0, unpriced unknown). */
    let pricedProvider: PricedProvider | undefined;

    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;
    /** D387: part of the tokens was estimated, because a call reported no usage. */
    let estimated = false;
    let answeredBy: string | undefined;
    /** What the provider itself said the call cost — a CLI's own figure (D263), as a run uses it. */
    let reportedCostUsd: number | undefined;
    let failure: NodeError | undefined;
    /** D302: what the turn did in the project — a CLI's activity or the API tool calls. */
    const activity: ActivityItem[] = [];
    let toolsOffered = false;
    let limitReached = false;
    // D375: an agentic node's turn is bounded by its Max turns, as its run steps are.
    const maxToolCalls =
      node.kind !== 'agent'
        ? DEFAULT_MAX_TOOL_CALLS
        : isAgentic(node.config)
          ? agentWorkspaceOf(node.config).maxTurns
          : node.config.tools.maxToolCalls;
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

    /** From the catalog row, once it is read: what the reply's usage is priced at. */
    let pricing: Model['pricing'];
    try {
      // Inside the turn (D287 fix F-M4): a thread or catalog that cannot be read ends the turn as
      // a stored failed reply, like any other failure, rather than leaving the client "typing…".
      // Read now, holding the project's queue — never the snapshot from before the turn waited.
      const history = await historyFor(threadId, context.userMessageId, context.historyBefore);

      const instructions =
        node.kind === 'agent' ? node.config.instructions : (node.config.systemPrompt ?? '');
      const budgetTokens =
        node.kind === 'agent'
          ? node.config.contextPolicy.budgetTokens
          : DEFAULT_CONTEXT_POLICY.budgetTokens;

      const catalog = await deps.modelsFor();
      const catalogRow = catalog.find(
        (model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId,
      );
      pricing = catalogRow?.pricing;

      const adapter: ProviderAdapter = await deps.adapterFor(chosen.providerId);
      const cli = isCliProviderType(adapter.type);
      const timeoutMs = chatTurnTimeoutMs(node.config.execution.timeoutMs, {
        cli,
        workspace: workspace !== undefined,
      });
      // D302: an API model in a project gets the non-destructive project tools, when its catalog
      // row says it can call tools; a CLI uses its own, under its provider's permission preset.
      // A node set to Read only (D342) is not offered the writing ones.
      const readOnlyNode =
        node.kind === 'agent' && agentWorkspaceOf(node.config).access === 'read_only';
      const offered =
        workspace !== undefined && !cli && catalogRow?.supportsTools === true
          ? chatToolsFrom(deps.tools).filter(
              (tool) => !readOnlyNode || !PROJECT_WRITING_TOOLS.includes(tool.definition.name),
            )
          : [];
      toolsOffered = offered.length > 0;

      const providerRow = await repository.providers
        .get(scope, chosen.providerId)
        .catch(() => null);
      pricedProvider = providerRow ?? undefined;

      /*
       * D386: an agentic node on a coding-agent CLI, in a project folder, works at its own access
       * level, as its runs do (D383) — never under the provider's preset, which may edit. An Off
       * node sends nothing and keeps the preset.
       */
      const cliAccess: GenerateRequest['cliAccess'] =
        cli && workspace !== undefined && node.kind === 'agent' && isAgentic(node.config)
          ? {
              access: agentWorkspaceOf(node.config).access,
              allowedCommands: [...agentWorkspaceOf(node.config).allowedCommands],
            }
          : undefined;

      /*
       * What the turn may do in the project folder, for the rules it is told: an API model by the
       * tools on offer, a CLI by the node's own level (D386) or else its provider's preset. A turn
       * that can write is told to do the work in the files, so the person finds it in Forge rather
       * than pasted into the reply.
       */
      const folderAccess: WorkspaceAccess | undefined =
        workspace === undefined
          ? undefined
          : cliAccess !== undefined
            ? cliAccess.access
            : cli
              ? (providerRow?.cliPermission ?? DEFAULT_CLI_PERMISSION) === 'read_only'
                ? 'read_only'
                : 'edit_files'
              : !toolsOffered
                ? undefined
                : offered.some((tool) => PROJECT_WRITING_TOOLS.includes(tool.definition.name))
                  ? 'edit_files'
                  : 'read_only';

      const prompt = buildChatPrompt({
        conversationId: nextId(),
        nodeId: node.id,
        instructions:
          folderAccess === undefined || workspace === undefined
            ? instructions
            : agentSystemPrompt({
                instructions,
                workspaceRoot: workspace,
                os: process.platform,
                shell: 'the system shell',
                access: folderAccess,
                ownTools: cli,
                chat: true,
              }),
        inputTypes: node.config.inputTypes,
        budgetTokens,
        // A failed turn is the engine speaking, not the model: it is never replayed as its answer.
        history: history.filter((message) => message.error === undefined),
        userParts,
        ...(reverted.length === 0 ? {} : { note: revertedFilesNote(reverted) }),
        now: now(),
        speakers: {
          names: await namesOf(context.workflowId),
          mainNodeId: context.mainNodeId,
          selfNodeId: node.id,
        },
      });

      /*
       * D300/D302, PG-2.4 (D361): a turn that can write and whose checkpoint could not begin
       * stops here, before any model call or tool runs, unless the person chose Run without undo.
       */
      if (checkpointFailure !== undefined) {
        // A writing turn: a CLI node at its own level (D386) unless that is Read only; otherwise a
        // write tool on offer, a node set up to write (as a run judges it), or a CLI whose preset
        // may edit.
        const writes =
          cliAccess !== undefined
            ? cliAccess.access !== 'read_only'
            : offered.some((tool) => PROJECT_WRITING_TOOLS.includes(tool.definition.name)) ||
              nodeWrites(node, () => providerRow ?? undefined) ||
              (cli && (providerRow?.cliPermission ?? DEFAULT_CLI_PERMISSION) !== 'read_only');
        logger.warn(
          {
            subsystem: 'chat',
            threadId,
            reason: checkpointFailure,
            writes,
            withoutUndo: context.withoutUndo === true,
          },
          'chat checkpoint did not start',
        );
        if (writes && context.withoutUndo !== true) {
          throw new TurnRefusal({
            kind: 'workflow',
            code: 'checkpoint_unavailable',
            message: undoUnavailableMessage(checkpointFailure, 'turn'),
            retryable: true,
          });
        }
      }

      /* PG-2.2: the day's budget is already spent — no call is made. */
      const caps = await capsFor(context.projectId, policy);
      if (caps.daily !== undefined && caps.daily.spentUsd >= caps.daily.capUsd) {
        throw new TurnRefusal(budgetError('daily', caps.daily.spentUsd, caps.daily.capUsd));
      }
      /** After every model call: has the turn crossed a cap? An unknown cost never counts as $0. */
      const checkBudget = (): void => {
        const spent = usageFor(tokensIn, tokensOut, pricing, pricedProvider);
        const costUsd = reportedCostUsd ?? spent.costUsd;
        const known = reportedCostUsd !== undefined || spent.costKnown !== false;
        if (!known) return;
        if (caps.turn !== undefined && costUsd > caps.turn) {
          throw new TurnRefusal(budgetError('turn', costUsd, caps.turn));
        }
        if (caps.daily !== undefined && caps.daily.spentUsd + costUsd > caps.daily.capUsd) {
          throw new TurnRefusal(
            budgetError('daily', caps.daily.spentUsd + costUsd, caps.daily.capUsd),
          );
        }
      };

      /* PG-2.2: the tool point on every chat tool call, with the run's ask_user approvals. */
      const offeredNames = offered.map((tool) => tool.definition.name);
      const allowedDomains = node.kind === 'agent' ? node.config.tools.allowedDomains : [];
      const beforeTool =
        guardrails === undefined || policy === null
          ? undefined
          : async (
              tool: (typeof offered)[number],
              call: ChatToolRequest,
            ): Promise<ChatToolStep> => {
              const point = evaluateChatTool(
                policy,
                {
                  definition: tool.definition,
                  args: call.args,
                  enabledTools: offeredNames,
                  sandboxDir: workspace ?? '',
                  allowedDomains,
                },
                guardrails,
              );
              toolVerdicts.push(...point.verdicts);
              if (point.kind === 'allow') return { kind: 'allow' };
              if (point.kind === 'block') {
                return { kind: 'refuse', status: 'blocked', reason: point.reason };
              }
              const decision = await askApproval({
                threadId,
                node,
                check: point.check,
                reason: point.reason,
                call,
                signal: stopSignal,
              });
              if (decision.decision === 'approve') return { kind: 'allow' };
              const note = decision.note === undefined ? '' : ` (${decision.note})`;
              return {
                kind: 'refuse',
                status: 'refused',
                reason: `a reviewer rejected this tool call${note}: ${point.reason}`,
              };
            };

      const { reasoningEffort } = node.config.execution;

      /** One model call, inside this provider's concurrency gate (FR-PRV-009). */
      const turn = (options: {
        tools?: ToolDefinition[];
        toolResults?: ToolResult[];
      }): Promise<ChatToolRequest[]> =>
        deps.runGated(chosen.providerId, async () => {
          // PG-1.6: a stop aborts the call in flight, as the node's own clock does.
          const signal =
            timeoutMs > 0
              ? AbortSignal.any([stopSignal, AbortSignal.timeout(timeoutMs)])
              : stopSignal;
          // No `runId`: a chat belongs to no run (FR-CHAT-005); `turnId` names the turn instead.
          const stream = adapter.generate(
            {
              modelId: chosen.modelId,
              system: prompt.system,
              prompt: prompt.text,
              outputTypes: ['text'],
              temperature: node.config.execution.temperature,
              maxTokens: node.config.execution.maxTokens,
              // D389: only when the node sets one; unset, the request is what it always was.
              ...(reasoningEffort === undefined || reasoningEffort === null
                ? {}
                : { reasoningEffort }),
              turnId: replyId,
              // D302: a CLI works in the project under its preset; without a folder it is read-only.
              ...(workspace === undefined ? {} : { workingDir: workspace }),
              // D386: …or, for an agentic node, at the node's own level.
              ...(cliAccess === undefined ? {} : { cliAccess }),
              ...(options.tools === undefined ? {} : { tools: options.tools }),
              ...(options.toolResults === undefined ? {} : { toolResults: options.toolResults }),
            },
            signal,
          );

          const requested: ChatToolRequest[] = [];
          /** D387: this call's own words and whether it reported usage, for its estimate. */
          let callText = '';
          let callReported = false;
          for await (const chunk of stream as AsyncIterable<StreamChunk>) {
            // PG-1.6: an adapter that does not watch its signal is left at the first chunk after a stop.
            if (stopSignal.aborted) break;
            if (chunk.type === 'text') {
              text += chunk.delta;
              callText += chunk.delta;
              tokens.push(chunk.delta);
            } else if (chunk.type === 'usage') {
              callReported = true;
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
          if (!stopSignal.aborted) {
            /*
             * D387: a call that ended with no usage chunk is estimated as a run's is (D313) —
             * characters ÷ 4 on what it was sent (system and prompt) and on what it wrote — so the
             * caps and the usage see it. A reported zero stays a reported zero.
             */
            if (!callReported) {
              estimated = true;
              tokensIn += estimateTokens(`${prompt.system}${prompt.text}`);
              tokensOut += estimateTokens(callText);
            }
            // PG-2.2: a turn over its cap makes no further call and runs no tool it asked for.
            checkBudget();
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
          allowedDomains,
          ...(workspace === undefined ? {} : { projectDir: workspace }),
          signal: stopSignal,
        },
        turn,
        activity,
        onCall: (tool, status) =>
          logger.info({ subsystem: 'chat', threadId, tool, status }, 'chat tool call'),
        ...(judge === undefined ? {} : { judge }),
        ...(beforeTool === undefined ? {} : { beforeTool }),
      });
      limitReached = loop.limitReached;
      // PG-1.6: an adapter that finished despite the stop still ends as the stop the person asked for.
      if (stopSignal.aborted) throw new Error('stopped');
      // D287: a result the context point blocked ends the turn as a stored error, with its reason.
      if (loop.blocked !== undefined) failure = loop.blocked;
    } catch (error) {
      failure = stopSignal.aborted
        ? cancelledError()
        : error instanceof TurnRefusal
          ? error.nodeError
          : classifyError(error, { providerId: chosen.providerId });
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

    // PG-1.4 (D359): the run's cost rule — local is $0, an unpriced remote model's cost is unknown.
    const priced = usageFor(tokensIn, tokensOut, pricing, pricedProvider);
    const reported =
      reportedCostUsd === undefined ? priced : withReportedCost(priced, reportedCostUsd);
    // D387: marked as an estimate, as a run's is (D313); a reported usage keeps its shape.
    const usage: Usage = estimated ? { ...reported, source: 'estimated' } : reported;

    if (failure !== undefined) {
      logger.warn(
        { subsystem: 'chat', threadId, code: failure.code, kind: failure.kind },
        'chat reply failed',
      );
      // R-1: a failed turn may never have told the model, so the next turn tells it again
      if (reverted.length > 0) deps.checkpoints?.restoreRevertedPaths?.(threadId, reverted);
      progress.reverted = [];
      return store(failedTurn(threadId, failure, { usage, ...failedExtra }, replyId), () => {
        progress.appended = true;
      });
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

    // Told the model now: a throw from here on must not tell it again.
    progress.reverted = [];
    return store(
      {
        id: replyId,
        threadId,
        role: 'agent',
        content: replyParts,
        verdicts,
        usage,
        at: now(),
        ...(answeredBy === undefined ? {} : { modelId: answeredBy }),
        ...extra,
      },
      () => {
        progress.appended = true;
      },
    );
  }

  /** The thread and its own node, for a message action (PG-1.6). */
  async function threadWithNode(threadId: Id): Promise<{
    thread: ChatThread;
    owner: ResolvedChatNode & { node: ChatNode };
  }> {
    const thread = await repository.chatThreads.get(scope, threadId);
    if (thread === null) throw new ChatThreadNotFoundError(threadId);
    const owner = await deps.resolveNode(thread.nodeId);
    if (owner === null) throw new ChatNodeNotFoundError(thread.nodeId);
    if (owner.node.kind !== 'agent' && owner.node.kind !== 'model') {
      throw new NotAnAgentNodeError(thread.nodeId);
    }
    return { thread, owner: { ...owner, node: owner.node } };
  }

  /**
   * The node that answers a re-run turn (PG-1.6): the one that answered it before — an `@handle`
   * target is kept — when it is still an agent or model node of the same workflow; otherwise the
   * thread's own node.
   */
  async function speakerFor(
    speakerNodeId: Id | undefined,
    owner: ResolvedChatNode & { node: ChatNode },
  ): Promise<ChatNode> {
    if (speakerNodeId === undefined || speakerNodeId === owner.node.id) return owner.node;
    const speaker = await deps.resolveNode(speakerNodeId);
    if (
      speaker === null ||
      speaker.workflowId !== owner.workflowId ||
      (speaker.node.kind !== 'agent' && speaker.node.kind !== 'model')
    ) {
      return owner.node;
    }
    return speaker.node;
  }

  /** Start one reply (shared by `chat`, retry and edit): route, policy, folder, then generate. */
  async function beginReply(options: {
    node: ChatNode;
    thread: ChatThread;
    owner: ResolvedChatNode;
    userMessage: ChatMessage;
    guardrails: ChatGuardrailDeps | undefined;
    policy: Awaited<ReturnType<PolicyService['resolve']>> | null;
    chosen: ModelUsed;
    historyBefore?: Id;
    withoutUndo?: boolean;
  }): Promise<ChatBegun> {
    const { thread, owner, userMessage } = options;
    const done = generateReply({
      node: options.node,
      mainNodeId: thread.nodeId,
      workflowId: owner.workflowId,
      projectId: owner.projectId,
      workspace: await workspaceOf(owner.projectId),
      chosen: options.chosen,
      policy: options.policy,
      threadId: thread.id,
      userMessageId: userMessage.id,
      userParts: userMessage.content,
      guardrails: options.guardrails,
      ...(options.historyBefore === undefined ? {} : { historyBefore: options.historyBefore }),
      ...(options.withoutUndo === true ? { withoutUndo: true } : {}),
    });
    // The gateway answers 202 and does not await the reply. `generateReply` already stores a
    // failed turn for any throw (PG-1.5); what still reaches here is a turn that could not be
    // stored at all, which is logged rather than left an unhandled rejection.
    done.catch((error: unknown) => {
      logger.error({ subsystem: 'chat', err: error, threadId: thread.id }, 'chat reply failed');
    });
    return { threadId: thread.id, messageId: userMessage.id, done };
  }

  return {
    async listApprovals(threadId) {
      const thread = await repository.chatThreads.get(scope, threadId);
      if (thread === null) throw new ChatThreadNotFoundError(threadId);
      return [...chatApprovals.values()]
        .map((pending) => pending.request)
        .filter((request) => request.threadId === threadId);
    },

    decideApproval: (threadId, requestId, kind, note) =>
      settleApproval(threadId, requestId, kind, note),

    async retryMessage(threadId, messageId, options = {}) {
      const { thread, owner } = await threadWithNode(threadId);
      const messages = await repository.chatMessages.listByThread(scope, threadId);
      const target = messages.find((message) => message.id === messageId);
      if (target === undefined || target.deletedAt !== undefined) {
        throw new ChatMessageNotFoundError(threadId, messageId);
      }
      if (target.role !== 'agent') {
        throw new ChatActionInvalidError('Only an agent reply or a failed turn can be retried.');
      }
      if (target.supersededAt !== undefined) {
        throw new ChatActionInvalidError('This turn was already replaced by a newer version.');
      }
      // The question it answered: the last standing user turn before it.
      const question = messages
        .filter((message) => message.role === 'user' && message.id < target.id && standing(message))
        .at(-1);
      if (question === undefined) {
        throw new ChatActionInvalidError('There is no question before this turn to ask again.');
      }

      const node = await speakerFor(target.speakerNodeId, owner);
      const chosen = routeFor(node);
      const policy =
        deps.policies === undefined ? null : await deps.policies.resolve(owner.projectId, node);

      await markAndAnnounce(target, { supersededAt: now() });
      return beginReply({
        node,
        thread,
        owner,
        userMessage: question,
        guardrails: guardrailDeps(),
        policy,
        chosen,
        historyBefore: target.id,
        ...(options.withoutUndo === true ? { withoutUndo: true } : {}),
      });
    },

    async editMessage(threadId, messageId, content) {
      const { thread, owner } = await threadWithNode(threadId);
      const messages = await repository.chatMessages.listByThread(scope, threadId);
      const target = messages.find((message) => message.id === messageId);
      if (target === undefined || target.deletedAt !== undefined) {
        throw new ChatMessageNotFoundError(threadId, messageId);
      }
      if (target.role !== 'user') {
        throw new ChatActionInvalidError('Only your own messages can be edited and resent.');
      }
      if (target.supersededAt !== undefined) {
        throw new ChatActionInvalidError('This message was already replaced by a newer version.');
      }

      // Whoever answered it answers the new version.
      const answered = messages.find(
        (message) => message.role === 'agent' && message.id > target.id && standing(message),
      );
      const node = await speakerFor(answered?.speakerNodeId, owner);
      const chosen = routeFor(node);
      const policy =
        deps.policies === undefined ? null : await deps.policies.resolve(owner.projectId, node);

      /* Input point first (FR-CHAT-008): a blocked edit changes nothing, only the 422. */
      const guardrails = guardrailDeps();
      let inputParts: Part[] = [...content];
      let inputVerdicts: ChatVerdict[] = [];
      if (guardrails !== undefined) {
        const checked = evaluateChatInput(policy, content, guardrails);
        if (checked.kind === 'blocked') {
          throw new ChatInputBlockedError(checked.verdicts, checked.reason);
        }
        inputParts = checked.parts;
        inputVerdicts = checked.verdicts;
      }

      /* The message and every standing turn after it are the earlier version now. */
      const at = now();
      for (const message of messages) {
        if (message.id >= target.id && standing(message)) {
          await markAndAnnounce(message, { supersededAt: at });
        }
      }

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
      return beginReply({
        node,
        thread,
        owner,
        userMessage,
        guardrails,
        policy,
        chosen,
      });
    },

    async deleteMessage(threadId, messageId) {
      const thread = await repository.chatThreads.get(scope, threadId);
      if (thread === null) throw new ChatThreadNotFoundError(threadId);
      const messages = await repository.chatMessages.listByThread(scope, threadId);
      const target = messages.find((message) => message.id === messageId);
      if (target === undefined) throw new ChatMessageNotFoundError(threadId, messageId);
      // Deleting twice is still deleted: nothing to announce.
      if (target.deletedAt !== undefined) return;
      await markAndAnnounce(target, { deletedAt: now() });
    },

    async stopThread(threadId) {
      const thread = await repository.chatThreads.get(scope, threadId);
      if (thread === null) throw new ChatThreadNotFoundError(threadId);
      const running = inFlight.get(threadId);
      if (running === undefined || running.size === 0) return { stopped: false };
      for (const controller of running) controller.abort();
      return { stopped: true };
    },

    async recoverOpenTurns() {
      let closed = 0;
      for (const thread of await repository.chatThreads.list(scope)) {
        // Each user turn is owed one agent turn; replies land in order behind them. A superseded
        // turn was replaced (its replacement is counted instead); a deleted one still happened.
        let owed = 0;
        for (const message of await repository.chatMessages.listByThread(scope, thread.id)) {
          if (message.supersededAt !== undefined) continue;
          if (message.role === 'user') owed += 1;
          else if (owed > 0) owed -= 1;
        }
        for (; owed > 0; owed -= 1) {
          await store(failedTurn(thread.id, openTurnError()));
          closed += 1;
        }
      }
      if (closed > 0) logger.warn({ subsystem: 'chat', closed }, 'closed chat turns left open');
      return closed;
    },

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

      return beginReply({
        node,
        thread,
        owner: { node: owner, projectId, workflowId },
        userMessage,
        guardrails,
        policy,
        chosen,
        ...(request.withoutUndo === true ? { withoutUndo: true } : {}),
      });
    },

    listThreads: (nodeId) => repository.chatThreads.listByNode(scope, nodeId),

    async getThread(threadId) {
      const thread = await repository.chatThreads.get(scope, threadId);
      if (thread === null) throw new ChatThreadNotFoundError(threadId);
      const messages = await repository.chatMessages.listByThread(scope, threadId);
      // PG-1.6 (D352): a deleted turn is left out; a superseded one stays, as an earlier version.
      return {
        thread,
        messages: messages.filter((message) => message.deletedAt === undefined),
      };
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
        // D378: whether it answered or failed, what the step did in the folder is reviewable.
        ...(turn.activity === undefined || turn.activity.length === 0
          ? {}
          : { activity: turn.activity }),
        ...(turn.checkpointId === undefined ? {} : { checkpointId: turn.checkpointId }),
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
