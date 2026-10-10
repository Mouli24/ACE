import {
  EnvelopeRoutedPayloadSchema,
  EnvelopeSentPayloadSchema,
  HumanMessagePayloadSchema,
  NodeOutputPayloadSchema,
  NodeStatePayloadSchema,
  RunBlockedPayloadSchema,
  RunTokenBudgetPayloadSchema,
  UsageUpdatedPayloadSchema,
  defaultRunDomainConfig,
  rosterFor,
  type EnvelopeRoutedPayload,
  type EnvelopeSentPayload,
  type Id,
  type Part,
  type Run,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import type { EngineEvent, Repository, Scope } from '../ports/index.js';
import { countLoop, digestLine, pairKey } from './brain.js';
import { domainContextFor, labelOf, type DomainContext } from './context.js';
import { envelopeBody } from './envelope-block.js';
import { createDomainProjection } from './projection.js';
import { createRunDomain, type RunDomain } from './run-domain.js';

/**
 * Which runs have a live Domain in this process (D309, D323) — the one map the drive registers in
 * and the message route looks up, as `RunGateRegistry` is for the controls.
 */
export interface DomainRegistry {
  /**
   * The run's Domain, created for a drive that is starting. A run that already has events — a
   * re-opened run, or one carried on after an engine restart — gets back the messages it was still
   * owed, rebuilt from its log (D303).
   */
  open(run: Run): Promise<RunDomain>;
  get(runId: Id): RunDomain | undefined;
  /** The drive is over: forget the run, if this is still its Domain. */
  release(domain: RunDomain): void;
  all(): RunDomain[];
}

export interface DomainRegistryDeps {
  bus: Pick<EventBus, 'emit'>;
  repository: Pick<Repository, 'events'>;
  scope: Scope;
}

/**
 * D310, D323: the envelope state a run's log records, put back — what the router or the human still
 * holds, what was forwarded and no turn has taken yet, the QUERYs still open, the loop guard's
 * counts (a resume after LOOP_GUARD reset its pair) and the Brain's digest.
 *
 * A turn that took an envelope and then crashed has used it: the crash ended that turn FAILED, and
 * the envelope is not handed out a second time.
 */
function restoreEnvelopes(
  domain: RunDomain,
  context: DomainContext,
  events: readonly EngineEvent[],
) {
  const label = (nodeId: Id): string => labelOf(context, nodeId);
  const outputs = new Map<Id, Part[]>();
  const iterations = new Map<Id, number>();
  const taken = new Set<string>();
  const sent = new Map<Id, EnvelopeSentPayload & { at: string }>();
  const routing = new Map<Id, EnvelopeRoutedPayload[]>();
  let guarded: Id[] | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'node.output': {
        const parsed = NodeOutputPayloadSchema.safeParse(event.payload);
        if (parsed.success) outputs.set(parsed.data.nodeRunId, parsed.data.output);
        break;
      }
      case 'node.state': {
        const parsed = NodeStatePayloadSchema.safeParse(event.payload);
        if (!parsed.success) break;
        iterations.set(parsed.data.nodeRunId, parsed.data.iteration);
        for (const envelopeId of parsed.data.trigger?.envelopeIds ?? []) {
          taken.add(`${parsed.data.nodeId}:${envelopeId}`);
        }
        break;
      }
      case 'envelope.sent': {
        const parsed = EnvelopeSentPayloadSchema.safeParse(event.payload);
        if (!parsed.success) break;
        const envelope = parsed.data;
        sent.set(envelope.envelopeId, { ...envelope, at: event.createdAt });
        if (envelope.kind === 'QUERY') {
          domain.openQueries.set(envelope.envelopeId, {
            from: envelope.fromNodeId,
            to: envelope.toNodeIds,
          });
        }
        if (envelope.kind === 'ANSWER' && envelope.inReplyTo !== undefined) {
          domain.openQueries.delete(envelope.inReplyTo);
        }
        countLoop(domain.loopCounts, envelope.kind, envelope.fromNodeId, envelope.toNodeIds);
        break;
      }
      case 'envelope.routed': {
        const parsed = EnvelopeRoutedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) break;
        const routed = parsed.data;
        routing.set(routed.envelopeId, [...(routing.get(routed.envelopeId) ?? []), routed]);
        const envelope = sent.get(routed.envelopeId);
        if (envelope !== undefined) {
          domain.noteRouted(
            digestLine(
              label,
              {
                kind: routed.edit?.kind ?? envelope.kind,
                from: envelope.fromNodeId,
                to: routed.edit?.toNodeIds ?? envelope.toNodeIds,
                summary: routed.edit?.summary ?? envelope.summary,
              },
              routed.decision,
            ),
          );
        }
        if (routed.decision === 'REJECTED') domain.openQueries.delete(routed.envelopeId);
        break;
      }
      case 'run.blocked': {
        const parsed = RunBlockedPayloadSchema.safeParse(event.payload);
        if (parsed.success && parsed.data.reason === 'LOOP_GUARD') guarded = parsed.data.nodeIds;
        break;
      }
      case 'run.resumed': {
        const [a, b] = guarded ?? [];
        if (a !== undefined && b !== undefined) domain.loopCounts.delete(pairKey(a, b));
        guarded = undefined;
        break;
      }
      default:
        break;
    }
  }

  for (const [envelopeId, envelope] of sent) {
    const last = routing.get(envelopeId)?.at(-1);
    if (last === undefined) continue;
    const body = envelopeBody(outputs.get(envelope.nodeRunId) ?? []);
    const inReplyTo = envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo };

    if (last.decision === 'HELD') {
      const output = outputs.get(envelope.nodeRunId);
      domain.hold({
        envelopeId,
        kind: envelope.kind,
        fromNodeId: envelope.fromNodeId,
        fromNodeRunId: envelope.nodeRunId,
        toNodeIds: envelope.toNodeIds,
        summary: envelope.summary,
        body,
        ...inReplyTo,
        ...(output === undefined ? {} : { output }),
        iteration: iterations.get(envelope.nodeRunId) ?? 1,
        reason: last.reason === 'LOOP_GUARD' ? 'LOOP_GUARD' : 'manual routing',
      });
      continue;
    }
    if (last.decision === 'REJECTED') continue;

    // A HANDOFF travelled along its edges, and the drive rebuilds those from the node runs.
    const kind = last.edit?.kind ?? envelope.kind;
    if (kind === 'HANDOFF') continue;
    const to = last.edit?.toNodeIds ?? envelope.toNodeIds;
    const waiting = to.filter((nodeId) => !taken.has(`${nodeId}:${envelopeId}`));
    if (waiting.length === 0) continue;
    domain.enqueueEnvelope(
      {
        envelopeId,
        kind,
        fromNodeId: envelope.fromNodeId,
        summary: last.edit?.summary ?? envelope.summary,
        body,
        ...inReplyTo,
        at: envelope.at,
      },
      waiting,
    );
  }
}

