import { describe, expect, it } from 'vitest';

import { ERROR_KINDS } from '../enums.js';
import {
  NodeErrorSchema,
  NodeRunSchema,
  RunSchema,
  RunSummarySchema,
  StartRunRequestSchema,
  UsageSchema,
  ZERO_USAGE,
  zeroUsage,
} from '../runs.js';
import {
  EDGE_ID,
  ENVELOPE_ID,
  NODE_A,
  NODE_B,
  NODE_RUN_ID,
  NOW,
  PROJECT_ID,
  PROVIDER_ID,
  RUN_ID,
  WORKFLOW_ID,
} from './fixtures.js';

const inputNode = {
  id: NODE_A,
  workflowId: WORKFLOW_ID,
  kind: 'input',
  name: 'Brief',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${NODE_A}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { artifactIds: [], outputTypes: ['text'] },
};

const outputNode = {
  id: NODE_B,
  workflowId: WORKFLOW_ID,
  kind: 'output',
  name: 'Result',
  position: { x: 300, y: 0 },
  inputs: [{ id: `${NODE_B}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [],
  config: {},
};

const edge = {
  id: EDGE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'data',
  from: { nodeId: NODE_A, portId: `${NODE_A}:out:text` },
  to: { nodeId: NODE_B, portId: `${NODE_B}:in:text` },
};

const usage = { tokensIn: 12, tokensOut: 40, costUsd: 0.000_092, priceTableVersion: 'mock-v1' };

const run = {
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  projectId: PROJECT_ID,
  status: 'COMPLETE',
  snapshot: { version: 7, nodes: [inputNode, outputNode], edges: [edge] },
  inputs: { [NODE_A]: [{ type: 'text', text: 'a sentence' }] },
  preflightIssues: [],
  totals: usage,
  startedAt: NOW,
  endedAt: NOW,
  durationMs: 412,
  finalOutput: { [NODE_B]: [{ type: 'text', text: 'the answer' }] },
};

const nodeRun = {
  id: NODE_RUN_ID,
  runId: RUN_ID,
  nodeId: NODE_A,
  iteration: 1,
  attempt: 1,
  status: 'COMPLETED',
  inputEnvelopes: [],
  usage,
  verdicts: [],
  toolCalls: [],
};

/* -------------------------------------------------------------------------- */
/* Usage                                                                       */
/* -------------------------------------------------------------------------- */

describe('FR-OBS-002 Usage', () => {
  it('records tokens in, tokens out and the cost estimate', () => {
    expect(UsageSchema.parse(usage)).toEqual(usage);
  });

  it('records the price table version the estimate came from (FR-OBS-003)', () => {
    expect(UsageSchema.parse({ tokensIn: 0, tokensOut: 0, costUsd: 0 }).priceTableVersion).toBe(
      undefined,
    );
    expect(UsageSchema.parse(usage).priceTableVersion).toBe('mock-v1');
  });

  it('refuses negative tokens or cost', () => {
    expect(UsageSchema.safeParse({ ...usage, tokensIn: -1 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, costUsd: -0.01 }).success).toBe(false);
  });

  it('refuses fractional token counts', () => {
    expect(UsageSchema.safeParse({ ...usage, tokensOut: 1.5 }).success).toBe(false);
  });

  it('starts every total at zero, with a fresh object each time', () => {
    expect(zeroUsage()).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(zeroUsage()).not.toBe(zeroUsage());
    expect(UsageSchema.parse(ZERO_USAGE)).toEqual(ZERO_USAGE);
  });
});

/* -------------------------------------------------------------------------- */
/* NodeError                                                                   */
/* -------------------------------------------------------------------------- */

describe('Arch §28 NodeError', () => {
  const error = {
    kind: 'provider',
    code: 'http_503',
    message: 'service unavailable',
    retryable: true,
    providerId: PROVIDER_ID,
  };

  it('carries kind, code, message, retryability and the provider (Arch §28)', () => {
    expect(NodeErrorSchema.parse(error)).toEqual(error);
  });

  it.each([...ERROR_KINDS])('accepts error kind %s', (kind) => {
    expect(NodeErrorSchema.safeParse({ ...error, kind }).success).toBe(true);
  });

  it('refuses a kind outside the eight of §7', () => {
    expect(NodeErrorSchema.safeParse({ ...error, kind: 'timeout' }).success).toBe(false);
  });

  it('always states whether a retry is worth it', () => {
    const { retryable: _retryable, ...withoutRetryable } = error;

    expect(NodeErrorSchema.safeParse(withoutRetryable).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

describe('BR-04 a run is an immutable snapshot', () => {
  it('carries the nodes, edges and graph version it froze at start', () => {
    const parsed = RunSchema.parse(run);

    expect(parsed.snapshot.version).toBe(7);
    expect(parsed.snapshot.nodes).toHaveLength(2);
    expect(parsed.snapshot.edges).toHaveLength(1);
  });

  it('refuses a run with no snapshot', () => {
    const { snapshot: _snapshot, ...withoutSnapshot } = run;

    expect(RunSchema.safeParse(withoutSnapshot).success).toBe(false);
  });
});

describe('FR-EXE-001 Run', () => {
  it('accepts every RunState', () => {
    for (const status of ['PREFLIGHT', 'RUNNING', 'PAUSED', 'COMPLETE', 'BLOCKED', 'HALTED']) {
      expect(RunSchema.safeParse({ ...run, status }).success, status).toBe(true);
    }
  });

  it('refuses the node state COMPLETED where a run state belongs (BR-03)', () => {
    expect(RunSchema.safeParse({ ...run, status: 'COMPLETED' }).success).toBe(false);
  });

  it('records why a run halted', () => {
    const halted = RunSchema.parse({ ...run, status: 'HALTED', haltReason: 'failure' });

    expect(halted.haltReason).toBe('failure');
    expect(RunSchema.safeParse({ ...run, haltReason: 'because' }).success).toBe(false);
  });

  it('keys the inputs given at start by Input node id (FR-NODE-011)', () => {
    expect(RunSchema.parse(run).inputs[NODE_A]).toEqual([{ type: 'text', text: 'a sentence' }]);
    expect(RunSchema.safeParse({ ...run, inputs: { 'node-a': [] } }).success).toBe(false);
  });

  it('keys the final output by Output node id (FR-NODE-012)', () => {
    expect(RunSchema.parse(run).finalOutput?.[NODE_B]).toEqual([
      { type: 'text', text: 'the answer' },
    ]);
  });

  it('is still a recorded run when pre-flight blocked it (FR-EXE-003)', () => {
    const blocked = RunSchema.parse({
      ...run,
      status: 'BLOCKED',
      endedAt: undefined,
      durationMs: undefined,
      finalOutput: undefined,
      preflightIssues: [
        { severity: 'error', code: 'provider_missing', message: 'Agent has no provider', nodeId: NODE_A },
      ],
    });

    expect(blocked.preflightIssues).toHaveLength(1);
    expect(blocked.preflightIssues[0]?.code).toBe('provider_missing');
  });

  it('requires a totals object even before anything was spent', () => {
    const { totals: _totals, ...withoutTotals } = run;

    expect(RunSchema.safeParse(withoutTotals).success).toBe(false);
  });
});

describe('TC-EXE-011 RunSummary', () => {
  it('is exactly the eight fields §2.3 picks from Run', () => {
    expect(Object.keys(RunSummarySchema.shape).sort()).toEqual(
      ['durationMs', 'endedAt', 'haltReason', 'id', 'startedAt', 'status', 'totals', 'workflowId'].sort(),
    );
  });

  it('parses a row of the history list', () => {
    const summary = {
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: 'COMPLETE',
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 412,
      totals: usage,
    };

    expect(RunSummarySchema.parse(summary)).toEqual(summary);
  });

  it('carries no snapshot, so a history page never ships every node', () => {
    expect(RunSummarySchema.shape).not.toHaveProperty('snapshot');
  });
});

/* -------------------------------------------------------------------------- */
/* NodeRun                                                                     */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-010 NodeRun', () => {
  it('accepts the minimum a dispatched node run needs', () => {
    expect(NodeRunSchema.parse(nodeRun)).toEqual(nodeRun);
  });

  it('numbers iterations and attempts from 1', () => {
    expect(NodeRunSchema.safeParse({ ...nodeRun, iteration: 0 }).success).toBe(false);
    expect(NodeRunSchema.safeParse({ ...nodeRun, attempt: 0 }).success).toBe(false);
  });

  it('accepts every NodeState', () => {
    for (const status of [
      'IDLE',
      'READY',
      'RUNNING',
      'WAITING',
      'COMPLETED',
      'PAUSED',
      'STOPPED',
      'BLOCKED',
      'FAILED',
    ]) {
      expect(NodeRunSchema.safeParse({ ...nodeRun, status }).success, status).toBe(true);
    }
  });

  it('refuses the run state COMPLETE where a node state belongs (BR-03)', () => {
    expect(NodeRunSchema.safeParse({ ...nodeRun, status: 'COMPLETE' }).success).toBe(false);
  });

  it('keeps CONTRACT_VIOLATION distinct from RUN_FAILED (BR-03)', () => {
    const violated = NodeRunSchema.parse({
      ...nodeRun,
      status: 'FAILED',
      failureReason: 'CONTRACT_VIOLATION',
      error: { kind: 'agent', code: 'contract_violation', message: 'not json', retryable: false },
    });

    expect(violated.failureReason).toBe('CONTRACT_VIOLATION');
    expect(NodeRunSchema.safeParse({ ...nodeRun, failureReason: 'FAILED' }).success).toBe(false);
  });

  it('records the model actually used and whether a fallback answered (FR-RTR-006)', () => {
    const parsed = NodeRunSchema.parse({
      ...nodeRun,
      modelUsed: { providerId: PROVIDER_ID, modelId: 'mock-text', viaFallback: true },
    });

    expect(parsed.modelUsed).toEqual({
      providerId: PROVIDER_ID,
      modelId: 'mock-text',
      viaFallback: true,
    });
  });

  it('always says whether the model came from the fallback chain', () => {
    expect(
      NodeRunSchema.safeParse({
        ...nodeRun,
        modelUsed: { providerId: PROVIDER_ID, modelId: 'mock-text' },
      }).success,
    ).toBe(false);
  });

  it('records the exact prompt and its version (FR-PRM-004, FR-PRM-005)', () => {
    const parsed = NodeRunSchema.parse({
      ...nodeRun,
      prompt: { version: 'a1b2c3d4e5f6', text: '## System\n...' },
    });

    expect(parsed.prompt?.version).toBe('a1b2c3d4e5f6');
    expect(NodeRunSchema.safeParse({ ...nodeRun, prompt: { text: 'x' } }).success).toBe(false);
  });

  it('keeps the envelopes it was given and the parts it produced', () => {
    const parsed = NodeRunSchema.parse({
      ...nodeRun,
      inputEnvelopes: [
        {
          id: ENVELOPE_ID,
          runId: RUN_ID,
          fromNodeId: NODE_A,
          toNodeId: NODE_B,
          iteration: 1,
          reads: [{ type: 'text', text: 'a sentence' }],
          context: { budgetTokens: 4000, trust: 'untrusted' },
          contract: { outputTypes: ['text'] },
          createdAt: NOW,
        },
      ],
      output: [{ type: 'text', text: 'the answer' }],
    });

    expect(parsed.inputEnvelopes).toHaveLength(1);
    expect(parsed.output).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('holds the verdict and tool-call lists later rounds type', () => {
    expect(NodeRunSchema.parse(nodeRun).verdicts).toEqual([]);
    const { verdicts: _verdicts, ...withoutVerdicts } = nodeRun;
    expect(NodeRunSchema.safeParse(withoutVerdicts).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* StartRunRequest                                                             */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-001 StartRunRequest', () => {
  it('starts a run with no body at all', () => {
    expect(StartRunRequestSchema.parse({})).toEqual({});
  });

  it('takes the text typed into the input dialog, keyed by Input node', () => {
    const body = { inputs: { [NODE_A]: [{ type: 'text', text: 'a sentence' }] } };

    expect(StartRunRequestSchema.parse(body)).toEqual(body);
  });

  it('takes the node to start from, which the engine honours from round 3 (FR-EXE-013)', () => {
    expect(StartRunRequestSchema.parse({ startFromNodeId: NODE_B }).startFromNodeId).toBe(NODE_B);
    expect(StartRunRequestSchema.safeParse({ startFromNodeId: 'node-b' }).success).toBe(false);
  });
});
