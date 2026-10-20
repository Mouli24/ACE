import { describe, expect, it } from 'vitest';

import {
  DATA_TYPES,
  DataTypeSchema,
  EDGE_KINDS,
  EdgeKindSchema,
  ERROR_KINDS,
  ErrorKindSchema,
  FAILURE_REASONS,
  FailureReasonSchema,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_POINTS,
  GuardrailActionSchema,
  GuardrailPointSchema,
  HALT_REASONS,
  HaltReasonSchema,
  NODE_KINDS,
  NODE_STATES,
  NodeKindSchema,
  NodeStateSchema,
  PROVIDER_STATES,
  PROVIDER_TYPES,
  ProviderStateSchema,
  ProviderTypeSchema,
  ROUTING_POLICIES,
  RUN_STATES,
  RoutingPolicySchema,
  RunStateSchema,
} from '../enums.js';

/**
 * Round 1 §2.2 requires a unit test that asserts every literal of every enum, under exactly this
 * describe name. The `expected` arrays below are transcribed from §2.2 and are the assertion — they
 * are deliberately not derived from the implementation.
 */
const ENUMS = [
  {
    name: 'DataType',
    values: DATA_TYPES,
    schema: DataTypeSchema,
    expected: ['text', 'image', 'audio', 'video', 'code', 'json', 'file'],
  },
  {
    name: 'NodeKind',
    values: NODE_KINDS,
    schema: NodeKindSchema,
    expected: [
      'input',
      'agent',
      'model',
      'output',
      'merge',
      'transform',
      'retrieval',
      'guardrail',
      'custom',
    ],
  },
  { name: 'EdgeKind', values: EDGE_KINDS, schema: EdgeKindSchema, expected: ['data', 'loop', 'order'] },
  {
    name: 'NodeState',
    values: NODE_STATES,
    schema: NodeStateSchema,
    expected: [
      'IDLE',
      'READY',
      'RUNNING',
      'WAITING',
      'COMPLETED',
      'PAUSED',
      'STOPPED',
      'BLOCKED',
      'FAILED',
    ],
  },
  {
    name: 'RunState',
    values: RUN_STATES,
    schema: RunStateSchema,
    expected: ['PREFLIGHT', 'RUNNING', 'PAUSED', 'COMPLETE', 'BLOCKED', 'HALTED'],
  },
  {
    name: 'FailureReason',
    values: FAILURE_REASONS,
    schema: FailureReasonSchema,
    expected: ['RUN_FAILED', 'CONTRACT_VIOLATION', 'GUARDRAIL_VIOLATION', 'BLOCKED'],
  },
  {
    name: 'HaltReason',
    values: HALT_REASONS,
    schema: HaltReasonSchema,
    expected: ['stopped', 'budget_exceeded', 'failure', 'shutdown', 'crash'],
  },
  {
    name: 'ProviderState',
    values: PROVIDER_STATES,
    schema: ProviderStateSchema,
    expected: ['UNKNOWN', 'CHECKING', 'CONNECTED', 'AUTH_FAILED', 'UNREACHABLE', 'RATE_LIMITED'],
  },
  {
    name: 'ProviderType',
    values: PROVIDER_TYPES,
    schema: ProviderTypeSchema,
    expected: [
      'anthropic',
      'google',
      'openai',
      'openai_compatible',
      'ollama',
      'mock',
      'claude_code',
      'codex_cli',
      'gemini_cli',
    ],
  },
  {
    name: 'ErrorKind',
    values: ERROR_KINDS,
    schema: ErrorKindSchema,
    expected: [
      'user_cancelled',
      'agent',
      'provider',
      'auth',
      'network',
      'invalid_config',
      'workflow',
      'guardrail',
    ],
  },
  {
    name: 'GuardrailAction',
    values: GUARDRAIL_ACTIONS,
    schema: GuardrailActionSchema,
    expected: ['pass', 'warn', 'redact', 'ask_user', 'block'],
  },
  {
    name: 'GuardrailPoint',
    values: GUARDRAIL_POINTS,
    schema: GuardrailPointSchema,
    expected: ['input', 'context', 'tool', 'output', 'cost', 'loop', 'data'],
  },
  {
    name: 'RoutingPolicy',
    values: ROUTING_POLICIES,
    schema: RoutingPolicySchema,
    expected: ['fixed', 'fallback', 'capability', 'cost', 'latency'],
  },
];

describe('FR-SYS-006 enum literals', () => {
  it('declares exactly the thirteen enums of round 1 §2.2', () => {
    expect(ENUMS.map((e) => e.name)).toEqual([
      'DataType',
      'NodeKind',
      'EdgeKind',
      'NodeState',
      'RunState',
      'FailureReason',
      'HaltReason',
      'ProviderState',
      'ProviderType',
      'ErrorKind',
      'GuardrailAction',
      'GuardrailPoint',
      'RoutingPolicy',
    ]);
  });

  it.each(ENUMS)('$name declares exactly its §2.2 literals, in order', ({ values, expected }) => {
    expect([...values]).toEqual(expected);
  });

  it.each(ENUMS)('$name parses every declared literal', ({ schema, expected }) => {
    for (const literal of expected) {
      expect(schema.parse(literal)).toBe(literal);
    }
  });

  it.each(ENUMS)('$name rejects a literal it does not declare', ({ schema }) => {
    expect(schema.safeParse('__not_a_member__').success).toBe(false);
  });
});

describe('BR-03 distinct states', () => {
  it('keeps node COMPLETED and run COMPLETE as different literals', () => {
    expect(NODE_STATES).toContain('COMPLETED');
    expect(NODE_STATES).not.toContain('COMPLETE');
    expect(RUN_STATES).toContain('COMPLETE');
    expect(RUN_STATES).not.toContain('COMPLETED');
  });

  it('keeps the four failure reasons separate', () => {
    expect(new Set(FAILURE_REASONS).size).toBe(4);
    expect(FAILURE_REASONS).toContain('CONTRACT_VIOLATION');
    expect(FAILURE_REASONS).toContain('GUARDRAIL_VIOLATION');
    expect(FAILURE_REASONS).toContain('RUN_FAILED');
    expect(FAILURE_REASONS).toContain('BLOCKED');
  });

  it('keeps run HALTED separate from run COMPLETE', () => {
    expect(RUN_STATES).toContain('HALTED');
    expect(RUN_STATES.indexOf('HALTED')).not.toBe(RUN_STATES.indexOf('COMPLETE'));
  });
});
