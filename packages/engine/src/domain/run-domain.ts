import type {
  DeliveryMode,
  EnvelopeKind,
  Id,
  InstructionState,
  NodeRun,
  NodeState,
  Part,
  RosterEntry,
  Run,
  RunDomainConfig,
} from '@ace/contracts';

import type { EmittedEvent } from '../events/index.js';
import { pairKey } from './brain.js';
import { freshBudget, type BudgetState } from './budget.js';
import type { OpenQuery } from './envelope-block.js';

/**
 * One live run's Domain state (D309, D323): the human messages waiting for each node, the turn each
 * node has in flight and how to cut it short, and the wake-up the drive waits on while it is parked.
 *
 * Nothing here is the record. Every change a person could see is an event — `instruction.state` on
 * each transition — so the conversation is the log's projection (D303) and this object can be
 * rebuilt from it after an engine restart.
 */

/** A human message, as it waits for one node's turn. */
export interface QueuedMessage {
  messageId: Id;
  /** Secret-masked, as it was stored (BR-07). */
  text: string;
  at: string;
  deliveryMode: DeliveryMode;
  /**
   * False for `@all`: it rides a turn the node takes anyway and never starts one itself (D326). A
   * message that names the node does start one when the node is not busy (D309).
   */
  startsTurn: boolean;
}

/** An envelope as it waits for one node's turn (D310): it reaches the node's `## Team messages`. */
export interface QueuedEnvelope {
  envelopeId: Id;
  kind: EnvelopeKind;
  fromNodeId: Id;
  /** As forwarded — the human's edit, when there was one. */
  summary: string;
  /** The rest of the sender's answer, secret-masked; empty for a note. */
  body: string;
  inReplyTo?: Id;
  at: string;
}

/** An envelope the router held: the human decides, or a resume releases it (D305, D310). */
export interface HeldEnvelope {
  envelopeId: Id;
  kind: EnvelopeKind;
  fromNodeId: Id;
  /** The turn that sent it — a HANDOFF carries that turn's output along its edges. */
  fromNodeRunId: Id;
  toNodeIds: Id[];
  summary: string;
  body: string;
  inReplyTo?: Id;
  /** The output a HANDOFF carries; absent after a restart, when it is read back from the row. */
  output?: Part[];
  iteration: number;
  reason: 'manual routing' | 'LOOP_GUARD';
}

/** What became of a held envelope. The router or the human decided; the drive carries it out. */
export interface EnvelopeDecision {
  held: HeldEnvelope;
  decision: 'FORWARDED' | 'EDITED' | 'REJECTED';
  /** EDITED: what the human changed. */
  edit?: { kind?: EnvelopeKind; toNodeIds?: Id[]; summary?: string };
}

/**
 * D360: a node run a control created for this live run — a retry of a failed turn, or a re-run —
 * handed to the drive already running it rather than to a second drive beside it. The row is the
 * one the client was answered with; the drive executes exactly that row once the node is free.
 */
export interface PlannedTurn {
  nodeRun: NodeRun;
  /** FR-ERR-004: what the node's failure BLOCKED runs again after it. */
  withDownstream: boolean;
}

/** Why a turn's own abort fired: a message cut it short, or the run was ended (D309, D323). */
export type TurnAbortReason = { domain: 'interrupt'; messageId: Id } | { domain: 'end' };

export const isTurnAbortReason = (reason: unknown): reason is TurnAbortReason =>
  typeof reason === 'object' &&
  reason !== null &&
  'domain' in reason &&
  ((reason as { domain: unknown }).domain === 'interrupt' ||
    (reason as { domain: unknown }).domain === 'end');

/** Node states in which a node can take a turn right now (D309): it has nothing in flight. */
export const TURN_NOW_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'COMPLETED',
  'FAILED',
  'STOPPED',
  'BLOCKED',
]);

export interface RunDomainDeps {
  run: Run;
  config: RunDomainConfig;
  roster: readonly RosterEntry[];
  emit: (event: EmittedEvent) => Promise<unknown>;
}

export interface RunDomain {
  readonly runId: Id;
  readonly workflowId: Id;
  readonly config: RunDomainConfig;
  readonly roster: readonly RosterEntry[];
  readonly goal: string | undefined;

