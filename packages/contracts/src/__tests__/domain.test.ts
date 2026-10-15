import { describe, expect, it } from 'vitest';

import {
  DomainChatQuerySchema,
  DomainMessageSchema,
  DomainStreamFrameSchema,
  DomainUsageSnapshotSchema,
  EnvelopeBlockSchema,
  HumanMessagePayloadSchema,
  PostRunMessageRequestSchema,
  PricingTableSchema,
  RouteEnvelopeRequestSchema,
  RouteEnvelopeResponseSchema,
  RunDomainConfigInputSchema,
  defaultRunDomainConfig,
} from '../domain.js';
import { EnvelopeSchema } from '../envelope.js';
import {
  EdgeTransferPayloadSchema,
  NodeStatePayloadSchema,
  PERSISTED_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  UsageUpdatedPayloadSchema,
} from '../events.js';
import { AgentConfigSchema, NodeSchema } from '../graph.js';
import { NodePatchSchema } from '../graph-ops.js';
import {
  RUN_ACTIONS,
  RunSchema,
  StartRunRequestSchema,
  UsageSchema,
  allowedRunActions,
} from '../runs.js';
import { TRACE_ENTRY_KIND_BY_EVENT_TYPE } from '../usage.js';
import {
  ENVELOPE_ID,
  MESSAGE_ID,
  NODE_A,
  NODE_B,
  NODE_RUN_ID,
  NOW,
  RUN_ID,
  WORKFLOW_ID,
} from './fixtures.js';

/* D303: Domain's run events, the fields added to existing ones, and the projected shapes. */

const DOMAIN_EVENT_TYPES = [
  'human.message',
  'instruction.state',
  'envelope.sent',
  'envelope.routed',
  'node.interrupted',
  'run.token_budget',
  'run.config',
  'run.blocked',
  'run.parked',
] as const;

describe('D303 Domain run events', () => {
  it('are run events, persisted, and each has a trace kind', () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      expect(RUN_EVENT_TYPES).toContain(type);
      expect(PERSISTED_RUN_EVENT_TYPES).toContain(type);
      expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE[type]).toBeDefined();
    }
  });

  it('parses a human.message frame and refuses an unknown key', () => {
    const payload = {
      runId: RUN_ID,
      messageId: MESSAGE_ID,
      text: 'Nova, tighten the hook',
      addressing: 'direct',
      mentions: [{ nodeId: NODE_A, handle: 'nova', via: 'name' }],
      deliveryMode: 'queue',
    };
    expect(RunEventSchema.parse({ type: 'human.message', payload, seq: 7 }).type).toBe(
      'human.message',
    );
    expect(() => HumanMessagePayloadSchema.parse({ ...payload, history: [] })).toThrow();
  });

  it('parses the other Domain frames', () => {
    const frames = [
      {
        type: 'instruction.state',
        payload: {
          runId: RUN_ID,
          messageId: MESSAGE_ID,
          nodeId: NODE_A,
          state: 'DELIVERED',
          nodeRunId: NODE_RUN_ID,
        },
      },
      {
        type: 'envelope.sent',
        payload: {
          runId: RUN_ID,
          envelopeId: ENVELOPE_ID,
          nodeRunId: NODE_RUN_ID,
          kind: 'FLAG',
          fromNodeId: NODE_B,
          toNodeIds: [NODE_A],
          summary: 'The hook buries the lede.',
          textSource: 'summary',
          artifacts: [{ path: 'draft.md', bytes: 120, commit: null }],
        },
      },
      {
        type: 'envelope.routed',
        payload: {
          runId: RUN_ID,
          envelopeId: ENVELOPE_ID,
          decision: 'EDITED',
          by: 'human',
          edit: { summary: 'Shorter hook, please.' },
        },
      },
      {
        type: 'node.interrupted',
        payload: {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          nodeId: NODE_A,
          messageId: MESSAGE_ID,
          partialOutput: [{ type: 'text', text: 'Half a dra' }],
        },
      },
      {
        type: 'run.token_budget',
        payload: { runId: RUN_ID, limit: 1000, used: 820, level: 'WARN' },
      },
      { type: 'run.config', payload: { runId: RUN_ID, config: defaultRunDomainConfig() } },
      {
        type: 'run.blocked',
        payload: {
          runId: RUN_ID,
          reason: 'LOOP_GUARD',
          detail: '4 > 3',
          nodeIds: [NODE_A, NODE_B],
        },
      },
      { type: 'run.parked', payload: { runId: RUN_ID, graph: 'complete' } },
    ];
    for (const frame of frames) {
      expect(RunEventSchema.parse({ ...frame, seq: 1 }).type).toBe(frame.type);
    }
  });
});

