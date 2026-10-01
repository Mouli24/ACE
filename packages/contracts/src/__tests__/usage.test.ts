import { describe, expect, it } from 'vitest';

import { ERROR_KINDS } from '../enums.js';
import { PERSISTED_RUN_EVENT_TYPES } from '../events.js';
import {
  DayTotalsSchema,
  HealthMetricsSchema,
  TRACE_ENTRY_KINDS,
  TRACE_ENTRY_KIND_BY_EVENT_TYPE,
  TraceEntrySchema,
  TraceResponseSchema,
  USAGE_GROUP_BY,
  UsageBucketSchema,
  UsageQuerySchema,
  UsageResponseSchema,
} from '../usage.js';
import { NODE_A, NODE_RUN_ID, NOW, PROVIDER_ID, WORKFLOW_ID } from './fixtures.js';

const totals = { tokensIn: 120, tokensOut: 400, costUsd: 0.0021, priceTableVersion: 'mock-v1' };

const bucket = {
  key: { provider: PROVIDER_ID, day: '2026-10-01' },
  tokensIn: 120,
  tokensOut: 400,
  costUsd: 0.0021,
  runs: 2,
};

const trace = {
  seq: 41,
  at: NOW,
  kind: 'node_run',
  nodeId: NODE_A,
  nodeRunId: NODE_RUN_ID,
  label: 'Writer completed',
  detail: { status: 'COMPLETED' },
  durationMs: 812,
};

const zeroFailures = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0]));

const health = {
  runs: { started: 4, completed: 2, halted: 1, blocked: 1 },
  nodeFailuresByKind: { ...zeroFailures, provider: 2 },
  providerLatencyMs: { [PROVIDER_ID]: { p50: 48, p95: 130 } },
  guardrailVerdictsByType: { pii: 3, secret_leak: 1 },
  since: NOW,
};

describe('FR-OBS-004 UsageQuery', () => {
  it('groups by provider, model, day and workflow (§2.6)', () => {
    expect([...USAGE_GROUP_BY]).toEqual(['provider', 'model', 'day', 'workflow']);
  });

  it('reads groupBy as a repeated query parameter, and a single value as a list of one', () => {
    expect(UsageQuerySchema.parse({ groupBy: ['provider', 'day'] }).groupBy).toEqual([
      'provider',
      'day',
    ]);
    expect(UsageQuerySchema.parse({ groupBy: 'model' }).groupBy).toEqual(['model']);
  });

  it('requires at least one grouping, each named once, each one it knows', () => {
    expect(UsageQuerySchema.safeParse({}).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ groupBy: [] }).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ groupBy: ['day', 'day'] }).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ groupBy: 'project' }).success).toBe(false);
  });

  it('takes an optional range, from before to', () => {
    const range = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
    expect(UsageQuerySchema.parse({ ...range, groupBy: 'day' })).toEqual({
      ...range,
      groupBy: ['day'],
    });
    expect(
      UsageQuerySchema.safeParse({ from: range.to, to: range.from, groupBy: 'day' }).success,
    ).toBe(false);
    expect(UsageQuerySchema.safeParse({ from: 'yesterday', groupBy: 'day' }).success).toBe(false);
  });

  it('ignores the session token and anything else a query string carries', () => {
    expect(UsageQuerySchema.parse({ groupBy: 'day', token: 'abc' })).toEqual({ groupBy: ['day'] });
  });
});

describe('FR-OBS-002 FR-OBS-004 UsageResponse', () => {
  it('parses buckets keyed by their groupings, with the totals', () => {
    const response = { buckets: [bucket], totals };
    expect(UsageResponseSchema.parse(response)).toEqual(response);
  });

  it('counts tokens and runs in whole numbers, never below zero', () => {
    expect(UsageBucketSchema.safeParse({ ...bucket, tokensIn: 1.5 }).success).toBe(false);
    expect(UsageBucketSchema.safeParse({ ...bucket, runs: -1 }).success).toBe(false);
    expect(UsageBucketSchema.safeParse({ ...bucket, costUsd: -0.01 }).success).toBe(false);
  });

  it('carries a day total as a UTC date with its usage, for the top bar (§2.8)', () => {
    expect(DayTotalsSchema.parse({ day: '2026-10-01', totals })).toEqual({
      day: '2026-10-01',
      totals,
    });
    expect(DayTotalsSchema.safeParse({ day: '2026-10-01T00:00:00Z', totals }).success).toBe(false);
    expect(DayTotalsSchema.safeParse({ day: '01/10/2026', totals }).success).toBe(false);
  });
});

