import { zeroUsage, type ErrorKind, type NodeError, type NodeRun, type NodeState } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  countNodeOutcomes,
  failureReasonFor,
  hasFailures,
  isFailureKind,
  nodeStateFor,
} from '../index.js';

const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';

const errorOf = (kind: ErrorKind, code = 'x'): NodeError => ({
  kind,
  code,
  message: kind,
  retryable: false,
});

const nodeRun = (
  nodeId: string,
  status: NodeState,
  overrides: Partial<NodeRun> = {},
): NodeRun => ({
  id: `${nodeId}-${status}-${overrides.attempt ?? 1}`,
  runId: RUN_ID,
  nodeId,
  iteration: 1,
  attempt: 1,
  status,
  inputEnvelopes: [],
  usage: zeroUsage(),
  verdicts: [],
  toolCalls: [],
  ...overrides,
});

describe('TC-ERR-007 Downstream of a failure is BLOCKED, never FAILED (FR-ERR-006, BR-03)', () => {
  it('a workflow error leaves the node BLOCKED', () => {
    expect(nodeStateFor(errorOf('workflow', 'upstream_failed'))).toBe('BLOCKED');
    expect(failureReasonFor(errorOf('workflow', 'upstream_failed'))).toBe('BLOCKED');
  });

  it('an invalid_config error is BLOCKED too, as Arch §28 puts it', () => {
    expect(nodeStateFor(errorOf('invalid_config'))).toBe('BLOCKED');
    expect(failureReasonFor(errorOf('invalid_config'))).toBe('BLOCKED');
  });

  it('a cancellation leaves the node STOPPED, which is not a failure', () => {
    expect(nodeStateFor(errorOf('user_cancelled'))).toBe('STOPPED');
    expect(isFailureKind('user_cancelled')).toBe(false);
  });

  it('every other kind leaves the node FAILED', () => {
    for (const kind of ['agent', 'provider', 'auth', 'network', 'guardrail'] as const) {
      expect(nodeStateFor(errorOf(kind))).toBe('FAILED');
      expect(isFailureKind(kind)).toBe(true);
    }
  });

  it('BR-03: the four failure reasons stay distinct', () => {
    expect(failureReasonFor(errorOf('guardrail'))).toBe('GUARDRAIL_VIOLATION');
    expect(failureReasonFor(errorOf('agent', 'contract_violation'))).toBe('CONTRACT_VIOLATION');
    expect(failureReasonFor(errorOf('agent', 'refusal'))).toBe('RUN_FAILED');
    expect(failureReasonFor(errorOf('provider'))).toBe('RUN_FAILED');
    expect(failureReasonFor(errorOf('workflow'))).toBe('BLOCKED');

    const reasons = (['guardrail', 'agent', 'provider', 'workflow'] as const).map((kind) =>
      failureReasonFor(errorOf(kind, kind === 'agent' ? 'contract_violation' : 'x')),
    );
    expect(new Set(reasons).size).toBe(4);
  });
});

describe('TC-ERR-008 Cancel is not a failure (FR-ERR-007)', () => {
  it('stopped nodes are counted apart from failures, never added to them', () => {
    const counts = countNodeOutcomes([
      nodeRun('a', 'COMPLETED'),
      nodeRun('b', 'STOPPED'),
      nodeRun('c', 'STOPPED'),
    ]);

    expect(counts).toMatchObject({ completed: 1, stopped: 2, failed: 0, total: 3 });
    expect(hasFailures([nodeRun('b', 'STOPPED')])).toBe(false);
  });

  it('a run with one real failure and one stopped node reports one of each', () => {
    const counts = countNodeOutcomes([nodeRun('a', 'FAILED'), nodeRun('b', 'STOPPED')]);
    expect(counts.failed).toBe(1);
    expect(counts.stopped).toBe(1);
    expect(hasFailures([nodeRun('a', 'FAILED')])).toBe(true);
  });

  it('counts every state it is given, and IDLE as none of them', () => {
    const counts = countNodeOutcomes([
      nodeRun('a', 'BLOCKED'),
      nodeRun('b', 'WAITING'),
      nodeRun('c', 'RUNNING'),
      nodeRun('d', 'READY'),
      nodeRun('e', 'PAUSED'),
      nodeRun('f', 'IDLE'),
    ]);

    expect(counts).toEqual({
      completed: 0,
      failed: 0,
      stopped: 0,
      blocked: 1,
      waiting: 1,
      running: 2,
      paused: 1,
      total: 6,
    });
  });

  it('a node that failed twice and then succeeded is one completed node, not two failures', () => {
    const counts = countNodeOutcomes([
      nodeRun('a', 'FAILED', { attempt: 1 }),
      nodeRun('a', 'FAILED', { attempt: 2 }),
      nodeRun('a', 'COMPLETED', { attempt: 3 }),
    ]);

    expect(counts).toMatchObject({ completed: 1, failed: 0, total: 1 });
  });

  it('counts each loop iteration of a node separately (FR-PAR-005)', () => {
    const counts = countNodeOutcomes([
      nodeRun('a', 'COMPLETED', { iteration: 1 }),
      nodeRun('a', 'COMPLETED', { iteration: 2 }),
    ]);

    expect(counts).toMatchObject({ completed: 2, total: 2 });
  });

  it('an empty run has nothing in it', () => {
    expect(countNodeOutcomes([])).toMatchObject({ total: 0, failed: 0 });
    expect(hasFailures([])).toBe(false);
  });
});
