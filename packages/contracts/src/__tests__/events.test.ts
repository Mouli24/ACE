import { describe, expect, it } from 'vitest';

import {
  EDGE_TRANSFER_SUMMARY_MAX,
  ENGINE_EVENT_TYPES,
  EngineEventSchema,
  EventSchema,
  EventsQuerySchema,
  PERSISTED_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  TRANSIENT_EVENT_TYPES,
} from '../events.js';
import { ServerFrameSchema, WsServerFrameSchema, isPersistedFrame } from '../ws.js';
import {
  EDGE_ID,
  NODE_A,
  NODE_B,
  NODE_RUN_ID,
  NOW,
  PROVIDER_ID,
  RUN_ID,
  WORKFLOW_ID,
} from './fixtures.js';

const usage = { tokensIn: 12, tokensOut: 40, costUsd: 0.000_092, priceTableVersion: 'mock-v1' };

const summary = {
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  status: 'RUNNING',
  startedAt: NOW,
  totals: usage,
};

/** One valid frame per type of §2.4, in the order §2.4 lists them. */
const frames: Record<string, { type: string; payload: unknown; seq?: number }> = {
  'run.started': { type: 'run.started', payload: { run: summary }, seq: 1 },
  'run.completed': {
    type: 'run.completed',
    payload: { runId: RUN_ID, status: 'COMPLETE', totals: usage },
    seq: 2,
  },
  'node.state': {
    type: 'node.state',
    payload: {
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      nodeId: NODE_A,
      iteration: 1,
      attempt: 1,
      status: 'RUNNING',
    },
    seq: 3,
  },
  'node.token': {
    type: 'node.token',
    payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, delta: 'Hel' },
  },
  'node.output': {
    type: 'node.output',
    payload: {
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      nodeId: NODE_A,
      output: [{ type: 'text', text: 'the answer' }],
      usage,
    },
    seq: 4,
  },
  'node.error': {
    type: 'node.error',
    payload: {
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      nodeId: NODE_A,
      error: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
      failureReason: 'RUN_FAILED',
    },
    seq: 5,
  },
  'edge.transfer': {
    type: 'edge.transfer',
    payload: {
      runId: RUN_ID,
      edgeId: EDGE_ID,
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      iteration: 1,
      summary: 'text (12 words)',
    },
    seq: 6,
  },
  'usage.updated': { type: 'usage.updated', payload: { runId: RUN_ID, totals: usage }, seq: 7 },
};

/** Indexed access is checked in this workspace, so fixture lookup fails loudly instead. */
const payloadOf = (type: string): Record<string, unknown> => {
  const frame = frames[type];
  if (frame === undefined) throw new Error(`no fixture for ${type}`);
  return frame.payload as Record<string, unknown>;
};

describe('FR-EXE-014 RunEvent covers every type of §2.4', () => {
  it('declares exactly the eight run event types', () => {
    expect([...RUN_EVENT_TYPES]).toEqual([
      'run.started',
      'run.completed',
      'node.state',
      'node.token',
      'node.output',
      'node.error',
      'edge.transfer',
      'usage.updated',
    ]);
  });

  it.each(Object.keys(frames))('parses %s', (type) => {
    expect(RunEventSchema.parse(frames[type])).toEqual(frames[type]);
  });

  it('parses every declared type, so the union can never fall behind the list', () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(Object.keys(frames), `${type} needs a fixture`).toContain(type);
      expect(RunEventSchema.safeParse(frames[type]).success, type).toBe(true);
    }
  });

  it('refuses an event type §2.4 does not define', () => {
    expect(RunEventSchema.safeParse({ type: 'node.thinking', payload: {}, seq: 1 }).success).toBe(
      false,
    );
  });
});

describe('§2.4 node.token is transient', () => {
  it('is the only type that carries no seq', () => {
    expect([...TRANSIENT_EVENT_TYPES]).toEqual(['node.token']);
    expect([...PERSISTED_RUN_EVENT_TYPES]).not.toContain('node.token');
    expect(PERSISTED_RUN_EVENT_TYPES).toHaveLength(RUN_EVENT_TYPES.length - 1);
  });

  it('refuses a seq on node.token, because it is never persisted or resumed', () => {
    expect(RunEventSchema.safeParse({ ...frames['node.token'], seq: 9 }).success).toBe(false);
  });

  it('requires a seq on every other type', () => {
    for (const type of PERSISTED_RUN_EVENT_TYPES) {
      const { seq: _seq, ...withoutSeq } = frames[type] as { seq?: number };
      expect(RunEventSchema.safeParse(withoutSeq).success, type).toBe(false);
    }
  });
});

