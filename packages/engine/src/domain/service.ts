import {
  DomainChatQuerySchema,
  DomainStreamQuerySchema,
  EnvelopeSentPayloadSchema,
  PostRunMessageRequestSchema,
  PutRunBudgetRequestSchema,
  RouteEnvelopeRequestSchema,
  DOMAIN_PAGE_DEFAULT,
  closestHandles,
  defaultRunDomainConfig,
  emptyPricingTable,
  parseAddressing,
  resolveAddressing,
  type DomainChatPage,
  type DomainMessage,
  type DomainUsageSnapshot,
  type HumanMention,
  type Id,
  type PricingTable,
  type PutRunBudgetRequest,
  type PostRunMessageRequest,
  type PostRunMessageResponse,
  type RouteEnvelopeRequest,
  type RouteEnvelopeResponse,
  type Run,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Repository, Scope } from '../ports/index.js';
import { assertRunAction, withAllowedActions } from '../runs/control/actions.js';
import type { RunGateRegistry } from '../runs/control/gate.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { pumpChatStream, type ChatStreamWrite } from './chat-stream.js';
import { domainContextFor, type DomainContext } from './context.js';
import { filterForNode } from './project-chat.js';
import { createDomainProjection, type DomainProjection } from './projection.js';
import { projectUsage } from './project-usage.js';
import type { DomainRegistry } from './registry.js';
import type { EnvelopeDecision, HeldEnvelope, RunDomain } from './run-domain.js';

/**
 * The human's way into a run (D309, D323–D326): `POST /runs/:runId/messages` and `POST /runs/:runId/end`.
 *
 * A message is parsed by the same function the composer previews with, so the server's reading is
 * the authority and nothing half-sends: a bad handle, an ambiguous name, a stray `exclude` or `@all`
 * to finished nodes is refused before a single event is written. A message that passes is one
 * `human.message` and one `instruction.state` PENDING per recipient, written under the run's lock so
 * it can never land after the drive has closed the run.
 *
 * `POST /runs/:runId/envelopes/:id/route` is the human's decision on an envelope the Brain's router
 * held (D310): approve forwards it, edit forwards the edited version (both are logged), reject drops
 * it and tells its sender why, as a message addressed to it.
 *
 * `GET /runs/:runId/usage` is the run's usage snapshot, priced from `ace.pricing.json` (D306), and
 * `PUT /runs/:runId/budget` sets, changes or removes its token budget (D313). Raising it above what
 * the run has used, or removing it, resumes a run BLOCKED `BUDGET_EXCEEDED`; lowering it under that
 * blocks it at once.
 */

export interface DomainService {
  postMessage(runId: Id, request: PostRunMessageRequest): Promise<PostRunMessageResponse>;
  /** D323: end a run started from Domain; answers with the run as it ended. */
  end(runId: Id): Promise<Run>;
  /** D313: the run's token budget: set, changed, or removed (`null`). Answers with the usage. */
  setBudget(runId: Id, request: PutRunBudgetRequest): Promise<DomainUsageSnapshot>;
  /** D303, D306: what the run used, per node and per turn, against its budget, priced. */
  usage(runId: Id): Promise<DomainUsageSnapshot>;
  /** D314: one page of the conversation, forward from `after`; a lens with `node`. */
  chat(runId: Id, query: unknown): Promise<DomainChatPage>;
  /**
   * D314: a stream of the conversation from `after` (or `Last-Event-ID`), checked before it opens
   * — a bad query is a 400 and an unknown run a 404 — and then pumped until the client goes.
   */
  chatStream(
    runId: Id,
    query: unknown,
    lastEventId?: string,
  ): Promise<{ pump(write: ChatStreamWrite, signal: AbortSignal): Promise<void> }>;
  /** D310: decide what becomes of a held envelope. */
  routeEnvelope(
    runId: Id,
    envelopeId: Id,
    request: RouteEnvelopeRequest,
  ): Promise<RouteEnvelopeResponse>;
}

