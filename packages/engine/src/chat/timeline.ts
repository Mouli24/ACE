import type {
  Id,
  Message,
  MessageType,
  NodeErrorPayload,
  NodeKind,
  NodeOutputPayload,
  Part,
  RunCompletedPayload,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { EngineEvent, Repository, Scope, Unsubscribe } from '../ports/index.js';

/**
 * The timeline populator (FR-CHAT-001, round 4 §2.3, Arch §12.2).
 *
 * The timeline is **derived from the persisted event log**, never written independently, so it
 * replays identically after a reconnect (§2.3): the same events produce the same `messages` rows,
 * and `GET /workflows/:id/messages` reads them back. This subscriber turns each run event into its
 * one timeline row and emits `message.created` for it — run lifecycle → `event`, an agent or model
 * node's output → `agent`, an Output node's final result → `output`, a node error → `error`, and an
 * engine notice (a shutdown or crash halt) → `system`. A user's own post is written by the chat
 * service directly, not here, so `message.created` is ignored to avoid a loop.
 *
 * Events are handled one at a time, in the order they arrive, so the rows are ordered the way the
 * run happened (their ULID ids then sort the same way `GET` pages them).
 */

/** The run events a timeline row is derived from. Everything else is ignored. */
const TIMELINE_SOURCE_TYPES = new Set([
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'node.output',
  'node.error',
]);

export interface TimelinePopulatorDeps {
  scope: Scope;
  repository: Repository;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
  nextId?: () => string;
}

export interface TimelinePopulator {
  /** Detach from the bus. */
  unsubscribe: Unsubscribe;
  /** Resolves once every event received so far has produced its rows (used by tests). */
  idle(): Promise<void>;
}

export async function startTimelinePopulation(
  deps: TimelinePopulatorDeps,
): Promise<TimelinePopulator> {
  const { scope, repository, bus, logger } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /** runId → nodeId → kind, read once per run from its immutable snapshot (BR-04). */
  const kindsByRun = new Map<Id, Map<Id, NodeKind>>();

  async function kindOf(runId: Id, nodeId: Id): Promise<NodeKind | undefined> {
    let map = kindsByRun.get(runId);
    if (map === undefined) {
      const run = await repository.runs.get(scope, runId);
      if (run === null) return undefined;
      map = new Map(run.snapshot.nodes.map((node) => [node.id, node.kind]));
      kindsByRun.set(runId, map);
    }
    return map.get(nodeId);
  }

  async function write(
    type: MessageType,
    workflowId: Id,
    content: Part[],
    extra: { runId?: Id; nodeId?: Id; nodeRunId?: Id } = {},
  ): Promise<void> {
    const message: Message = {
      id: nextId(),
      workflowId,
      type,
      content,
      at: now(),
      ...(extra.runId === undefined ? {} : { runId: extra.runId }),
      ...(extra.nodeId === undefined ? {} : { nodeId: extra.nodeId }),
      ...(extra.nodeRunId === undefined ? {} : { nodeRunId: extra.nodeRunId }),
    };
    await repository.messages.append(scope, message);
    await bus.emit({
      type: 'message.created',
      workflowId,
      payload: { workflowId, message },
    });
  }

  function text(value: string): Part[] {
    return [{ type: 'text', text: value }];
  }

  async function handle(event: EngineEvent): Promise<void> {
    if (event.transient === true || !TIMELINE_SOURCE_TYPES.has(event.type)) return;

    const workflowId = event.workflowId;
    const runId = event.runId;
    // A run event with no workflow cannot be filed on a workflow's timeline; nothing that reaches
    // here should be missing it, but skipping is safer than inventing an attribution.
    if (workflowId === undefined) return;

    switch (event.type) {
      case 'run.started':
        await write('event', workflowId, text('Run started.'), { ...(runId ? { runId } : {}) });
        return;

      case 'run.paused':
        await write('event', workflowId, text('Run paused.'), { ...(runId ? { runId } : {}) });
        return;

      case 'run.resumed':
        await write('event', workflowId, text('Run resumed.'), { ...(runId ? { runId } : {}) });
        return;

      case 'run.completed': {
        const payload = event.payload as RunCompletedPayload;
        const summary =
          payload.status === 'COMPLETE'
            ? 'Run complete.'
            : payload.status === 'BLOCKED'
              ? 'Run blocked before it started.'
              : `Run halted${payload.haltReason === undefined ? '' : `: ${payload.haltReason}`}.`;
        await write('event', workflowId, text(summary), { runId: payload.runId });

        // A shutdown or a crash is the engine's own notice, not the run's doing (§2.3).
        if (payload.haltReason === 'shutdown' || payload.haltReason === 'crash') {
          const notice =
            payload.haltReason === 'shutdown'
              ? 'The engine shut down while this run was in flight.'
              : 'The engine recovered from a crash; this run was halted.';
          await write('system', workflowId, text(notice), { runId: payload.runId });
        }
        return;
      }

      case 'node.output': {
        const payload = event.payload as NodeOutputPayload;
        const kind = await kindOf(payload.runId, payload.nodeId);
        if (kind === 'agent' || kind === 'model') {
          await write('agent', workflowId, payload.output, {
            runId: payload.runId,
            nodeId: payload.nodeId,
            nodeRunId: payload.nodeRunId,
          });
        } else if (kind === 'output') {
          await write('output', workflowId, payload.output, {
            runId: payload.runId,
            nodeId: payload.nodeId,
            nodeRunId: payload.nodeRunId,
          });
        }
        // input / transform / merge produce no timeline row: a user post is the `user` message, and
        // the intermediate transforms are not what the timeline is about (§2.3).
        return;
      }

      case 'node.error': {
        const payload = event.payload as NodeErrorPayload;
        await write('error', workflowId, text(payload.error.message), {
          runId: payload.runId,
          nodeId: payload.nodeId,
          nodeRunId: payload.nodeRunId,
        });
        return;
      }
    }
  }

  // One event at a time, in order: two overlapping handles could give rows ids that do not reflect
  // the event order, and the timeline is ordered by id.
  let queue: Promise<void> = Promise.resolve();

  const unsubscribe = await bus.subscribe((event) => {
    queue = queue.then(() =>
      handle(event).catch((error: unknown) => {
        logger.error({ subsystem: 'chat', err: error, eventType: event.type }, 'timeline row failed');
      }),
    );
  });

  return {
    unsubscribe,
    idle: () => queue,
  };
}