  /* The queue. */
  /** Record a message for these nodes: PENDING, announced, and the drive woken. */
  enqueue(message: QueuedMessage, nodeIds: readonly Id[]): Promise<void>;
  /** Restore a PENDING message after a restart, without announcing it again. */
  restore(message: QueuedMessage, nodeId: Id): void;
  /** What waits for this node's next turn, oldest first. */
  pending(nodeId: Id): QueuedMessage[];
  /** Nodes that have a message which may start a turn (D309). */
  nodesWantingTurn(): Id[];
  /** The turn has started: these messages are DELIVERED to it. */
  delivered(nodeId: Id, nodeRunId: Id, messages: readonly QueuedMessage[]): Promise<void>;
  /** The turn ended: DONE — or, cut short by another message, PENDING again for the next one. */
  turnEnded(
    nodeId: Id,
    nodeRunId: Id,
    messages: readonly QueuedMessage[],
    interrupted: boolean,
  ): Promise<void>;

  /* Turns in flight. */
  /** A node's turn is starting: its own abort, combined by the caller with the run's. */
  beginTurn(nodeId: Id): AbortController;
  endTurn(nodeId: Id, controller: AbortController): void;
  /** Cut the node's turn short for this message; false when it has none in flight. */
  interrupt(nodeId: Id, messageId: Id): boolean;
  hasTurn(nodeId: Id): boolean;

  /* Controls on a live run (D360). */
  /** A retry or a re-run for the drive to execute once the node is free; the drive is woken. */
  planTurn(plan: PlannedTurn): void;
  /** What waits to be executed, oldest first. */
  plannedTurns(): PlannedTurn[];
  /** The drive takes this node's planned turn to execute it now. */
  takePlannedTurn(nodeId: Id): PlannedTurn | undefined;

  /* The run's life. */
  /** The drive waits on this while parked or between dispatches. */
  changed(): Promise<void>;
  wake(): void;
  /** D323: end the run — every turn in flight is cut short and nothing new starts. */
  requestEnd(): void;
  endRequested(): boolean;
  /** Serialises a message's write against the drive closing the run (nothing half-sends). */
  withLock<T>(task: () => Promise<T>): Promise<T>;
  /** The run is ending: every PENDING delivery is DROPPED, and no message is taken after this. */
  close(): Promise<void>;
  isClosed(): boolean;
  /* Envelopes (D310). */
  /** Forwarded envelopes for these nodes: each starts a turn, and the drive is woken. */
  enqueueEnvelope(envelope: QueuedEnvelope, nodeIds: readonly Id[]): void;
  pendingEnvelopes(nodeId: Id): QueuedEnvelope[];
  /** The turn has started: these envelopes are in its prompt. */
  envelopesDelivered(nodeId: Id, envelopeIds: readonly Id[]): void;
  /** A turn another message cut short: its envelopes wait for the next one. */
  returnEnvelopes(nodeId: Id, envelopes: readonly QueuedEnvelope[]): void;
  hold(envelope: HeldEnvelope): void;
  held(envelopeId: Id): HeldEnvelope | undefined;
  heldEnvelopes(): HeldEnvelope[];
  /**
   * The human decided about a held envelope (or a resume released it): announced `by: 'human'` and
   * handed to the drive, which forwards it.
   */
  decide(decision: EnvelopeDecision, reason?: string): Promise<void>;
  takeDecisions(): EnvelopeDecision[];
  /** Whether anything is waiting on the human: a held envelope, or a decision not yet carried out. */
  awaitingHuman(): boolean;
  /** QUERYs still waiting for their ANSWER, by envelope id. */
  readonly openQueries: Map<Id, OpenQuery>;
  /** QUERY and FLAG envelopes sent between each unordered pair (the loop guard). */
  readonly loopCounts: Map<string, number>;
  /** D305: a resume after LOOP_GUARD resets the held pairs' counts and forwards what was held. */
  releaseLoopGuard(): Promise<void>;
  /** The Brain's digest: one line per envelope routed, oldest first (D304). */
  digest(): string[];
  noteRouted(line: string): void;

  /* The token budget (D313). */
  budget(): BudgetState;
  /** A new limit, or none: its thresholds start fresh, and the drive is woken to read it. */
  setBudget(limit: number | null): void;
  /** The drive's record of what it has said about the budget. */
  noteBudget(state: BudgetState): void;
  /** Input + output tokens the run has used so far, as the drive last counted them. */
  usedTokens(): number;
  noteUsed(used: number): void;