export interface DomainServiceDeps {
  repository: Pick<Repository, 'runs' | 'events' | 'providers'>;
  scope: Scope;
  bus: Pick<EventBus, 'emit' | 'subscribe'>;
  domains: DomainRegistry;
  /** D305: End lifts a run BLOCKED mid-run, so its drive can wind down. Absent, nothing to lift. */
  gates?: Pick<RunGateRegistry, 'get'>;
  /** D306: `<dataDir>/ace.pricing.json`, read when asked. Absent, nothing is priced. */
  pricing?: () => PricingTable;
  /**
   * D305: the run controls' resume, for a budget raised above what was used. A getter's worth of
   * indirection, so the composition root can build the controls after this service.
   */
  resume?: (runId: Id) => Promise<unknown>;
  now?: () => string;
  nextId?: () => string;
}

/** A run that can still take a message: going, paused, or blocked mid-run (D305). */
const isLive = (run: Run): boolean =>
  run.status === 'RUNNING' ||
  run.status === 'PAUSED' ||
  (run.status === 'BLOCKED' && run.blockedReason !== undefined);

const invalid = (message: string, details?: unknown): HttpError =>
  new HttpError('invalid_config', 'validation_failed', message, details);

const ended = (run: Run): HttpError =>
  new HttpError(
    'workflow',
    'invalid_run_state',
    `The run is ${run.status} — it has ended, so it takes no more messages.`,
    { runId: run.id, status: run.status },
  );