describe('D303 fields added to existing events', () => {
  const nodeState = {
    runId: RUN_ID,
    nodeRunId: NODE_RUN_ID,
    nodeId: NODE_A,
    iteration: 1,
    attempt: 2,
    status: 'RUNNING',
  };

  it('node.state carries a turn trigger and a duration, and still parses without them', () => {
    expect(NodeStatePayloadSchema.parse(nodeState)).toEqual(nodeState);
    expect(
      NodeStatePayloadSchema.parse({
        ...nodeState,
        trigger: { kind: 'instruction', messageIds: [MESSAGE_ID] },
      }).trigger,
    ).toEqual({ kind: 'instruction', messageIds: [MESSAGE_ID] });
    expect(
      NodeStatePayloadSchema.parse({ ...nodeState, status: 'COMPLETED', durationMs: 1200 })
        .durationMs,
    ).toBe(1200);
  });

  it('usage.updated carries the turn whose usage it adds (D313)', () => {
    const payload = {
      runId: RUN_ID,
      totals: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
      turn: {
        nodeRunId: NODE_RUN_ID,
        nodeId: NODE_A,
        providerType: 'claude_code',
        modelId: 'sonnet',
        usage: {
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.002,
          source: 'reported',
          costSource: 'reported',
          cachedTokensIn: 4,
        },
      },
    };
    expect(UsageUpdatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('edge.transfer can name the envelope it delivered', () => {
    const payload = {
      runId: RUN_ID,
      edgeId: NODE_B,
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      iteration: 1,
      summary: 'text · ~3 tokens',
      envelopeId: ENVELOPE_ID,
    };
    expect(EdgeTransferPayloadSchema.parse(payload).envelopeId).toBe(ENVELOPE_ID);
  });

  it('usage keeps its old shape valid and gains source, costSource and cached input', () => {
    expect(UsageSchema.parse({ tokensIn: 1, tokensOut: 2, costUsd: 0 })).toEqual({
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0,
    });
    expect(() =>
      UsageSchema.parse({ tokensIn: 1, tokensOut: 2, costUsd: 0, source: 'guessed' }),
    ).toThrow();
  });

  it('an edge envelope may name its team envelope, and old envelopes still parse', () => {
    const envelope = {
      id: ENVELOPE_ID,
      runId: RUN_ID,
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      iteration: 1,
      reads: [],
      context: { budgetTokens: 1000, trust: 'untrusted' },
      contract: { outputTypes: ['text'] },
      createdAt: NOW,
    };
    expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(EnvelopeSchema.parse({ ...envelope, teamEnvelopeId: MESSAGE_ID }).teamEnvelopeId).toBe(
      MESSAGE_ID,
    );
  });
});

describe('D304/D308 node handles and the Brain flag', () => {
  const node = {
    id: NODE_A,
    workflowId: WORKFLOW_ID,
    kind: 'agent',
    name: 'Nova',
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [],
    config: { instructions: 'Write.', inputTypes: ['text'], outputTypes: ['text'] },
  };

  it('a node may carry a handle, which must be a valid one', () => {
    expect(NodeSchema.parse({ ...node, handle: 'nova-2' }).handle).toBe('nova-2');
    expect(() => NodeSchema.parse({ ...node, handle: 'Nova' })).toThrow();
    expect(() => NodeSchema.parse({ ...node, handle: '2nova' })).toThrow();
  });

  it('update_node can set a handle or clear it with null', () => {
    expect(NodePatchSchema.parse({ handle: 'writer' }).handle).toBe('writer');
    expect(NodePatchSchema.parse({ handle: null }).handle).toBeNull();
  });

  it('an Agent can be marked the Brain', () => {
    expect(AgentConfigSchema.parse({ ...node.config, brain: true }).brain).toBe(true);
    expect(AgentConfigSchema.parse(node.config).brain).toBeUndefined();
  });
});

describe('D305/D312/D323 runs', () => {
  it('a start request takes a goal and Domain config, with defaults', () => {
    const parsed = StartRunRequestSchema.parse({
      goal: 'Write a tagline',
      domain: { stayOpen: true },
    });
    expect(parsed.goal).toBe('Write a tagline');
    expect(parsed.domain).toEqual({
      routing: 'supervised',
      loopGuardLimit: 3,
      tokenBudget: null,
      stayOpen: true,
    });
    expect(StartRunRequestSchema.parse({}).domain).toBeUndefined();
    expect(() => StartRunRequestSchema.parse({ goal: '' })).toThrow();
    expect(RunDomainConfigInputSchema.parse({})).toEqual(defaultRunDomainConfig());
  });

  it('`end` is a run action, offered only to runs that stay open; D360: so is restart while open', () => {
    expect([...RUN_ACTIONS]).toEqual(['pause', 'resume', 'stop', 'restart', 'end']);
    expect(allowedRunActions('RUNNING')).toEqual(['pause', 'stop']);
    expect(allowedRunActions('RUNNING', { stayOpen: true })).toEqual([
      'pause',
      'stop',
      'restart',
      'end',
    ]);
    expect(allowedRunActions('PAUSED', { stayOpen: true })).toEqual([
      'resume',
      'stop',
      'restart',
      'end',
    ]);
  });

  it('a run BLOCKED mid-run can be resumed or stopped; one blocked at pre-flight only restarted', () => {
    expect(allowedRunActions('BLOCKED')).toEqual(['restart']);
    expect(allowedRunActions('BLOCKED', { blockedReason: 'LOOP_GUARD' })).toEqual([
      'resume',
      'stop',
    ]);
    expect(
      allowedRunActions('BLOCKED', { blockedReason: 'BUDGET_EXCEEDED', stayOpen: true }),
    ).toEqual(['resume', 'stop', 'restart', 'end']);
  });

  it('a run records why it is blocked and its Domain config', () => {
    const run = {
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      projectId: WORKFLOW_ID,
      status: 'BLOCKED',
      snapshot: { version: 1, nodes: [], edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      startedAt: NOW,
      blockedReason: 'BUDGET_EXCEEDED',
      domain: { ...defaultRunDomainConfig(), tokenBudget: 500 },
    };
    const parsed = RunSchema.parse(run);
    expect(parsed.blockedReason).toBe('BUDGET_EXCEEDED');
    expect(parsed.domain?.tokenBudget).toBe(500);
  });
});

describe('D310/D314 bodies and frames', () => {
  it('an envelope block needs a kind, recipients and a summary', () => {
    expect(
      EnvelopeBlockSchema.parse({ kind: 'QUERY', to: ['@research'], summary: ' Which year? ' })
        .summary,
    ).toBe('Which year?');
    expect(() =>
      EnvelopeBlockSchema.parse({ kind: 'QUERY', to: ['@research'], summary: '' }),
    ).toThrow();
    expect(() => EnvelopeBlockSchema.parse({ kind: 'CHAT', to: ['@x'], summary: 'hi' })).toThrow();
    expect(() => EnvelopeBlockSchema.parse({ kind: 'FLAG', to: [], summary: 'hi' })).toThrow();
  });

  it('a message defaults to queue delivery', () => {
    expect(PostRunMessageRequestSchema.parse({ text: 'Nova, go' })).toEqual({
      text: 'Nova, go',
      deliveryMode: 'queue',
    });
    expect(() => PostRunMessageRequestSchema.parse({ text: '   ' })).toThrow();
  });

  it('a route request is approve, reject or edit', () => {
    expect(
      RouteEnvelopeRequestSchema.parse({ decision: 'edit', edit: { summary: 'x' } }).decision,
    ).toBe('edit');
    expect(() => RouteEnvelopeRequestSchema.parse({ decision: 'forward' })).toThrow();
  });

  it('a route answer names the envelope and what became of it', () => {
    const envelopeId = '01JBXQ8Z9KQ4R7N2VWXYZ0E001';
    expect(RouteEnvelopeResponseSchema.parse({ envelopeId, routing: 'EDITED' })).toEqual({
      envelopeId,
      routing: 'EDITED',
    });
    expect(() => RouteEnvelopeResponseSchema.parse({ envelopeId, routing: 'SENT' })).toThrow();
  });

  it('the chat query reads a cursor and caps the page', () => {
    expect(DomainChatQuerySchema.parse({ after: '42.1', limit: '50' })).toEqual({
      after: '42.1',
      limit: 50,
    });
    expect(() => DomainChatQuerySchema.parse({ limit: 501 })).toThrow();
    expect(() => DomainChatQuerySchema.parse({ after: 'abc' })).toThrow();
  });

  it('a projected message and a usage snapshot parse, and so do the SSE frames', () => {
    const message = {
      id: `turn:${NODE_RUN_ID}`,
      runId: RUN_ID,
      cursor: '12.0',
      author: { kind: 'node', nodeId: NODE_A },
      type: 'agent',
      text: 'Draft ready.',
      textSource: 'auto',
      turn: {
        turnId: NODE_RUN_ID,
        trigger: 'dispatch',
        iteration: 1,
        attempt: 1,
        steps: [],
        outcome: 'OK',
        durationMs: 900,
      },
      at: NOW,
    };
    expect(DomainMessageSchema.parse(message)).toEqual(message);
    const snapshot = {
      runId: RUN_ID,
      budget: null,
      total: { input: 10, output: 5, cachedInput: 0, estimatedShare: 0 },
      costEst: null,
      perNode: [],
      perTurn: [],
    };
    expect(DomainUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(DomainStreamFrameSchema.parse({ event: 'chat.update', data: { message } }).event).toBe(
      'chat.update',
    );
  });

  it('the pricing table ships empty and refuses an unknown provider', () => {
    expect(PricingTableSchema.parse({ models: [] })).toEqual({ models: [] });
    expect(() =>
      PricingTableSchema.parse({
        models: [{ provider: 'nope', model: 'x', inputPer1M: 1, outputPer1M: 1 }],
      }),
    ).toThrow();
  });
});