describe('FR-OBS-001 TraceEntry', () => {
  it('declares the six kinds §2.6 names (§3)', () => {
    expect([...TRACE_ENTRY_KINDS]).toEqual([
      'node_run',
      'tool_call',
      'verdict',
      'approval',
      'loop',
      'run_event',
    ]);
  });

  it('refuses a kind §2.6 does not name', () => {
    for (const kind of ['node', 'event', 'tool', 'guardrail']) {
      expect(TraceEntrySchema.safeParse({ ...trace, kind }).success, kind).toBe(false);
    }
  });

  it('parses an entry, and a whole trace as a bare array', () => {
    expect(TraceEntrySchema.parse(trace)).toEqual(trace);
    expect(TraceResponseSchema.parse([trace])).toEqual([trace]);
  });

  it('allows an entry that belongs to no node, with any detail', () => {
    const runEvent = { seq: 1, at: NOW, kind: 'run_event', label: 'Run started', detail: null };
    expect(TraceEntrySchema.parse(runEvent)).toEqual(runEvent);
  });

  it('files every persisted run event under one of the six kinds', () => {
    expect(Object.keys(TRACE_ENTRY_KIND_BY_EVENT_TYPE).sort()).toEqual(
      [...PERSISTED_RUN_EVENT_TYPES].sort(),
    );
    for (const kind of Object.values(TRACE_ENTRY_KIND_BY_EVENT_TYPE)) {
      expect(TRACE_ENTRY_KINDS).toContain(kind);
    }
  });

  it('puts each event family where TC-OBS-001 looks for it', () => {
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['tool.call']).toBe('tool_call');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['guardrail.verdict']).toBe('verdict');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['node.approval_required']).toBe('approval');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['node.approval_decided']).toBe('approval');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['loop.iteration']).toBe('loop');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['node.state']).toBe('node_run');
    expect(TRACE_ENTRY_KIND_BY_EVENT_TYPE['run.completed']).toBe('run_event');
  });
});

describe('FR-OBS-007 HealthMetrics', () => {
  it('parses run counts, failures by kind, provider latency and verdicts by type', () => {
    expect(HealthMetricsSchema.parse(health)).toEqual(health);
  });

  it('names every error kind in nodeFailuresByKind, at 0 when nothing failed that way', () => {
    const { provider: _provider, ...missingOne } = health.nodeFailuresByKind;
    expect(
      HealthMetricsSchema.safeParse({ ...health, nodeFailuresByKind: missingOne }).success,
    ).toBe(false);
    expect(
      HealthMetricsSchema.safeParse({
        ...health,
        nodeFailuresByKind: { ...health.nodeFailuresByKind, timeout: 1 },
      }).success,
    ).toBe(false);
  });

  it('keys provider latency by provider id', () => {
    expect(
      HealthMetricsSchema.safeParse({
        ...health,
        providerLatencyMs: { anthropic: { p50: 1, p95: 2 } },
      }).success,
    ).toBe(false);
  });

  it('allows a fresh engine with nothing recorded', () => {
    const fresh = {
      runs: { started: 0, completed: 0, halted: 0, blocked: 0 },
      nodeFailuresByKind: zeroFailures,
      providerLatencyMs: {},
      guardrailVerdictsByType: {},
      since: NOW,
    };
    expect(HealthMetricsSchema.parse(fresh)).toEqual(fresh);
  });

  it('counts in whole numbers', () => {
    expect(
      HealthMetricsSchema.safeParse({ ...health, runs: { ...health.runs, started: 1.5 } }).success,
    ).toBe(false);
    expect(
      HealthMetricsSchema.safeParse({ ...health, guardrailVerdictsByType: { pii: -1 } }).success,
    ).toBe(false);
  });

  it('is strict, so no telemetry-shaped extra can ride along (NFR-PRIV-01)', () => {
    expect(HealthMetricsSchema.safeParse({ ...health, installId: WORKFLOW_ID }).success).toBe(
      false,
    );
  });
});
