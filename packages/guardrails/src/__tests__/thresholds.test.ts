import { describe, expect, it } from 'vitest';

import {
  checkDailyBudget,
  checkMaxCostPerRun,
  checkMaxIterations,
  checkMaxToolCalls,
  checkMaxTokensPerNode,
} from '../checks/thresholds.js';
import { makeCheck } from './fixtures.js';

/* -------------------------------------------------------------------------- */
/* TC-GRD-012 — cost point (FR-GRD-008, round 3 §2.3)                          */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-012 Budget exceeded', () => {
  it('fails when the projected run cost passes a $0.01 cap', () => {
    const check = makeCheck('max_cost_per_run', { usd: 0.01 }, { action: 'block' });
    const result = checkMaxCostPerRun(check, { value: 0.014 });

    expect(result).toEqual({
      passed: false,
      reason: '$0.014 run cost exceeds the cap of $0.01.',
    });
  });

  it('passes exactly at the cap — the cap is a ceiling, not a trigger', () => {
    const check = makeCheck('max_cost_per_run', { usd: 0.01 });
    expect(checkMaxCostPerRun(check, { value: 0.01 })?.passed).toBe(true);
  });

  it('takes the project cap from the caller when the policy names none (§2.3)', () => {
    const check = makeCheck('max_cost_per_run');
    expect(checkMaxCostPerRun(check, { value: 0.5, limit: 0.25 })?.passed).toBe(false);
    expect(checkMaxCostPerRun(check, { value: 0.2, limit: 0.25 })?.passed).toBe(true);
  });

  it("lets the policy's own param win over the project cap", () => {
    const check = makeCheck('max_cost_per_run', { usd: 1 });
    expect(checkMaxCostPerRun(check, { value: 0.5, limit: 0.25 })?.passed).toBe(true);
  });

  it('passes when no cap exists anywhere — an unset budget cannot be exceeded', () => {
    const result = checkMaxCostPerRun(makeCheck('max_cost_per_run'), {
      value: 99,
    });
    expect(result).toEqual({
      passed: true,
      reason: 'No max cost per run cap is configured.',
    });
  });

  it('says nothing when it was handed no number', () => {
    expect(checkMaxCostPerRun(makeCheck('max_cost_per_run'), { text: 'hello' })).toBeUndefined();
    expect(
      checkMaxCostPerRun(makeCheck('max_cost_per_run'), { value: Number.NaN }),
    ).toBeUndefined();
  });

  it('applies the same rule to the daily budget', () => {
    const check = makeCheck('daily_budget', { usd: 5 });
    expect(checkDailyBudget(check, { value: 5 })?.passed).toBe(true);
    const over = checkDailyBudget(check, { value: 5.25 });
    expect(over?.passed).toBe(false);
    expect(over?.reason).toBe("$5.25 today's spend exceeds the cap of $5.");
  });

  it('applies the same rule to the per-node token cap', () => {
    const check = makeCheck('max_tokens_per_node', { maxTokens: 4096 });
    expect(checkMaxTokensPerNode(check, { value: 4096 })?.passed).toBe(true);
    const over = checkMaxTokensPerNode(check, { value: 4097 });
    expect(over?.passed).toBe(false);
    expect(over?.reason).toBe('4097 tokens for this node exceeds the cap of 4096.');
  });

  it("falls back to the agent's execution.maxTokens the caller supplies", () => {
    const check = makeCheck('max_tokens_per_node');
    expect(checkMaxTokensPerNode(check, { value: 900, limit: 800 })?.passed).toBe(false);
  });

  it('ignores a negative cap rather than failing everything against it', () => {
    const check = makeCheck('max_cost_per_run', { usd: -1 });
    expect(checkMaxCostPerRun(check, { value: 0.5 })?.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* max_iterations — FR-PAR-003 / FR-GRD-009                                    */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-009 max_iterations', () => {
  it('allows iterations 1..max and fails at max + 1', () => {
    const check = makeCheck('max_iterations', { max: 3 });
    expect(checkMaxIterations(check, { value: 1 })?.passed).toBe(true);
    expect(checkMaxIterations(check, { value: 3 })?.passed).toBe(true);
    const over = checkMaxIterations(check, { value: 4 });
    expect(over?.passed).toBe(false);
    expect(over?.reason).toBe('4 loop iterations exceeds the cap of 3.');
  });

  it('reads the default policy cap of 50', () => {
    const check = makeCheck('max_iterations', { max: 50 });
    expect(checkMaxIterations(check, { value: 50 })?.passed).toBe(true);
    expect(checkMaxIterations(check, { value: 51 })?.passed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* TC-GRD-014 — the tool-call counter exists now, the tool loop enforces it R4 */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-014 Tool-call limit (counter only this round)', () => {
  it('stops at 5 with a limit of 5: five calls pass, the sixth does not', () => {
    const check = makeCheck('max_tool_calls', { max: 5 }, { action: 'block' });
    for (const calls of [0, 1, 4, 5]) {
      expect(checkMaxToolCalls(check, { value: calls })?.passed).toBe(true);
    }
    const sixth = checkMaxToolCalls(check, { value: 6 });
    expect(sixth?.passed).toBe(false);
    expect(sixth?.reason).toBe('6 tool calls exceeds the cap of 5.');
  });

  it('reads the default policy cap of 25', () => {
    const check = makeCheck('max_tool_calls', { max: 25 });
    expect(checkMaxToolCalls(check, { value: 25 })?.passed).toBe(true);
    expect(checkMaxToolCalls(check, { value: 26 })?.passed).toBe(false);
  });

  it('says nothing when no counter was handed to it', () => {
    expect(checkMaxToolCalls(makeCheck('max_tool_calls', { max: 5 }), {})).toBeUndefined();
  });
});