/**
 * D313, D323: the budget as the log left it. The limit is the run's own (`run.domain`, which a
 * `PUT /budget` rewrites); what was used is the last running total; WARN and EXCEEDED count as said
 * when the log says them after the latest SET, so a carried-on run neither repeats nor forgets one.
 */
function restoreBudget(domain: RunDomain, events: readonly EngineEvent[]): void {
  let used = 0;
  let warned = false;
  let exceeded = false;
  for (const event of events) {
    if (event.type === 'usage.updated') {
      const parsed = UsageUpdatedPayloadSchema.safeParse(event.payload);
      if (parsed.success) used = parsed.data.totals.tokensIn + parsed.data.totals.tokensOut;
    } else if (event.type === 'run.token_budget') {
      const parsed = RunTokenBudgetPayloadSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      if (parsed.data.level === 'SET') {
        warned = false;
        exceeded = false;
      } else {
        warned = true;
        exceeded ||= parsed.data.level === 'EXCEEDED';
      }
    }
  }
  domain.noteUsed(used);
  domain.noteBudget({ limit: domain.budget().limit, warned, exceeded });
}

export function createDomainRegistry(deps: DomainRegistryDeps): DomainRegistry {
  const live = new Map<Id, RunDomain>();

  return {
    async open(run) {
      const roster = rosterFor(run.snapshot.nodes);
      const domain = createRunDomain({
        run,
        config: run.domain ?? defaultRunDomainConfig(),
        roster,
        emit: (event) => deps.bus.emit(event),
      });

      // What the log says is still PENDING comes back, in the order it was sent.
      const events = await deps.repository.events.listAfter(deps.scope, 0, { runIds: [run.id] });
      if (events.length > 0) {
        const context = domainContextFor(run.id, run.snapshot.nodes);
        restoreEnvelopes(domain, context, events);
        restoreBudget(domain, events);
        const projection = createDomainProjection(context);
        for (const event of events) projection.apply(event);
        const sent = new Map(
          events.flatMap((event) => {
            if (event.type !== 'human.message') return [];
            const parsed = HumanMessagePayloadSchema.safeParse(event.payload);
            return parsed.success
              ? [[parsed.data.messageId, { ...parsed.data, at: event.createdAt }] as const]
              : [];
          }),
        );
        for (const { messageId, nodeId } of projection.pending()) {
          const message = sent.get(messageId);
          if (message === undefined) continue;
          domain.restore(
            {
              messageId,
              text: message.text,
              at: message.at,
              deliveryMode: message.deliveryMode,
              startsTurn: message.addressing !== 'all',
            },
            nodeId,
          );
        }
      }

      live.set(run.id, domain);
      return domain;
    },

    get: (runId) => live.get(runId),

    release(domain) {
      if (live.get(domain.runId) === domain) live.delete(domain.runId);
    },

    all: () => [...live.values()],
  };
}
