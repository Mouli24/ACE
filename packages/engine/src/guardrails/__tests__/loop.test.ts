import type { GuardrailPolicy } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { LOCAL_SCOPE } from '../../ports/index.js';
import type { LoopCheckInput } from '../checks.js';
import { createGuardrailEvaluator, type EvaluationTarget, type GuardrailEvaluator } from '../evaluator.js';
import {
  FakeGuardrailStore,
  RecordingBus,
  check,
  fakeChecks,
  fakeMasker,
  id,
  policy,
} from './fakes.js';

/**
 * Loop guardrails (FR-GRD-009, §2.4): may this loop go round again?
 *
 * The evaluator answers with a `LoopStopReason` or nothing; the scheduler owns the re-queue and the
 * `onMax` behaviour. That split is why this is testable without a scheduler at all.
 */

function harness(active: GuardrailPolicy): {
  evaluator: GuardrailEvaluator;
  store: FakeGuardrailStore;
  bus: RecordingBus;
  target: EvaluationTarget;
} {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();

  const evaluator = createGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks: fakeChecks,
    masker: fakeMasker,
    verdicts: store.verdicts,
    bus,
  });

  return {
    evaluator,
    store,
    bus,
    target: {
      runId: id(),
      workflowId: id(),
      nodeRunId: id(),
      nodeId: id(),
      nodeName: 'Reviewer',
      iteration: 1,
      policy: active,
    },
  };
}

const loop = (partial: Partial<LoopCheckInput> = {}): LoopCheckInput => ({
  iteration: 1,
  toolCalls: 0,
  outputHashes: [],
  ...partial,
});

describe('TC-GRD-013 Repeated output', () => {
  it('stops the loop with reason repeated_output after the same answer three times', async () => {
    const { evaluator, target, bus } = harness(
      policy({
        checks: [check({ point: 'loop', type: 'repeated_output', action: 'block', params: { times: 3 } })],
      }),
    );

    const twice = await evaluator.evaluateLoop({
      target,
      loop: loop({ iteration: 2, outputHashes: ['a', 'a'] }),
    });
    const thrice = await evaluator.evaluateLoop({
      target,
      loop: loop({ iteration: 3, outputHashes: ['a', 'a', 'a'] }),
    });

    // Twice is not a pattern; three times in a row is the FRS's own line.
    expect(twice.stop).toBeUndefined();
    expect(thrice.stop).toBe('repeated_output');
    expect(thrice.verdicts[0]).toMatchObject({
      point: 'loop',
      checkType: 'repeated_output',
      passed: false,
    });
    expect(bus.ofType('guardrail.verdict')).toHaveLength(1);
  });

  it('does not stop when the last answer differed', async () => {
    const { evaluator, target } = harness(
      policy({
        checks: [check({ point: 'loop', type: 'repeated_output', action: 'block', params: { times: 3 } })],
      }),
    );

    const outcome = await evaluator.evaluateLoop({
      target,
      loop: loop({ iteration: 3, outputHashes: ['a', 'a', 'b'] }),
    });

    expect(outcome.stop).toBeUndefined();
    expect(outcome.verdicts).toEqual([]);
  });
});

describe('TC-GRD-014 Tool-call limit', () => {
  it('trips at the configured count — the counter now, the tool loop in round 4', async () => {
    const { evaluator, target } = harness(
      policy({
        checks: [check({ point: 'loop', type: 'max_tool_calls', action: 'block', params: { max: 5 } })],
      }),
    );

    const under = await evaluator.evaluateLoop({ target, loop: loop({ toolCalls: 4 }) });
    const at = await evaluator.evaluateLoop({ target, loop: loop({ toolCalls: 5 }) });

    expect(under.stop).toBeUndefined();
    expect(at.stop).toBe('max_iterations');
    expect(at.verdicts[0]?.reason).toContain('5 tool calls');
  });
});

describe('FR-GRD-009 Max iterations', () => {
  it('stops at the policy’s limit with reason max_iterations', async () => {
    const { evaluator, target } = harness(
      policy({
        checks: [check({ point: 'loop', type: 'max_iterations', action: 'block', params: { max: 3 } })],
      }),
    );

    expect((await evaluator.evaluateLoop({ target, loop: loop({ iteration: 2 }) })).stop).toBeUndefined();
    expect((await evaluator.evaluateLoop({ target, loop: loop({ iteration: 3 }) })).stop).toBe(
      'max_iterations',
    );
  });

  it('warn records the verdict and lets the loop turn again; pass does neither', async () => {
    const warned = harness(
      policy({
        checks: [check({ point: 'loop', type: 'max_iterations', action: 'warn', params: { max: 2 } })],
      }),
    );
    const passing = harness(
      policy({
        checks: [check({ point: 'loop', type: 'max_iterations', action: 'pass', params: { max: 2 } })],
      }),
    );

    const warn = await warned.evaluator.evaluateLoop({ target: warned.target, loop: loop({ iteration: 5 }) });
    const pass = await passing.evaluator.evaluateLoop({
      target: passing.target,
      loop: loop({ iteration: 5 }),
    });

    expect(warn.stop).toBeUndefined();
    expect(warn.verdicts).toHaveLength(1);
    expect(warned.bus.ofType('guardrail.verdict')).toHaveLength(1);

    expect(pass.stop).toBeUndefined();
    expect(pass.verdicts).toHaveLength(1);
    expect(passing.bus.ofType('guardrail.verdict')).toEqual([]);
  });

  it('the strongest stop wins when two loop checks trip together', async () => {
    const { evaluator, target } = harness(
      policy({
        checks: [
          check({ point: 'loop', type: 'repeated_output', action: 'block', params: { times: 2 } }),
          check({ point: 'loop', type: 'max_iterations', action: 'block', params: { max: 2 } }),
        ],
      }),
    );

    const outcome = await evaluator.evaluateLoop({
      target,
      loop: loop({ iteration: 4, outputHashes: ['a', 'a'] }),
    });

    // Both tripped; the reason recorded is the first in policy order, and both verdicts are kept so
    // the inspector shows why the loop really ended.
    expect(outcome.stop).toBe('repeated_output');
    expect(outcome.verdicts.map((verdict) => verdict.checkType)).toEqual([
      'repeated_output',
      'max_iterations',
    ]);
  });

  it('ignores disabled loop checks, and checks filed at other points', async () => {
    const { evaluator, target } = harness(
      policy({
        checks: [
          check({ point: 'loop', type: 'max_iterations', action: 'block', enabled: false, params: { max: 1 } }),
          check({ point: 'output', type: 'moderation', action: 'block' }),
        ],
      }),
    );

    const outcome = await evaluator.evaluateLoop({ target, loop: loop({ iteration: 9 }) });

    expect(outcome.stop).toBeUndefined();
    expect(outcome.verdicts).toEqual([]);
  });
});