  /** Each node's state, as the scheduler sees it — what `@all` and the turn rules read. */
  nodeStates(): Record<Id, NodeState>;
  /** The scheduler hands over its view of the node states. */
  attachStates(read: () => Record<Id, NodeState>): void;
  /** Settles with the run as it ended — what `POST /runs/:id/end` answers with. */
  finished(): Promise<Run>;
  settle(run: Run): void;
}

export function createRunDomain(deps: RunDomainDeps): RunDomain {
  const { run, config, roster, emit } = deps;
  const queue = new Map<Id, QueuedMessage[]>();
  const envelopeQueue = new Map<Id, QueuedEnvelope[]>();
  const heldById = new Map<Id, HeldEnvelope>();
  let decisions: EnvelopeDecision[] = [];
  const digestLines: string[] = [];
  let budget = freshBudget(config.tokenBudget);
  let used = 0;
  const turns = new Map<Id, AbortController>();
  let planned: PlannedTurn[] = [];
  let waiters: (() => void)[] = [];
  let ending = false;
  let closed = false;
  let lock: Promise<unknown> = Promise.resolve();
  let readStates: () => Record<Id, NodeState> = () => ({});
  let settleFinished: (run: Run) => void = () => undefined;
  const finishedPromise = new Promise<Run>((resolve) => {
    settleFinished = resolve;
  });

  async function announce(messageId: Id, nodeId: Id, state: InstructionState, nodeRunId?: Id) {
    await emit({
      type: 'instruction.state',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        messageId,
        nodeId,
        state,
        ...(nodeRunId === undefined ? {} : { nodeRunId }),
      },
    });
  }

  const domain: RunDomain = {
    runId: run.id,
    workflowId: run.workflowId,
    config,
    roster,
    goal: run.goal,

    async enqueue(message, nodeIds) {
      for (const nodeId of nodeIds) {
        queue.set(nodeId, [...(queue.get(nodeId) ?? []), message]);
        await announce(message.messageId, nodeId, 'PENDING');
      }
      domain.wake();
    },

    restore(message, nodeId) {
      queue.set(nodeId, [...(queue.get(nodeId) ?? []), message]);
    },

    pending: (nodeId) => [...(queue.get(nodeId) ?? [])],

    nodesWantingTurn: () => [
      ...new Set([
        ...[...queue.entries()]
          .filter(([, messages]) => messages.some((message) => message.startsTurn))
          .map(([nodeId]) => nodeId),
        ...envelopeQueue.keys(),
      ]),
    ],

    async delivered(nodeId, nodeRunId, messages) {
      const taken = new Set(messages.map((message) => message.messageId));
      const left = (queue.get(nodeId) ?? []).filter((message) => !taken.has(message.messageId));
      if (left.length === 0) queue.delete(nodeId);
      else queue.set(nodeId, left);
      for (const message of messages)
        await announce(message.messageId, nodeId, 'DELIVERED', nodeRunId);
    },

    async turnEnded(nodeId, nodeRunId, messages, interrupted) {
      if (!interrupted) {
        for (const message of messages)
          await announce(message.messageId, nodeId, 'DONE', nodeRunId);
        return;
      }
      // D309: a turn another message cut short never finished these, so the next turn gets them.
      queue.set(nodeId, [...messages, ...(queue.get(nodeId) ?? [])]);
      for (const message of messages) await announce(message.messageId, nodeId, 'PENDING');
    },

    enqueueEnvelope(envelope, nodeIds) {
      for (const nodeId of nodeIds) {
        envelopeQueue.set(nodeId, [...(envelopeQueue.get(nodeId) ?? []), envelope]);
      }
      domain.wake();
    },

    pendingEnvelopes: (nodeId) => [...(envelopeQueue.get(nodeId) ?? [])],

    envelopesDelivered(nodeId, envelopeIds) {
      const taken = new Set(envelopeIds);
      const left = (envelopeQueue.get(nodeId) ?? []).filter(
        (envelope) => !taken.has(envelope.envelopeId),
      );
      if (left.length === 0) envelopeQueue.delete(nodeId);
      else envelopeQueue.set(nodeId, left);
    },

    returnEnvelopes(nodeId, envelopes) {
      if (envelopes.length === 0) return;
      envelopeQueue.set(nodeId, [...envelopes, ...(envelopeQueue.get(nodeId) ?? [])]);
    },

    hold(envelope) {
      heldById.set(envelope.envelopeId, envelope);
    },

    held: (envelopeId) => heldById.get(envelopeId),

    heldEnvelopes: () => [...heldById.values()],

    async decide(decision, reason) {
      heldById.delete(decision.held.envelopeId);
      await emit({
        type: 'envelope.routed',
        workflowId: run.workflowId,
        runId: run.id,
        payload: {
          runId: run.id,
          envelopeId: decision.held.envelopeId,
          decision: decision.decision,
          by: 'human',
          ...(reason === undefined ? {} : { reason }),
          ...(decision.edit === undefined ? {} : { edit: decision.edit }),
        },
      });
      decisions.push(decision);
      domain.wake();
    },

    takeDecisions() {
      const taken = decisions;
      decisions = [];
      return taken;
    },

    awaitingHuman: () => heldById.size > 0 || decisions.length > 0,

    openQueries: new Map<Id, OpenQuery>(),

    loopCounts: new Map<string, number>(),

    async releaseLoopGuard() {
      for (const held of [...heldById.values()]) {
        if (held.reason !== 'LOOP_GUARD') continue;
        for (const nodeId of held.toNodeIds)
          domain.loopCounts.delete(pairKey(held.fromNodeId, nodeId));
        await domain.decide({ held, decision: 'FORWARDED' }, 'released by resume');
      }
    },

    digest: () => [...digestLines],

    noteRouted(line) {
      digestLines.push(line);
    },

    beginTurn(nodeId) {
      const controller = new AbortController();
      turns.set(nodeId, controller);
      // Ended while it was being dispatched: it is over before it starts.
      if (ending) controller.abort({ domain: 'end' } satisfies TurnAbortReason);
      return controller;
    },

    endTurn(nodeId, controller) {
      if (turns.get(nodeId) === controller) turns.delete(nodeId);
    },

    interrupt(nodeId, messageId) {
      const controller = turns.get(nodeId);
      if (controller === undefined || controller.signal.aborted) return false;
      controller.abort({ domain: 'interrupt', messageId } satisfies TurnAbortReason);
      return true;
    },

    hasTurn: (nodeId) => turns.has(nodeId),

    planTurn(plan) {
      // One planned turn per node: a second retry of the same node replaces the first.
      planned = [
        ...planned.filter((each) => each.nodeRun.nodeId !== plan.nodeRun.nodeId),
        plan,
      ];
      domain.wake();
    },

    plannedTurns: () => [...planned],

    takePlannedTurn(nodeId) {
      const plan = planned.find((each) => each.nodeRun.nodeId === nodeId);
      if (plan !== undefined) planned = planned.filter((each) => each !== plan);
      return plan;
    },

    changed: () => new Promise<void>((resolve) => waiters.push(resolve)),

    wake() {
      const woken = waiters;
      waiters = [];
      for (const resolve of woken) resolve();
    },

    requestEnd() {
      ending = true;
      for (const controller of turns.values()) {
        if (!controller.signal.aborted)
          controller.abort({ domain: 'end' } satisfies TurnAbortReason);
      }
      domain.wake();
    },

    endRequested: () => ending,

    withLock<T>(task: () => Promise<T>): Promise<T> {
      const next = lock.then(task, task);
      lock = next.catch(() => undefined);
      return next;
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const [nodeId, messages] of queue) {
        for (const message of messages) await announce(message.messageId, nodeId, 'DROPPED');
      }
      queue.clear();
      envelopeQueue.clear();
      planned = [];
      heldById.clear();
      decisions = [];
      domain.wake();
    },

    isClosed: () => closed,

    budget: () => budget,

    setBudget(limit) {
      budget = freshBudget(limit);
      domain.wake();
    },

    noteBudget(state) {
      budget = state;
    },

    usedTokens: () => used,

    noteUsed(value) {
      used = value;
    },

    nodeStates: () => readStates(),

    attachStates(read) {
      readStates = read;
    },

    finished: () => finishedPromise,

    settle(ended) {
      settleFinished(ended);
    },
  };

  return domain;
}
