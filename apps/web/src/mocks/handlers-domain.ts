import {
  DomainChatQuerySchema,
  PostRunMessageRequestSchema,
  PutRunBudgetRequestSchema,
  RouteEnvelopeRequestSchema,
  aceError,
  allowedRunActions,
  parseAddressing,
  resolveAddressing,
  rosterFor,
  type DomainMessage,
  type DomainStreamFrame,
  type DomainUsageSnapshot,
  type ErrorKind,
  type Id,
  type NodeState,
  type Run,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * Domain's endpoints against the mock engine (D303, D310, D313, D314, D323). The real engine
 * projects a run's events into its conversation; the mock keeps the conversation itself — seeded by
 * a test or the dev fixtures — and changes it the way the engine would: a message appends a human
 * message with its deliveries PENDING, a decision moves a held envelope, End ends the run. Every
 * change is also pushed to the run's open streams, as frames, the way the real stream sends them.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

interface Subscriber {
  node: Id | undefined;
  send(frame: DomainStreamFrame, id?: string): void;
}

const conversations = new Map<Id, DomainMessage[]>();
const usages = new Map<Id, DomainUsageSnapshot>();
const subscribers = new Map<Id, Set<Subscriber>>();
let seq = 10_000;

export const domainMock = {
  /** Every Domain request the mock answered, in order — what a test asserts against. */
  requests: [] as Recorded[],
  reset(): void {
    conversations.clear();
    usages.clear();
    for (const set of subscribers.values()) set.clear();
    subscribers.clear();
    domainMock.requests.length = 0;
    seq = 10_000;
  },
  seed(runId: Id, messages: DomainMessage[], usage?: DomainUsageSnapshot): void {
    conversations.set(runId, [...messages]);
    if (usage !== undefined) usages.set(runId, usage);
  },
  /** Send a frame to the run's open streams, as the engine would on a new event. */
  push(runId: Id, frame: DomainStreamFrame): void {
    seq += 1;
    for (const subscriber of subscribers.get(runId) ?? []) {
      if (frame.event === 'chat.message' || frame.event === 'chat.update') {
        if (!inLens(frame.data.message, subscriber.node)) continue;
      }
      subscriber.send(frame, frame.event === 'turn.token' ? undefined : String(seq));
    }
  },
};

const inLens = (message: DomainMessage, node: Id | undefined): boolean =>
  node === undefined ||
  message.author.nodeId === node ||
  (message.to?.includes(node) ?? false) ||
  message.envelope?.from === node;

function error(status: number, kind: ErrorKind, code: string, message: string, details?: unknown) {
  return HttpResponse.json(aceError(kind, code, message, { details, retryable: false }), {
    status,
  });
}
const notFound = (what: string) => error(404, 'workflow', 'not_found', `${what} not found.`);
const ended = (run: Run) =>
  error(409, 'workflow', 'invalid_run_state', `The run is ${run.status} — it has ended.`);
const invalid = (details: unknown, message = 'The request is not valid.') =>
  error(400, 'invalid_config', 'validation_failed', message, details);

const isLive = (run: Run): boolean =>
  run.status === 'RUNNING' ||
  run.status === 'PAUSED' ||
  (run.status === 'BLOCKED' && run.blockedReason !== undefined);

function emptyUsage(run: Run): DomainUsageSnapshot {
  return {
    runId: run.id,
    budget:
      run.domain === undefined || run.domain.tokenBudget === null
        ? null
        : { limit: run.domain.tokenBudget, used: 0, level: 'OK' },
    total: { input: 0, output: 0, cachedInput: 0, estimatedShare: 0 },
    costEst: null,
    perNode: rosterFor(run.snapshot.nodes).map((entry) => ({
      nodeId: entry.nodeId,
      handle: entry.handle,
      name: entry.name,
      brain: entry.brain,
      state: 'IDLE' as const,
      activity: 'idle',
      input: 0,
      output: 0,
      source: null,
      costEst: null,
      budgetShare: null,
    })),
    perTurn: [],
  };
}

const usageOf = (run: Run): DomainUsageSnapshot => usages.get(run.id) ?? emptyUsage(run);
const messagesOf = (runId: Id): DomainMessage[] => conversations.get(runId) ?? [];

async function jsonOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function replace(runId: Id, message: DomainMessage): void {
  conversations.set(
    runId,
    messagesOf(runId).map((each) => (each.id === message.id ? message : each)),
  );
}

export function createDomainHandlers(db: MockDb): HttpHandler[] {
  const record = async (ctx: Ctx, withBody = false): Promise<Recorded> => {
    const url = new URL(ctx.request.url);
    const entry: Recorded = {
      method: ctx.request.method,
      path: url.pathname.replace(/^.*\/api\/v1/u, ''),
      query: Object.fromEntries(url.searchParams),
      ...(withBody ? { body: await jsonOf(ctx.request.clone()) } : {}),
    };
    domainMock.requests.push(entry);
    return entry;
  };
  const runOf = (ctx: Ctx): Run | undefined => {
    db.load();
    return db.getRun(String(ctx.params['runId'] ?? ''));
  };

  return [
    http.get(`${API}/runs/:runId/chat/stream`, async (ctx) => {
      const recorded = await record(ctx);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      const node = recorded.query['node'];
      const encoder = new TextEncoder();
      let subscriber: Subscriber | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (frame: DomainStreamFrame, id?: string): void => {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: ${frame.event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(frame.data)}\n\n`,
                ),
              );
            } catch {
              // The reader went away.
            }
          };
          for (const message of messagesOf(run.id).filter((each) => inLens(each, node))) {
            send({ event: 'chat.message', data: { message } }, message.cursor.split('.')[0]);
          }
          send({ event: 'usage.snapshot', data: { snapshot: usageOf(run) } });
          subscriber = { node, send };
          const set = subscribers.get(run.id) ?? new Set<Subscriber>();
          set.add(subscriber);
          subscribers.set(run.id, set);
        },
        cancel() {
          if (subscriber !== undefined) subscribers.get(run.id)?.delete(subscriber);
        },
      });
      return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
    }),

    http.get(`${API}/runs/:runId/chat`, async (ctx) => {
      const recorded = await record(ctx);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      const query = DomainChatQuerySchema.safeParse(recorded.query);
      if (!query.success) return invalid(query.error.issues);
      const lens = messagesOf(run.id).filter((each) => inLens(each, query.data.node));
      const start =
        query.data.after === undefined
          ? 0
          : lens.findIndex((each) => each.cursor === query.data.after) + 1;
      const limit = query.data.limit ?? 200;
      const messages = lens.slice(start, start + limit);
      const last = messages.at(-1);
      return HttpResponse.json({
        messages,
        ...(start + limit < lens.length && last !== undefined ? { nextCursor: last.cursor } : {}),
      });
    }),

    http.get(`${API}/runs/:runId/usage`, async (ctx) => {
      await record(ctx);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      return HttpResponse.json(usageOf(run));
    }),

    http.post(`${API}/runs/:runId/messages`, async (ctx) => {
      const recorded = await record(ctx, true);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      if (!isLive(run)) return ended(run);
      const parsed = PostRunMessageRequestSchema.safeParse(recorded.body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const roster = rosterFor(run.snapshot.nodes);
      const states: Record<Id, NodeState> = Object.fromEntries(
        usageOf(run).perNode.map((entry) => [entry.nodeId, entry.state]),
      );
      const resolved = resolveAddressing({
        parsed: parseAddressing(parsed.data.text, roster),
        roster,
        states,
        deliveryMode: parsed.data.deliveryMode,
        ...(parsed.data.exclude === undefined ? {} : { exclude: parsed.data.exclude }),
      });
      if (!resolved.ok) {
        return invalid(
          { errors: resolved.errors },
          resolved.errors[0]?.message ?? 'Cannot be sent.',
        );
      }
      seq += 1;
      const messageId = newId();
      const message: DomainMessage = {
        id: messageId,
        runId: run.id,
        cursor: `${seq}.0`,
        author: { kind: 'human' },
        type: 'human',
        text: parsed.data.text,
        to: resolved.recipients,
        delivery: resolved.recipients.map((nodeId) => ({ nodeId, state: 'PENDING' as const })),
        at: new Date().toISOString(),
      };
      conversations.set(run.id, [...messagesOf(run.id), message]);
      domainMock.push(run.id, { event: 'chat.message', data: { message } });
      return HttpResponse.json({ messageId, delivery: message.delivery }, { status: 201 });
    }),

    http.post(`${API}/runs/:runId/envelopes/:envelopeId/route`, async (ctx) => {
      const recorded = await record(ctx, true);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      if (!isLive(run)) return ended(run);
      const parsed = RouteEnvelopeRequestSchema.safeParse(recorded.body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const envelopeId = String(ctx.params['envelopeId'] ?? '');
      const held = messagesOf(run.id).find((each) => each.envelope?.id === envelopeId);
      if (held?.envelope === undefined) return notFound('Envelope');
      if (held.envelope.routing !== 'HELD') {
        return error(409, 'workflow', 'invalid_run_state', 'That envelope is not held.');
      }
      const routing =
        parsed.data.decision === 'approve'
          ? 'FORWARDED'
          : parsed.data.decision === 'edit'
            ? 'EDITED'
            : 'REJECTED';
      const summary = parsed.data.edit?.summary;
      const updated: DomainMessage = {
        ...held,
        ...(summary === undefined ? {} : { text: summary }),
        envelope: {
          ...held.envelope,
          routing,
          history: [
            ...held.envelope.history,
            {
              decision: routing,
              by: 'human',
              ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
              at: new Date().toISOString(),
            },
          ],
          ...(routing === 'EDITED'
            ? { original: { kind: held.envelope.kind, to: held.to ?? [], summary: held.text } }
            : {}),
        },
      };
      replace(run.id, updated);
      domainMock.push(run.id, { event: 'chat.update', data: { message: updated } });
      return HttpResponse.json({ envelopeId, routing });
    }),

    http.put(`${API}/runs/:runId/budget`, async (ctx) => {
      const recorded = await record(ctx, true);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      if (!isLive(run)) return ended(run);
      const parsed = PutRunBudgetRequestSchema.safeParse(recorded.body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const current = usageOf(run);
      const used = current.total.input + current.total.output;
      const { limit } = parsed.data;
      const snapshot: DomainUsageSnapshot = {
        ...current,
        budget:
          limit === null
            ? null
            : {
                limit,
                used,
                level: used >= limit ? 'EXCEEDED' : used >= limit * 0.8 ? 'WARN' : 'OK',
              },
      };
      usages.set(run.id, snapshot);
      domainMock.push(run.id, { event: 'usage.snapshot', data: { snapshot } });
      return HttpResponse.json(snapshot);
    }),

    http.post(`${API}/runs/:runId/end`, async (ctx) => {
      await record(ctx);
      const run = runOf(ctx);
      if (run === undefined) return notFound('Run');
      if (!(run.allowedActions ?? []).includes('end')) {
        return error(409, 'workflow', 'invalid_run_state', `A ${run.status} run cannot be ended.`);
      }
      const done = db.updateRun(run.id, {
        status: 'COMPLETE',
        endedAt: new Date().toISOString(),
        allowedActions: allowedRunActions('COMPLETE'),
      });
      db.save();
      seq += 1;
      const message: DomainMessage = {
        id: `sys:${seq}.0`,
        runId: run.id,
        cursor: `${seq}.0`,
        author: { kind: 'system' },
        type: 'system',
        text: 'Run COMPLETE.',
        at: new Date().toISOString(),
      };
      conversations.set(run.id, [...messagesOf(run.id), message]);
      domainMock.push(run.id, { event: 'chat.message', data: { message } });
      return HttpResponse.json(done);
    }),
  ];
}
