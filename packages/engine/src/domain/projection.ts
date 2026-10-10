import {
  AUTO_EXCERPT_CHARS,
  EdgeTransferPayloadSchema,
  EnvelopeRoutedPayloadSchema,
  EnvelopeSentPayloadSchema,
  GuardrailVerdictPayloadSchema,
  HumanMessagePayloadSchema,
  InstructionStatePayloadSchema,
  LoopIterationPayloadSchema,
  NodeApprovalDecidedPayloadSchema,
  NodeApprovalRequiredPayloadSchema,
  NodeErrorPayloadSchema,
  NodeInterruptedPayloadSchema,
  NodeOutputPayloadSchema,
  NodeStatePayloadSchema,
  RunBlockedPayloadSchema,
  RunCompletedPayloadSchema,
  RunConfigPayloadSchema,
  RunParkedPayloadSchema,
  RunTokenBudgetPayloadSchema,
  ToolCallPayloadSchema,
  UsageUpdatedPayloadSchema,
  type ArtifactRef,
  type DomainMessage,
  type DomainTurn,
  type FailureReason,
  type Id,
  type InstructionState,
  type NodeState,
  type Part,
  type ProviderType,
  type RunDomainConfig,
  type TurnOutcome,
  type Usage,
} from '@ace/contracts';

import type { EngineEvent } from '../ports/index.js';
import { labelOf, type DomainContext } from './context.js';

/**
 * The Domain projection (D303): one incremental fold of a run's event log into its conversation,
 * and the bookkeeping the usage snapshot and the team panel read. Fed the same events in the same
 * order it produces the same messages, so a page served over HTTP, an SSE stream resumed after a
 * reconnect and a replay of a recorded run all agree — and none of it is stored.
 *
 * Every message has a cursor `<seq>.<index>`: the event that created it, and its place among the
 * messages that event created. An update keeps the message's cursor and replaces it whole.
 */

export type ChatOp =
  { op: 'append'; message: DomainMessage } | { op: 'update'; message: DomainMessage };

/** One turn's usage, as `usage.updated.turn` (or, before Domain, `node.output`) recorded it. */
export interface TurnUsage {
  nodeRunId: Id;
  nodeId: Id;
  providerType?: ProviderType;
  modelIds: (string | undefined)[];
  usage: Usage;
}

