import type {
  DeliveryMode,
  Id,
  InstructionState,
  NodeState,
  RosterEntry,
  Run,
  RunDomainConfig,
} from '@ace/contracts';

import type { EmittedEvent } from '../events/index.js';

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
  const turns = new Map<Id, AbortController>();
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

    nodesWantingTurn: () =>
      [...queue.entries()]
        .filter(([, messages]) => messages.some((message) => message.startsTurn))
        .map(([nodeId]) => nodeId),

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
      domain.wake();
    },

    isClosed: () => closed,

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