export function createDomainService(deps: DomainServiceDeps): DomainService {
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function load(runId: Id): Promise<Run> {
    const run = await deps.repository.runs.get(deps.scope, runId);
    if (run === null) throw notFound(`run ${runId}`);
    return run;
  }

  /** Who is on the board, from the run's snapshot, with each provider's type for pricing. */
  async function contextOf(run: Run): Promise<DomainContext> {
    const providerTypes = new Map(
      (await deps.repository.providers.list(deps.scope)).map((provider) => [
        provider.id,
        provider.type,
      ]),
    );
    return domainContextFor(run.id, run.snapshot.nodes, providerTypes);
  }

  /**
   * D314: each run's projection, kept and brought up to date from the log on each read rather than
   * refolded from the start, the most recently read runs kept. Reads of one run take turns, so an
   * event is never folded twice.
   */
  const projections = new Map<Id, { projection: DomainProjection; turn: Promise<unknown> }>();
  const PROJECTIONS_KEPT = 32;
  async function projectionOf(run: Run): Promise<DomainProjection> {
    let entry = projections.get(run.id);
    if (entry === undefined) {
      entry = { projection: createDomainProjection(await contextOf(run)), turn: Promise.resolve() };
      if (projections.size >= PROJECTIONS_KEPT) {
        const [oldest] = projections.keys();
        if (oldest !== undefined) projections.delete(oldest);
      }
    }
    projections.delete(run.id);
    projections.set(run.id, entry);
    const { projection } = entry;
    const caughtUp = entry.turn.then(async () => {
      const events = await deps.repository.events.listAfter(deps.scope, projection.lastSeq(), {
        runIds: [run.id],
      });
      for (const event of events) projection.apply(event);
    });
    entry.turn = caughtUp.catch(() => undefined);
    await caughtUp;
    return projection;
  }

  /** A cursor is `seq.index`; they compare as numbers, seq first. */
  const isAfter = (message: DomainMessage, cursor: string): boolean => {
    const [seq = 0, index = 0] = message.cursor.split('.').map(Number);
    const [afterSeq = 0, afterIndex = 0] = cursor.split('.').map(Number);
    return seq > afterSeq || (seq === afterSeq && index > afterIndex);
  };

  /** The run's usage snapshot, from its whole log, priced by the table as it is now. */
  async function snapshotOf(run: Run): Promise<DomainUsageSnapshot> {
    const events = await deps.repository.events.listAfter(deps.scope, 0, { runIds: [run.id] });
    const providerTypes = new Map(
      (await deps.repository.providers.list(deps.scope)).map((provider) => [
        provider.id,
        provider.type,
      ]),
    );
    return projectUsage(
      events,
      domainContextFor(run.id, run.snapshot.nodes, providerTypes),
      deps.pricing?.() ?? emptyPricingTable(),
    );
  }

  /** D310: a rejected envelope's sender is told why, as a message addressed to it (trusted). */
  async function tellSender(
    run: Run,
    domain: RunDomain,
    held: HeldEnvelope,
    reason: string | undefined,
  ): Promise<void> {
    const handleOf = (nodeId: Id): string =>
      domain.roster.find((entry) => entry.nodeId === nodeId)?.handle ?? 'node';
    const to = held.toNodeIds.map((nodeId) => `@${handleOf(nodeId)}`).join(', ');
    const why = reason === undefined || reason.trim() === '' ? '.' : `: ${reason.trim()}`;
    const text = maskSecrets(
      `Your ${held.kind} to ${to} ("${held.summary}") was not forwarded${why}`,
    );
    const messageId = nextId();
    await deps.bus.emit({
      type: 'human.message',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        messageId,
        text,
        addressing: 'direct',
        mentions: [{ nodeId: held.fromNodeId, handle: handleOf(held.fromNodeId), via: 'handle' }],
        deliveryMode: 'queue',
      },
    });
    await domain.enqueue({ messageId, text, at: now(), deliveryMode: 'queue', startsTurn: true }, [
      held.fromNodeId,
    ]);
  }

  /** D310: the human's edit, checked against the team and the graph as an agent's block is. */
  function editOf(
    run: Run,
    domain: RunDomain,
    held: HeldEnvelope,
    request: RouteEnvelopeRequest,
  ): NonNullable<EnvelopeDecision['edit']> {
    const edit = request.edit;
    if (
      edit === undefined ||
      (edit.kind === undefined && edit.to === undefined && edit.summary === undefined)
    ) {
      throw invalid('An edit changes the kind, the recipients or the summary.');
    }
    const kind = edit.kind ?? held.kind;
    const tied = (value: string): boolean => value === 'QUERY' || value === 'ANSWER';
    if (kind !== held.kind && (tied(kind) || tied(held.kind))) {
      throw invalid('A QUERY or an ANSWER keeps its kind: the asker is waiting on it.');
    }

    let toNodeIds: Id[] | undefined;
    if (edit.to !== undefined) {
      toNodeIds = [];
      for (const raw of edit.to) {
        const handle = raw.trim().replace(/^@/u, '').toLowerCase();
        const entry = domain.roster.find((each) => each.handle === handle);
        if (entry === undefined) {
          throw invalid(`@${handle} is not on the team.`, {
            errors: [
              {
                code: 'unknown_handle',
                handle,
                suggestions: closestHandles(handle, domain.roster).filter(
                  (each) => each !== '@all',
                ),
              },
            ],
          });
        }
        if (entry.nodeId === held.fromNodeId) {
          throw invalid(`An envelope cannot go back to its own sender (@${handle}).`);
        }
        if (!toNodeIds.includes(entry.nodeId)) toNodeIds.push(entry.nodeId);
      }
    }

    if (kind === 'HANDOFF') {
      const fed = new Set(
        run.snapshot.edges
          .filter((each) => each.kind === 'data' && each.from.nodeId === held.fromNodeId)
          .map((each) => each.to.nodeId),
      );
      if ((toNodeIds ?? held.toNodeIds).some((nodeId) => !fed.has(nodeId))) {
        throw invalid('A HANDOFF goes only to nodes its sender feeds.');
      }
    }

    return {
      ...(edit.kind === undefined ? {} : { kind: edit.kind }),
      ...(toNodeIds === undefined ? {} : { toNodeIds }),
      ...(edit.summary === undefined ? {} : { summary: maskSecrets(edit.summary) }),
    };
  }

  return {
    async postMessage(runId, body) {
      const parsedBody = PostRunMessageRequestSchema.safeParse(body);
      if (!parsedBody.success) {
        throw new HttpError(
          'invalid_config',
          'validation_failed',
          'The message is not valid.',
          parsedBody.error.issues,
        );
      }
      const request = parsedBody.data;

      const run = await load(runId);
      if (!isLive(run)) throw ended(run);
      const domain = deps.domains.get(runId);
      if (domain === undefined) throw ended(run);

      return domain.withLock(async () => {
        if (domain.isClosed()) {
          throw new HttpError(
            'workflow',
            'invalid_run_state',
            'The run is ending — it takes no more messages.',
            {
              runId: run.id,
              status: run.status,
            },
          );
        }

        const parsed = parseAddressing(request.text, domain.roster);
        const resolved = resolveAddressing({
          parsed,
          roster: domain.roster,
          states: domain.nodeStates(),
          deliveryMode: request.deliveryMode,
          ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
        });
        if (!resolved.ok) {
          const [first] = resolved.errors;
          throw new HttpError(
            'invalid_config',
            'validation_failed',
            first?.message ?? 'The message cannot be sent.',
            { errors: resolved.errors },
          );
        }

        const messageId = nextId();
        const at = now();
        const text = maskSecrets(request.text);
        const viaOf = (nodeId: Id): HumanMention['via'] => {
          if (resolved.addressing === 'all') return 'all';
          if (resolved.addressing === 'unaddressed') return 'unaddressed';
          return parsed.spans.find((span) => span.nodeId === nodeId)?.via === 'handle'
            ? 'handle'
            : 'name';
        };
        const mentions: HumanMention[] = resolved.recipients.map((nodeId) => ({
          nodeId,
          handle: domain.roster.find((entry) => entry.nodeId === nodeId)?.handle ?? 'node',
          via: viaOf(nodeId),
        }));

        await deps.bus.emit({
          type: 'human.message',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            messageId,
            text,
            addressing: resolved.addressing,
            mentions,
            deliveryMode: request.deliveryMode,
            ...(request.exclude === undefined || request.exclude.length === 0
              ? {}
              : { exclude: request.exclude }),
          },
        });
        await domain.enqueue(
          {
            messageId,
            text,
            at,
            deliveryMode: request.deliveryMode,
            startsTurn: resolved.addressing !== 'all',
          },
          resolved.recipients,
        );
        // D309: interrupt cuts a busy node's turn short; a node that is not busy simply gets a turn.
        if (request.deliveryMode === 'interrupt') {
          for (const nodeId of resolved.recipients) domain.interrupt(nodeId, messageId);
        }

        return {
          messageId,
          delivery: resolved.recipients.map((nodeId) => ({ nodeId, state: 'PENDING' as const })),
        };
      });
    },

    async end(runId) {
      const run = await load(runId);
      assertRunAction(run, 'end');
      const domain = deps.domains.get(runId);
      if (domain === undefined) throw ended(run);
      domain.requestEnd();
      // D305: a run BLOCKED mid-run has a paused gate; its drive has to get past it to end.
      if (run.status === 'BLOCKED') deps.gates?.get(runId)?.resume();
      return withAllowedActions(await domain.finished());
    },

    async chat(runId, query) {
      const parsed = DomainChatQuerySchema.safeParse(query);
      if (!parsed.success) throw invalid('The page query is not valid.', parsed.error.issues);
      const { node, after, limit = DOMAIN_PAGE_DEFAULT } = parsed.data;
      const run = await load(runId);
      const all = (await projectionOf(run)).messages();
      const lens = node === undefined ? all : filterForNode(all, node);
      const rest = after === undefined ? lens : lens.filter((message) => isAfter(message, after));
      const messages = rest.slice(0, limit);
      const last = messages.at(-1);
      return {
        messages,
        ...(rest.length > messages.length && last !== undefined ? { nextCursor: last.cursor } : {}),
      };
    },

    async chatStream(runId, query, lastEventId) {
      const parsed = DomainStreamQuerySchema.safeParse({
        ...(typeof query === 'object' && query !== null ? query : {}),
        ...(lastEventId === undefined || lastEventId.trim() === '' ? {} : { after: lastEventId }),
      });
      if (!parsed.success) throw invalid('The stream query is not valid.', parsed.error.issues);
      const { node, after = 0 } = parsed.data;
      const run = await load(runId);
      const context = await contextOf(run);
      return {
        pump: (write, signal) =>
          pumpChatStream(
            {
              context,
              events: () => deps.repository.events.listAfter(deps.scope, 0, { runIds: [run.id] }),
              subscribe: (handler) => deps.bus.subscribe(handler),
              pricing: () => deps.pricing?.() ?? emptyPricingTable(),
            },
            { after, ...(node === undefined ? {} : { node }) },
            write,
            signal,
          ),
      };
    },

    async usage(runId) {
      return snapshotOf(await load(runId));
    },

    async setBudget(runId, body) {
      const parsedBody = PutRunBudgetRequestSchema.safeParse(body);
      if (!parsedBody.success) {
        throw invalid('The budget is not valid.', parsedBody.error.issues);
      }
      const { limit } = parsedBody.data;

      const run = await load(runId);
      if (!isLive(run)) throw ended(run);
      const domain = deps.domains.get(runId);
      if (domain === undefined) throw ended(run);

      await domain.withLock(async () => {
        if (domain.isClosed()) throw ended(run);
        const used = domain.usedTokens();
        domain.setBudget(limit);
        await deps.repository.runs.update(deps.scope, run.id, {
          domain: { ...(run.domain ?? defaultRunDomainConfig()), tokenBudget: limit },
        });
        await deps.bus.emit({
          type: 'run.token_budget',
          workflowId: run.workflowId,
          runId: run.id,
          payload: { runId: run.id, limit, used, level: 'SET' },
        });
        // D305: room again — the run carries on. Lowered under what was used, the drive blocks it.
        const room = limit === null || used < limit;
        if (run.status === 'BLOCKED' && run.blockedReason === 'BUDGET_EXCEEDED' && room) {
          await deps.resume?.(run.id);
        }
      });
      return snapshotOf((await deps.repository.runs.get(deps.scope, run.id)) ?? run);
    },

    async routeEnvelope(runId, envelopeId, body) {
      const parsedBody = RouteEnvelopeRequestSchema.safeParse(body);
      if (!parsedBody.success) {
        throw invalid('The routing decision is not valid.', parsedBody.error.issues);
      }
      const request = parsedBody.data;

      const run = await load(runId);
      if (!isLive(run)) throw ended(run);
      const domain = deps.domains.get(runId);
      if (domain === undefined) throw ended(run);

      return domain.withLock(async () => {
        if (domain.isClosed()) {
          throw new HttpError('workflow', 'invalid_run_state', 'The run is ending.', {
            runId: run.id,
          });
        }
        const held = domain.held(envelopeId);
        if (held === undefined) {
          const logged = await deps.repository.events.listAfter(deps.scope, 0, {
            runIds: [run.id],
          });
          const known = logged.some(
            (event) =>
              event.type === 'envelope.sent' &&
              EnvelopeSentPayloadSchema.safeParse(event.payload).data?.envelopeId === envelopeId,
          );
          if (!known) throw notFound(`envelope ${envelopeId}`);
          throw new HttpError(
            'workflow',
            'invalid_run_state',
            'That envelope is not held: it has already been routed.',
            { envelopeId },
          );
        }
        const reason = request.reason === undefined ? undefined : maskSecrets(request.reason);

        if (request.decision === 'approve') {
          await domain.decide({ held, decision: 'FORWARDED' }, reason);
          return { envelopeId, routing: 'FORWARDED' as const };
        }

        if (request.decision === 'reject') {
          await domain.decide({ held, decision: 'REJECTED' }, reason);
          domain.openQueries.delete(envelopeId);
          await tellSender(run, domain, held, reason);
          return { envelopeId, routing: 'REJECTED' as const };
        }

        const edit = editOf(run, domain, held, request);
        await domain.decide({ held, decision: 'EDITED', edit }, reason);
        return { envelopeId, routing: 'EDITED' as const };
      });
    },
  };
}
