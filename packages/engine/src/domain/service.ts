import {
  PostRunMessageRequestSchema,
  parseAddressing,
  resolveAddressing,
  type HumanMention,
  type Id,
  type PostRunMessageRequest,
  type PostRunMessageResponse,
  type Run,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Repository, Scope } from '../ports/index.js';
import { assertRunAction, withAllowedActions } from '../runs/control/actions.js';
import { maskSecrets } from '../security/secret-patterns.js';
import type { DomainRegistry } from './registry.js';

/**
 * The human's way into a run (D309, D323–D326): `POST /runs/:runId/messages` and `POST /runs/:runId/end`.
 *
 * A message is parsed by the same function the composer previews with, so the server's reading is
 * the authority and nothing half-sends: a bad handle, an ambiguous name, a stray `exclude` or `@all`
 * to finished nodes is refused before a single event is written. A message that passes is one
 * `human.message` and one `instruction.state` PENDING per recipient, written under the run's lock so
 * it can never land after the drive has closed the run.
 */

export interface DomainService {
  postMessage(runId: Id, request: PostRunMessageRequest): Promise<PostRunMessageResponse>;
  /** D323: end a run started from Domain; answers with the run as it ended. */
  end(runId: Id): Promise<Run>;
}

export interface DomainServiceDeps {
  repository: Pick<Repository, 'runs'>;
  scope: Scope;
  bus: Pick<EventBus, 'emit'>;
  domains: DomainRegistry;
  now?: () => string;
  nextId?: () => string;
}

/** A run that can still take a message: going, paused, or blocked mid-run (D305). */
const isLive = (run: Run): boolean =>
  run.status === 'RUNNING' ||
  run.status === 'PAUSED' ||
  (run.status === 'BLOCKED' && run.blockedReason !== undefined);

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
      return withAllowedActions(await domain.finished());
    },
  };
}