describe('§2.4 run event payloads', () => {
  it('ends a run only in a terminal state', () => {
    for (const status of ['COMPLETE', 'HALTED', 'BLOCKED']) {
      expect(
        RunEventSchema.safeParse({
          type: 'run.completed',
          payload: { runId: RUN_ID, status, totals: usage },
          seq: 2,
        }).success,
        status,
      ).toBe(true);
    }
    expect(
      RunEventSchema.safeParse({
        type: 'run.completed',
        payload: { runId: RUN_ID, status: 'RUNNING', totals: usage },
        seq: 2,
      }).success,
    ).toBe(false);
  });

  it('carries the halt reason and the final output when a run ends', () => {
    const parsed = RunEventSchema.parse({
      type: 'run.completed',
      payload: {
        runId: RUN_ID,
        status: 'HALTED',
        haltReason: 'failure',
        totals: usage,
        finalOutput: { [NODE_B]: [{ type: 'text', text: 'partial' }] },
      },
      seq: 8,
    });

    expect(parsed.type).toBe('run.completed');
  });

  it('carries the failure reason on a state change into FAILED', () => {
    expect(
      RunEventSchema.safeParse({
        type: 'node.state',
        payload: {
          ...payloadOf('node.state'),
          status: 'FAILED',
          failureReason: 'CONTRACT_VIOLATION',
        },
        seq: 3,
      }).success,
    ).toBe(true);
  });

  it('carries the model used with a node output (FR-RTR-006)', () => {
    expect(
      RunEventSchema.safeParse({
        type: 'node.output',
        payload: {
          ...payloadOf('node.output'),
          modelUsed: { providerId: PROVIDER_ID, modelId: 'mock-text', viaFallback: true },
        },
        seq: 4,
      }).success,
    ).toBe(true);
  });

  it('caps an edge.transfer summary at 120 characters (FR-EXE-015)', () => {
    expect(EDGE_TRANSFER_SUMMARY_MAX).toBe(120);
    const payload = payloadOf('edge.transfer');

    expect(
      RunEventSchema.safeParse({
        type: 'edge.transfer',
        payload: { ...payload, summary: 'x'.repeat(120) },
        seq: 6,
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({
        type: 'edge.transfer',
        payload: { ...payload, summary: 'x'.repeat(121) },
        seq: 6,
      }).success,
    ).toBe(false);
  });

  it('refuses a token delta that is not a string', () => {
    expect(
      RunEventSchema.safeParse({
        type: 'node.token',
        payload: { runId: RUN_ID, nodeRunId: NODE_RUN_ID, delta: 42 },
      }).success,
    ).toBe(false);
  });
});

describe('FR-PRV-004 EngineEvent', () => {
  const frame = {
    type: 'provider.status',
    payload: { providerId: PROVIDER_ID, status: 'AUTH_FAILED', message: 'invalid key' },
    seq: 11,
  };

  it('declares provider.status as its only type this round', () => {
    expect([...ENGINE_EVENT_TYPES]).toEqual(['provider.status']);
  });

  it('parses a provider status change', () => {
    expect(EngineEventSchema.parse(frame)).toEqual(frame);
  });

  it('refuses a status that is not a ProviderState', () => {
    expect(
      EngineEventSchema.safeParse({ ...frame, payload: { providerId: PROVIDER_ID, status: 'down' } })
        .success,
    ).toBe(false);
  });
});

describe('FR-EXE-014 the persisted event log', () => {
  it('stores a global seq, a time, a type and its payload', () => {
    const event = {
      seq: 12,
      at: NOW,
      runId: RUN_ID,
      type: 'node.state',
      payload: { status: 'COMPLETED' },
    };

    expect(EventSchema.parse(event)).toEqual(event);
  });

  it('scopes an event to a run, a workflow, both or neither', () => {
    expect(EventSchema.safeParse({ seq: 1, at: NOW, type: 'provider.status', payload: {} }).success).toBe(
      true,
    );
    expect(
      EventSchema.safeParse({ seq: 1, at: NOW, workflowId: WORKFLOW_ID, type: 'workflow.updated', payload: {} })
        .success,
    ).toBe(true);
  });

  it('reads afterSeq off the query string of GET /runs/:id/events', () => {
    expect(EventsQuerySchema.parse({})).toEqual({});
    expect(EventsQuerySchema.parse({ afterSeq: '41' }).afterSeq).toBe(41);
    expect(EventsQuerySchema.parse({ afterSeq: 0 }).afterSeq).toBe(0);
    expect(EventsQuerySchema.safeParse({ afterSeq: -1 }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ afterSeq: 'soon' }).success).toBe(false);
  });

  it('refuses a negative or fractional seq — resume depends on it being monotonic', () => {
    expect(EventSchema.safeParse({ seq: -1, at: NOW, type: 'x', payload: {} }).success).toBe(false);
    expect(EventSchema.safeParse({ seq: 1.5, at: NOW, type: 'x', payload: {} }).success).toBe(false);
  });
});

describe('FR-EXE-014 run events travel on the round 1 socket', () => {
  it.each(Object.keys(frames))('the whole-socket union accepts %s', (type) => {
    expect(ServerFrameSchema.parse(frames[type])).toEqual(frames[type]);
  });

  it('still accepts the round 1 frames', () => {
    expect(ServerFrameSchema.parse({ type: 'hello', payload: { seq: 0 } }).type).toBe('hello');
    expect(
      ServerFrameSchema.parse({
        type: 'workflow.updated',
        payload: { workflowId: WORKFLOW_ID, version: 4 },
        seq: 13,
      }).type,
    ).toBe('workflow.updated');
  });

  it('accepts provider.status on the engine scope', () => {
    expect(
      ServerFrameSchema.parse({
        type: 'provider.status',
        payload: { providerId: PROVIDER_ID, status: 'CONNECTED' },
        seq: 14,
      }).type,
    ).toBe('provider.status');
  });

  it('leaves the round 1 union alone, so @ace/sdk keeps compiling until M2 (D54)', () => {
    expect(WsServerFrameSchema.safeParse(frames['node.token']).success).toBe(false);
    expect(WsServerFrameSchema.parse({ type: 'hello', payload: { seq: 0 } }).type).toBe('hello');
  });

  it('tells a resuming client which frames carry a seq', () => {
    expect(isPersistedFrame(ServerFrameSchema.parse(frames['node.state']))).toBe(true);
    expect(isPersistedFrame(ServerFrameSchema.parse(frames['node.token']))).toBe(false);
  });
});
