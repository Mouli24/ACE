import type {
  Id,
  Message,
  MessageType,
  NodeErrorPayload,
  NodeKind,
  NodeOutputPayload,
  Part,
  ProviderState,
  ProviderStatusPayload,
  RunCompletedPayload,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { EngineEvent, Repository, Scope, Unsubscribe } from '../ports/index.js';
import { maskSecrets } from '../security/secret-patterns.js';

/**
 * The timeline populator (FR-CHAT-001, round 4 §2.3, Arch §12.2).
 *
 * The timeline is **derived from the persisted event log**, never written independently, so it
 * replays identically after a reconnect (§2.3): the same events produce the same `messages` rows,
 * and `GET /workflows/:id/messages` reads them back. This subscriber turns each run event into its
 * one timeline row and emits `message.created` for it — run lifecycle → `event`, an agent or model
 * node's output → `agent`, an Output node's final result → `output`, a node error → `error`, and an
 * engine notice (a shutdown or crash halt, or a provider status change) → `system`. A user's own
 * post is written by the chat service directly, not here, so `message.created` is ignored to avoid
 * a loop.
 *
 * Events are handled one at a time, in the order they arrive, so the rows are ordered the way the
 * run happened (their ULID ids then sort the same way `GET` pages them).
 *
 * **Provider status changes (D-073).** `provider.status` is an engine-scope event — a provider
 * belongs to no workflow — while every `Message` needs a `workflowId`. §2.3 files the other engine
 * notices, a shutdown or crash halt, on the workflow whose run it halted, never on every workflow;
 * a provider notice follows the same rule and is filed on the workflows the change affects: every
 * workflow with a node configured on that provider (`nodes.listByProvider`, the same "in use" set
 * FR-PRV-005 names before a provider is removed, and the providers a run's pre-flight re-checks,
 * Arch §19.3). One row per workflow, however many of its nodes use the provider; no `runId` and no
 * `nodeId`, because the notice is about the provider rather than one run or node. Not "every
 * workflow" — a workflow that never names the provider has nothing to learn from it — and not
 * "every workflow with a run on it", which would miss the workflow about to make its first run and
 * keep telling one that has since moved to another provider.
 *
 * It is bounded to **actual transitions**: the engine re-checks and re-announces every provider
 * every 60 s (FR-PRV-004), and repeating the status it already had is not news, so it writes
 * nothing. `CHECKING` is a probe in flight, not a status the provider is in, so it neither writes a
 * row nor resets the last status. The last status is seeded from the stored provider rows when the
 * populator starts — the provider service stores a status before it emits it, so a row holds the
 * last status announced — which is what keeps an engine restart from re-announcing every provider.
 */

/**
 * The run events a timeline row is derived from. `provider.status`, the one engine-scope source, is
 * handled before this list is consulted; everything else is ignored.
 */
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

  /**
   * providerId → the last status the timeline accounted for (D-073, see the module comment). A
   * provider absent here was added after the populator started, and a new provider is UNKNOWN until
   * something has asked it (Arch §19.3) — so absent reads as UNKNOWN.
   */
  const providerStatus = new Map<Id, ProviderState>();
  try {
    for (const provider of await repository.providers.list(scope)) {
      providerStatus.set(provider.id, provider.status);
    }
  } catch (error) {
    // The timeline must not stop the engine starting; without the seed, the first status each
    // provider reports is compared with UNKNOWN, so at worst one notice per provider is repeated.
    logger.warn({ subsystem: 'chat', err: error }, 'timeline could not read the provider states');
  }

  /** A provider status change → one `system` row on each workflow that uses the provider. */
  async function providerNotice(payload: ProviderStatusPayload): Promise<void> {
    if (payload.status === 'CHECKING') return;
    const previous = providerStatus.get(payload.providerId) ?? 'UNKNOWN';
    if (previous === payload.status) return;
    providerStatus.set(payload.providerId, payload.status);

    const nodes = await repository.nodes.listByProvider(scope, payload.providerId);
    const workflowIds = [...new Set(nodes.map((node) => node.workflowId))].sort();
    if (workflowIds.length === 0) return;

    // Named as the user named it; a provider removed since the event is named by its id.
    const provider = await repository.providers.get(scope, payload.providerId);
    const name = provider?.name ?? payload.providerId;
    const change = `Provider ${name} changed from ${previous} to ${payload.status}`;
    // BR-07: a provider's refusal can quote the key it refused; the timeline never shows one.
    const notice = maskSecrets(
      payload.message === undefined ? `${change}.` : `${change}: ${payload.message}`,
    );
    for (const workflowId of workflowIds) await write('system', workflowId, text(notice));
  }

  async function handle(event: EngineEvent): Promise<void> {
    if (event.transient === true) return;
    if (event.type === 'provider.status') {
      await providerNotice(event.payload as ProviderStatusPayload);
      return;
    }
    if (!TIMELINE_SOURCE_TYPES.has(event.type)) return;

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
