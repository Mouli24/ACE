import {
  HumanMessagePayloadSchema,
  defaultRunDomainConfig,
  rosterFor,
  type Id,
  type Run,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import type { Repository, Scope } from '../ports/index.js';
import { domainContextFor } from './context.js';
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
        const projection = createDomainProjection(domainContextFor(run.id, run.snapshot.nodes));
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