export interface DomainProjection {
  /** Fold one event in; returns the messages it appended or changed, in order. */
  apply(event: EngineEvent): ChatOp[];
  /** The conversation so far, in cursor order. */
  messages(): DomainMessage[];
  /** The highest `seq` folded. */
  lastSeq(): number;
  /** Each node's latest state; a node with no node run yet is absent. */
  nodeStates(): Record<Id, NodeState>;
  /** What each node is doing, in a few words, for the team panel. */
  activity(nodeId: Id): string;
  /** Every turn's usage, in the order the turns were recorded. */
  turnUsage(): TurnUsage[];
  config(): RunDomainConfig | null;
  /** The run's token budget limit, as last set; null without one. */
  budgetLimit(): number | null;
  /** Human-message deliveries still PENDING, by node — what a run-domain rebuild re-queues. */
  pending(): { messageId: Id; nodeId: Id }[];
  /** The run has ended (`run.completed`). */
  ended(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

function partText(part: Part): string {
  switch (part.type) {
    case 'text':
    case 'code':
      return part.text;
    case 'json':
      return JSON.stringify(part.value ?? null);
    default:
      return `[${part.type}: ${part.name}]`;
  }
}

/** D327: the first ~280 characters of an output, cut at a word where it can be. */
export function autoExcerpt(parts: readonly Part[]): string {
  const text = parts.map(partText).join('\n').trim();
  if (text.length <= AUTO_EXCERPT_CHARS) return text;
  const cut = text.slice(0, AUTO_EXCERPT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > AUTO_EXCERPT_CHARS * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** D307: the files a turn produced, as references — commit stays null until checkpoints exist. */
export function artifactRefs(parts: readonly Part[]): ArtifactRef[] {
  return parts.flatMap((part) =>
    part.type === 'image' || part.type === 'audio' || part.type === 'video' || part.type === 'file'
      ? [{ path: part.name, bytes: part.size, commit: null, artifactId: part.artifactId }]
      : [],
  );
}

/**
 * D307: the file-writing tools of the coding CLIs, as their activity is named (`cli_` + snake case):
 * Claude Code's Write, Edit, MultiEdit and NotebookEdit, Gemini's write_file and replace, and
 * Codex's file_change. A turn that ran one of them produced that file.
 */
const CLI_FILE_WRITES: ReadonlySet<string> = new Set([
  'cli_write',
  'cli_edit',
  'cli_multi_edit',
  'cli_notebook_edit',
  'cli_write_file',
  'cli_replace',
  'cli_file_change',
]);

/** The paths a CLI file write names: `file_path` / `notebook_path`, or Codex's `changes[].path`. */
export function writtenPaths(toolName: string, args: unknown): string[] {
  if (!CLI_FILE_WRITES.has(toolName) || typeof args !== 'object' || args === null) return [];
  const record = args as Record<string, unknown>;
  const direct = [record['file_path'], record['notebook_path']].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const changes = Array.isArray(record['changes'])
    ? (record['changes'] as unknown[]).flatMap((change) => {
        const path = (change as { path?: unknown } | null)?.path;
        return typeof path === 'string' && path !== '' ? [path] : [];
      })
    : [];
  return [...direct, ...changes];
}

/** Refs joined, each path once, the first kept. */
function mergeRefs(
  current: readonly ArtifactRef[] | undefined,
  more: readonly ArtifactRef[],
): ArtifactRef[] {
  const merged = [...(current ?? [])];
  for (const ref of more) {
    if (!merged.some((each) => each.path === ref.path && each.artifactId === ref.artifactId)) {
      merged.push(ref);
    }
  }
  return merged;
}

const OUTCOME_BY_STATE: Partial<Record<NodeState, TurnOutcome>> = {
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  COMPLETED: 'OK',
  FAILED: 'FAILED',
  BLOCKED: 'FAILED',
  STOPPED: 'STOPPED',
};

/** A step's line in the conversation: the tool and the start of what it returned. */
const STEP_LABEL_CHARS = 120;

const TERMINAL: ReadonlySet<NodeState> = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED']);

/* -------------------------------------------------------------------------- */
/* The fold                                                                    */
/* -------------------------------------------------------------------------- */

export function createDomainProjection(context: DomainContext): DomainProjection {
  const runId = context.runId;
  const label = (nodeId: Id): string => labelOf(context, nodeId);
  const brainId = context.roster.find((entry) => entry.brain)?.nodeId;
  const authorOf = (nodeId: Id): DomainMessage['author'] => ({
    kind: nodeId === brainId ? 'brain' : 'node',
    nodeId,
  });

  const byId = new Map<string, DomainMessage>();
  const order: string[] = [];
  let seq = 0;
  let index = 0;
  let at = '';

  const nodeStates = new Map<Id, NodeState>();
  const turnStartedAt = new Map<Id, number>();
  const interrupted = new Set<Id>();
  const lastTool = new Map<Id, string>();
  const lastOutput = new Map<Id, Part[]>();
  const awaitingApproval = new Map<Id, string>();
  const openQueries = new Map<Id, { envelopeId: Id; to: Id[] }>();
  const turnUsage = new Map<Id, TurnUsage>();
  const legacyUsage = new Map<Id, TurnUsage>();
  let hasTurnUsage = false;
  let runConfig: RunDomainConfig | null = null;
  let budgetLimit: number | null = null;
  let parked = false;
  let blocked: string | undefined;
  let ended = false;

  function append(message: Omit<DomainMessage, 'cursor' | 'runId' | 'at'>, ops: ChatOp[]): void {
    const full: DomainMessage = { ...message, runId, cursor: `${seq}.${index}`, at };
    index += 1;
    byId.set(full.id, full);
    order.push(full.id);
    ops.push({ op: 'append', message: full });
  }

  function update(
    id: string,
    change: (message: DomainMessage) => DomainMessage,
    ops: ChatOp[],
  ): void {
    const current = byId.get(id);
    if (current === undefined) return;
    const next = change(current);
    byId.set(id, next);
    // One event touching a message twice sends it once, as it ends up.
    const already = ops.findIndex((op) => op.message.id === id);
    if (already >= 0) ops[already] = { op: ops[already]?.op ?? 'update', message: next };
    else ops.push({ op: 'update', message: next });
  }

  function system(
    text: string,
    ops: ChatOp[],
    extra: Partial<Pick<DomainMessage, 'level' | 'to'>> & { nodeId?: Id } = {},
  ): void {
    const { nodeId, ...rest } = extra;
    append(
      {
        id: `sys:${seq}.${index}`,
        author: { kind: 'system', ...(nodeId === undefined ? {} : { nodeId }) },
        type: 'system',
        text,
        ...rest,
      },
      ops,
    );
  }

  const turnMessageId = (nodeRunId: Id): string => `turn:${nodeRunId}`;

  function updateTurn(
    nodeRunId: Id,
    change: (turn: DomainTurn) => Partial<DomainTurn>,
    ops: ChatOp[],
  ) {
    update(
      turnMessageId(nodeRunId),
      (message) =>
        message.turn === undefined
          ? message
          : { ...message, turn: { ...message.turn, ...change(message.turn) } },
      ops,
    );
  }

  function setDeliveries(
    messageId: Id,
    ops: ChatOp[],
    change: (state: InstructionState, nodeId: Id) => InstructionState,
  ) {
    const current = byId.get(messageId)?.delivery;
    // Nothing moved: no update goes out.
    if (
      current === undefined ||
      current.every((entry) => change(entry.state, entry.nodeId) === entry.state)
    ) {
      return;
    }
    update(
      messageId,
      (message) =>
        message.delivery === undefined
          ? message
          : {
              ...message,
              delivery: message.delivery.map((entry) => ({
                ...entry,
                state: change(entry.state, entry.nodeId),
              })),
            },
      ops,
    );
  }

  const handlers: Record<string, (payload: unknown, ops: ChatOp[]) => void> = {
    'run.started': (_payload, ops) => {
      system('Run started.', ops);
    },

    'run.config': (payload, ops) => {
      const parsed = RunConfigPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      runConfig = parsed.data.config;
      budgetLimit = runConfig.tokenBudget;
      const parts = [
        runConfig.routing === 'manual'
          ? 'Manual routing: every envelope waits for your decision.'
          : 'Supervised routing: the Brain forwards envelopes.',
        `Loop guard: ${runConfig.loopGuardLimit} round trips per pair.`,
        runConfig.tokenBudget === null
          ? 'No token budget.'
          : `Token budget: ${runConfig.tokenBudget.toLocaleString('en-US')} tokens.`,
      ];
      if (runConfig.stayOpen)
        parts.push('The run stays open after the graph finishes; End it when done.');
      system(parts.join(' '), ops);
    },

    'human.message': (payload, ops) => {
      const parsed = HumanMessagePayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const message = parsed.data;
      const to = message.mentions.map((mention) => mention.nodeId);
      append(
        {
          id: message.messageId,
          author: { kind: 'human' },
          type: 'human',
          text: message.text,
          ...(message.addressing === 'goal' ? {} : { to }),
          ...(message.addressing === 'goal'
            ? {}
            : { delivery: to.map((nodeId) => ({ nodeId, state: 'PENDING' as const })) }),
        },
        ops,
      );
    },

    'instruction.state': (payload, ops) => {
      const parsed = InstructionStatePayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const { messageId, nodeId, state } = parsed.data;
      setDeliveries(messageId, ops, (current, each) => (each === nodeId ? state : current));
    },

    'node.state': (payload, ops) => {
      const parsed = NodeStatePayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const state = parsed.data;
      nodeStates.set(state.nodeId, state.status);
      const messageId = turnMessageId(state.nodeRunId);

      if (state.status === 'RUNNING') {
        if (!byId.has(messageId)) {
          turnStartedAt.set(state.nodeRunId, Date.parse(at));
          lastTool.delete(state.nodeId);
          // A new turn of the asker means its question was answered (or given up on).
          openQueries.delete(state.nodeId);
          append(
            {
              id: messageId,
              author: authorOf(state.nodeId),
              type: 'agent',
              text: '',
              turn: {
                turnId: state.nodeRunId,
                trigger: state.trigger?.kind ?? 'dispatch',
                iteration: state.iteration,
                attempt: state.attempt,
                steps: [],
                outcome: 'RUNNING',
              },
            },
            ops,
          );
        } else {
          awaitingApproval.delete(state.nodeId);
          updateTurn(state.nodeRunId, () => ({ outcome: 'RUNNING' }), ops);
        }
        return;
      }

      if (state.status === 'WAITING') {
        updateTurn(state.nodeRunId, () => ({ outcome: 'WAITING' }), ops);
        return;
      }

      if (!TERMINAL.has(state.status)) return;

      if (!byId.has(messageId)) {
        // Never ran: BLOCKED because something upstream failed, or STOPPED before it started.
        if (state.status === 'BLOCKED') {
          system(`${label(state.nodeId)} is BLOCKED: a node it depends on did not finish.`, ops, {
            nodeId: state.nodeId,
            level: 'warn',
          });
        }
        return;
      }

      awaitingApproval.delete(state.nodeId);
      const began = turnStartedAt.get(state.nodeRunId);
      const durationMs =
        state.durationMs ?? (began === undefined ? undefined : Math.max(0, Date.parse(at) - began));
      const outcome: TurnOutcome =
        state.status === 'STOPPED' && interrupted.has(state.nodeRunId)
          ? 'INTERRUPTED'
          : (OUTCOME_BY_STATE[state.status] ?? 'FAILED');
      updateTurn(
        state.nodeRunId,
        () => ({
          outcome,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(state.failureReason === undefined
            ? state.status === 'BLOCKED'
              ? { failureReason: 'BLOCKED' as FailureReason }
              : {}
            : { failureReason: state.failureReason }),
        }),
        ops,
      );
    },

    'tool.call': (payload, ops) => {
      const parsed = ToolCallPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const { toolCall, nodeRunId } = parsed.data;
      const message = byId.get(turnMessageId(nodeRunId));
      if (message?.author.nodeId !== undefined)
        lastTool.set(message.author.nodeId, toolCall.toolName);
      const summary = toolCall.resultSummary.replace(/\s+/g, ' ').trim();
      const step = {
        id: toolCall.id,
        label:
          summary === ''
            ? toolCall.toolName
            : `${toolCall.toolName}: ${summary.length > STEP_LABEL_CHARS ? `${summary.slice(0, STEP_LABEL_CHARS)}…` : summary}`,
        status: toolCall.status,
        durationMs: toolCall.durationMs,
        at: toolCall.at,
      };
      updateTurn(nodeRunId, (turn) => ({ steps: [...turn.steps, step] }), ops);
      // D307: a file the CLI wrote is one of the turn's artifacts.
      const written =
        toolCall.status === 'ok'
          ? writtenPaths(toolCall.toolName, toolCall.args).map((path): ArtifactRef => ({
              path,
              bytes: null,
              commit: null,
            }))
          : [];
      if (written.length > 0) {
        update(
          turnMessageId(nodeRunId),
          (current) => ({ ...current, artifacts: mergeRefs(current.artifacts, written) }),
          ops,
        );
      }
    },

    'node.output': (payload, ops) => {
      const parsed = NodeOutputPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const output = parsed.data;
      lastOutput.set(output.nodeId, output.output);
      legacyUsage.set(output.nodeRunId, {
        nodeRunId: output.nodeRunId,
        nodeId: output.nodeId,
        ...(output.modelUsed === undefined
          ? {}
          : (() => {
              const type = context.providerTypes?.get(output.modelUsed.providerId);
              return type === undefined ? {} : { providerType: type };
            })()),
        modelIds: [output.modelUsed?.resolvedModelId, output.modelUsed?.modelId],
        usage: { ...output.usage, source: output.usage.source ?? 'reported' },
      });
      const artifacts = artifactRefs(output.output);
      update(
        turnMessageId(output.nodeRunId),
        (message) => ({
          ...message,
          output: output.output,
          ...(message.textSource === 'summary'
            ? {}
            : { text: autoExcerpt(output.output), textSource: 'auto' as const }),
          ...(artifacts.length === 0 ? {} : { artifacts: mergeRefs(message.artifacts, artifacts) }),
        }),
        ops,
      );
    },

    'node.error': (payload, ops) => {
      const parsed = NodeErrorPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const failure = parsed.data;
      update(
        turnMessageId(failure.nodeRunId),
        (message) => ({
          ...message,
          ...(message.text === ''
            ? { text: failure.error.message.slice(0, AUTO_EXCERPT_CHARS) }
            : {}),
          ...(message.turn === undefined
            ? {}
            : {
                turn: {
                  ...message.turn,
                  error: failure.error.message,
                  failureReason: failure.failureReason,
                },
              }),
        }),
        ops,
      );
    },

    'node.interrupted': (payload, ops) => {
      const parsed = NodeInterruptedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const stopped = parsed.data;
      interrupted.add(stopped.nodeRunId);
      update(
        turnMessageId(stopped.nodeRunId),
        (message) => ({
          ...message,
          output: stopped.partialOutput,
          text: autoExcerpt(stopped.partialOutput),
          textSource: 'auto',
          ...(message.turn === undefined
            ? {}
            : { turn: { ...message.turn, outcome: 'INTERRUPTED' } }),
        }),
        ops,
      );
    },

    'envelope.sent': (payload, ops) => {
      const parsed = EnvelopeSentPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const envelope = parsed.data;
      // FR-MM-004: the engine keeps file refs out of the log; a HANDOFF carries its turn's files.
      const artifacts =
        envelope.artifacts.length > 0 || envelope.kind !== 'HANDOFF'
          ? envelope.artifacts
          : artifactRefs(byId.get(turnMessageId(envelope.nodeRunId))?.output ?? []);
      if (envelope.kind === 'QUERY') {
        openQueries.set(envelope.fromNodeId, {
          envelopeId: envelope.envelopeId,
          to: envelope.toNodeIds,
        });
      }
      append(
        {
          id: `env:${envelope.envelopeId}`,
          author: authorOf(envelope.fromNodeId),
          type: 'envelope',
          text: envelope.summary,
          textSource: envelope.textSource,
          to: envelope.toNodeIds,
          envelope: {
            id: envelope.envelopeId,
            kind: envelope.kind,
            from: envelope.fromNodeId,
            ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
            history: [],
          },
          ...(artifacts.length === 0 ? {} : { artifacts }),
        },
        ops,
      );
      // D327: a turn's chat text is its envelope's summary, when the agent wrote one.
      if (envelope.textSource === 'summary') {
        update(
          turnMessageId(envelope.nodeRunId),
          (message) =>
            message.textSource === 'summary'
              ? message
              : { ...message, text: envelope.summary, textSource: 'summary' },
          ops,
        );
      }
    },

    'envelope.routed': (payload, ops) => {
      const parsed = EnvelopeRoutedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const routed = parsed.data;
      const id = `env:${routed.envelopeId}`;
      update(
        id,
        (message) => {
          if (message.envelope === undefined) return message;
          const step = {
            decision: routed.decision,
            by: routed.by,
            ...(routed.reason === undefined ? {} : { reason: routed.reason }),
            at,
          };
          const edited = routed.decision === 'EDITED' && routed.edit !== undefined;
          return {
            ...message,
            ...(edited && routed.edit?.summary !== undefined ? { text: routed.edit.summary } : {}),
            ...(edited && routed.edit?.toNodeIds !== undefined
              ? { to: routed.edit.toNodeIds }
              : {}),
            envelope: {
              ...message.envelope,
              ...(edited && routed.edit?.kind !== undefined ? { kind: routed.edit.kind } : {}),
              routing: routed.decision,
              history: [...message.envelope.history, step],
              ...(edited && message.envelope.original === undefined
                ? {
                    original: {
                      kind: message.envelope.kind,
                      to: message.to ?? [],
                      summary: message.text,
                    },
                  }
                : {}),
            },
          };
        },
        ops,
      );
      const envelope = byId.get(id);
      if (
        routed.by === 'brain' &&
        routed.decision !== 'FORWARDED' &&
        envelope?.envelope !== undefined
      ) {
        const what = `${envelope.envelope.kind} from ${label(envelope.envelope.from)} to ${(
          envelope.to ?? []
        )
          .map(label)
          .join(', ')}`;
        append(
          {
            id: `brain:${seq}.${index}`,
            author: { kind: 'brain', ...(brainId === undefined ? {} : { nodeId: brainId }) },
            type: 'brain',
            text:
              routed.decision === 'HELD'
                ? `Held ${what} for your decision${routed.reason === undefined ? '' : `: ${routed.reason}`}.`
                : `Rejected ${what}${routed.reason === undefined ? '' : `: ${routed.reason}`}.`,
            to: [envelope.envelope.from, ...(envelope.to ?? [])],
            level: 'warn',
          },
          ops,
        );
      }
    },

    'edge.transfer': (payload, ops) => {
      const parsed = EdgeTransferPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const transfer = parsed.data;
      // A team envelope already has its own message; this is only its delivery.
      if (transfer.envelopeId !== undefined) return;
      // Before Domain: a handoff along an edge, narrated from what the sender produced (D8, 'auto').
      const output = lastOutput.get(transfer.fromNodeId);
      append(
        {
          id: `xfer:${seq}.${index}`,
          author: authorOf(transfer.fromNodeId),
          type: 'envelope',
          text: output === undefined ? transfer.summary : autoExcerpt(output),
          textSource: 'auto',
          to: [transfer.toNodeId],
          envelope: {
            id: transfer.edgeId,
            kind: 'HANDOFF',
            from: transfer.fromNodeId,
            history: [],
          },
        },
        ops,
      );
    },

    'usage.updated': (payload) => {
      const parsed = UsageUpdatedPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.turn === undefined) return;
      const turn = parsed.data.turn;
      hasTurnUsage = true;
      turnUsage.set(turn.nodeRunId, {
        nodeRunId: turn.nodeRunId,
        nodeId: turn.nodeId,
        ...(turn.providerType === undefined ? {} : { providerType: turn.providerType }),
        modelIds: [turn.modelId],
        usage: turn.usage,
      });
    },

    'run.token_budget': (payload, ops) => {
      const parsed = RunTokenBudgetPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const budget = parsed.data;
      budgetLimit = budget.limit;
      const of = (n: number) => n.toLocaleString('en-US');
      if (budget.level === 'SET') {
        system(
          budget.limit === null
            ? 'Token budget removed.'
            : `Token budget set to ${of(budget.limit)} tokens (${of(budget.used)} used).`,
          ops,
        );
      } else if (budget.level === 'WARN') {
        system(
          `80% of the token budget used: ${of(budget.used)} of ${of(budget.limit ?? 0)} tokens.`,
          ops,
          { level: 'warn' },
        );
      } else {
        system(
          `Token budget exceeded: ${of(budget.used)} of ${of(budget.limit ?? 0)} tokens. No new turns start; turns in flight finish. Raise the budget or end the run.`,
          ops,
          { level: 'error' },
        );
      }
    },

    'run.blocked': (payload, ops) => {
      const parsed = RunBlockedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const block = parsed.data;
      blocked = block.reason;
      const who = (block.nodeIds ?? []).map(label).join(' and ');
      system(
        `Run BLOCKED (${block.reason}${who === '' ? '' : `: ${who}`}). ${block.detail} Resume or end the run.`,
        ops,
        { level: 'error', ...(block.nodeIds === undefined ? {} : { to: block.nodeIds }) },
      );
    },

    'run.parked': (payload, ops) => {
      const parsed = RunParkedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      parked = true;
      system(
        parsed.data.graph === 'complete'
          ? 'The graph has finished. The run stays open: address any node to continue, or End it.'
          : 'The graph stopped with failures. The run stays open: address a node to retry it, or End it.',
        ops,
        { level: parsed.data.graph === 'complete' ? 'info' : 'warn' },
      );
    },

    'run.paused': (_payload, ops) => system('Run paused: no new turns start.', ops),

    'run.resumed': (_payload, ops) => {
      blocked = undefined;
      system('Run resumed.', ops);
    },

    'node.approval_required': (payload, ops) => {
      const parsed = NodeApprovalRequiredPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const { request } = parsed.data;
      awaitingApproval.set(request.nodeId, request.reason);
      system(`${label(request.nodeId)} is waiting for your approval: ${request.reason}`, ops, {
        nodeId: request.nodeId,
        level: 'warn',
      });
    },

    'node.approval_decided': (payload, ops) => {
      const parsed = NodeApprovalDecidedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const nodeId = byId.get(turnMessageId(parsed.data.nodeRunId))?.author.nodeId;
      if (nodeId !== undefined) awaitingApproval.delete(nodeId);
      system(
        `${nodeId === undefined ? 'A node' : label(nodeId)}: ${
          parsed.data.decision.decision === 'approve' ? 'approved' : 'rejected'
        }${parsed.data.decision.note === undefined ? '' : ` — ${parsed.data.decision.note}`}.`,
        ops,
        nodeId === undefined ? {} : { nodeId },
      );
    },

    'guardrail.verdict': (payload, ops) => {
      const parsed = GuardrailVerdictPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const { verdict } = parsed.data;
      const nodeId = byId.get(turnMessageId(parsed.data.nodeRunId))?.author.nodeId;
      system(
        `Guardrail ${verdict.checkType} at ${verdict.point} (${verdict.action}) on ${
          nodeId === undefined ? 'a node' : label(nodeId)
        }: ${verdict.reason}`,
        ops,
        {
          level: verdict.action === 'block' ? 'error' : 'warn',
          ...(nodeId === undefined ? {} : { nodeId }),
        },
      );
    },

    'loop.iteration': (payload, ops) => {
      const parsed = LoopIterationPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const loop = parsed.data;
      system(
        loop.stop === undefined
          ? `Loop: ${label(loop.targetNodeId)} starts iteration ${loop.iteration}.`
          : `Loop stopped after iteration ${loop.iteration} (${loop.stop}).`,
        ops,
        { nodeId: loop.targetNodeId },
      );
    },

    'run.completed': (payload, ops) => {
      const parsed = RunCompletedPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      ended = true;
      parked = false;
      // D309: whatever was still PENDING when the run ended was DROPPED — derived here too, so a
      // crash or a shutdown that wrote no instruction.state still shows it.
      for (const id of order) {
        const message = byId.get(id);
        if (message?.delivery?.some((entry) => entry.state === 'PENDING')) {
          setDeliveries(id, ops, (state) => (state === 'PENDING' ? 'DROPPED' : state));
        }
      }
      const run = parsed.data;
      system(
        run.status === 'COMPLETE'
          ? 'Run COMPLETE.'
          : run.status === 'HALTED'
            ? `Run HALTED (${run.haltReason ?? 'failure'}).`
            : run.preflightIssues === undefined || run.preflightIssues.length === 0
              ? 'Run BLOCKED at pre-flight.'
              : `Run BLOCKED at pre-flight: ${run.preflightIssues.map((issue) => issue.message).join(' ')}`,
        ops,
        { level: run.status === 'COMPLETE' ? 'info' : 'error' },
      );
    },
  };

  return {
    apply(event) {
      if (event.transient === true || event.seq <= seq) return [];
      if (event.runId !== undefined && event.runId !== runId) return [];
      const handler = handlers[event.type];
      seq = event.seq;
      index = 0;
      at = event.createdAt;
      if (handler === undefined) return [];
      const ops: ChatOp[] = [];
      handler(event.payload, ops);
      return ops;
    },

    messages: () =>
      order.flatMap((id) => {
        const message = byId.get(id);
        return message === undefined ? [] : [message];
      }),

    lastSeq: () => seq,

    nodeStates: () => Object.fromEntries(nodeStates),

    activity(nodeId) {
      const state = nodeStates.get(nodeId);
      const pending = order.reduce(
        (count, id) =>
          count +
          (byId
            .get(id)
            ?.delivery?.filter((entry) => entry.nodeId === nodeId && entry.state === 'PENDING')
            .length ?? 0),
        0,
      );
      const query = openQueries.get(nodeId);
      let doing: string;
      switch (state) {
        case undefined:
          doing = ended ? 'did not run' : 'not started';
          break;
        case 'RUNNING': {
          const tool = lastTool.get(nodeId);
          doing = tool === undefined ? 'working' : `running ${tool}`;
          break;
        }
        case 'WAITING':
          doing = awaitingApproval.has(nodeId)
            ? `waiting for your approval: ${awaitingApproval.get(nodeId) ?? ''}`.trim()
            : query === undefined
              ? 'waiting'
              : `waiting for an answer from ${query.to.map(label).join(', ')}`;
          break;
        case 'COMPLETED':
          doing = 'done';
          break;
        case 'FAILED':
          doing = 'failed';
          break;
        case 'BLOCKED':
          doing = 'blocked: a node it depends on did not finish';
          break;
        case 'STOPPED':
          doing = 'stopped';
          break;
        default:
          doing = state.toLowerCase();
      }
      if (
        blocked !== undefined &&
        !ended &&
        (state === 'READY' || state === 'IDLE' || state === undefined)
      ) {
        doing = `${doing} (run blocked: ${blocked})`;
      } else if (parked && !ended && state !== 'RUNNING' && state !== 'WAITING') {
        doing = `${doing}, idle`;
      }
      return pending === 0
        ? doing
        : `${doing} · ${pending} message${pending === 1 ? '' : 's'} pending`;
    },

    turnUsage: () => [...(hasTurnUsage ? turnUsage : legacyUsage).values()],

    config: () => runConfig,

    budgetLimit: () => budgetLimit,

    pending: () =>
      order.flatMap((id) => {
        const message = byId.get(id);
        if (message?.type !== 'human' || message.delivery === undefined) return [];
        return message.delivery
          .filter((entry) => entry.state === 'PENDING')
          .map((entry) => ({ messageId: message.id, nodeId: entry.nodeId }));
      }),

    ended: () => ended,
  };
}
