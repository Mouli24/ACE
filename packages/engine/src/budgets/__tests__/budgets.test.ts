import type { GuardrailPolicy, ModelPricing, Node, Usage } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  FakeGuardrailStore,
  RecordingBus,
  agentNode,
  check,
  fakeChecks,
  fakeMasker,
  id,
  inputNode,
  policy,
  project,
} from '../../guardrails/__tests__/fakes.js';
import { createGuardrailEvaluator, type EvaluationTarget } from '../../guardrails/evaluator.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { createBudgetService, projectedNodeCostUsd, utcDay, type BudgetService } from '../index.js';

/**
 * FR-GRD-008 and §2.3: the three moments a budget is checked, and D80's `budgetHalt`.
 */

const TODAY = '2026-09-26';

/** $0.01 per 1k output tokens, so 1 000 maxTokens projects to exactly one cent. */
const PRICING: ModelPricing = {
  inputPer1k: 0,
  outputPer1k: 0.01,
  priceTableVersion: '2026-09-01',
};

interface Harness {
  budgets: BudgetService;
  store: FakeGuardrailStore;
  bus: RecordingBus;
  target: EvaluationTarget;
  projectId: string;
  node: Node;
}

function harness(
  active: GuardrailPolicy | null,
  options: { maxCostPerRunUsd?: number; dailyBudgetUsd?: number; maxTokens?: number } = {},
): Harness {
  const store = new FakeGuardrailStore();
  const bus = new RecordingBus();

  const owner = project({
    ...(options.maxCostPerRunUsd === undefined ? {} : { maxCostPerRunUsd: options.maxCostPerRunUsd }),
  });
  store.projectRows.set(owner.id, owner);
  if (options.dailyBudgetUsd !== undefined) {
    store.settingsRow = { ...store.settingsRow, dailyBudgetUsd: options.dailyBudgetUsd };
  }

  const evaluator = createGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks: fakeChecks,
    masker: fakeMasker,
    verdicts: store.verdicts,
    bus,
  });

  const budgets = createBudgetService({
    scope: LOCAL_SCOPE,
    projects: store.projects,
    settings: store.settings,
    usage: store.usage,
    verdicts: evaluator,
    today: () => TODAY,
  });

  const node = agentNode({ maxTokens: options.maxTokens ?? 1_000 });

  return {
    budgets,
    store,
    bus,
    projectId: owner.id,
    node,
    target: {
      runId: id(),
      workflowId: id(),
      nodeRunId: id(),
      nodeId: node.id,
      nodeName: 'Writer',
      iteration: 1,
      policy: active,
    },
  };
}

const totals = (costUsd: number): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd });

const runCap = (action: 'block' | 'warn' | 'pass' = 'block', params = {}): GuardrailPolicy =>
  policy({ checks: [check({ point: 'cost', type: 'max_cost_per_run', action, params })] });

describe('TC-GRD-012 Budget exceeded', () => {
  it('halts before the dispatch when the projected cost would cross the run cap', async () => {
    const { budgets, target, projectId, node } = harness(runCap(), { maxCostPerRunUsd: 0.01 });

    // Spent nothing yet; the next node alone would cost a cent, which is *over* a one-cent cap.
    const outcome = await budgets.beforeDispatch({
      target,
      projectId,
      totals: totals(0.005),
      node,
      pricing: PRICING,
    });

    expect(outcome.halt).toEqual({ scope: 'run', capUsd: 0.01, costUsd: 0.015, projected: true });
  });

  it('D80: the halt says which cap tripped and by how much, after the money was spent', async () => {
    const { budgets, target, projectId } = harness(runCap(), { maxCostPerRunUsd: 0.01 });

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(0.012) });

    // The line M3 shows — "budget exceeded: $0.012 > $0.01 cap" — comes straight off this object.
    expect(outcome.halt).toEqual({ scope: 'run', capUsd: 0.01, costUsd: 0.012, projected: false });
    expect(outcome.verdicts[0]).toMatchObject({
      point: 'cost',
      checkType: 'max_cost_per_run',
      action: 'block',
      passed: false,
    });
    expect(outcome.verdicts[0]?.reason).toContain('$0.012');
    expect(outcome.verdicts[0]?.reason).toContain('$0.01 cap');
  });

  it('does not halt while the run is under the cap, and records nothing', async () => {
    const { budgets, target, projectId } = harness(runCap(), { maxCostPerRunUsd: 0.01 });

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(0.009) });

    expect(outcome.halt).toBeUndefined();
    expect(outcome.verdicts).toEqual([]);
  });

  it('D79: warn records a verdict and the run carries on; pass does neither', async () => {
    const warned = harness(runCap('warn'), { maxCostPerRunUsd: 0.01 });
    const passed = harness(runCap('pass'), { maxCostPerRunUsd: 0.01 });

    const warn = await warned.budgets.afterNode({
      target: warned.target,
      projectId: warned.projectId,
      totals: totals(0.02),
    });
    const pass = await passed.budgets.afterNode({
      target: passed.target,
      projectId: passed.projectId,
      totals: totals(0.02),
    });

    expect(warn.halt).toBeUndefined();
    expect(warn.verdicts).toHaveLength(1);
    expect(warned.bus.ofType('guardrail.verdict')).toHaveLength(1);

    expect(pass.halt).toBeUndefined();
    expect(pass.verdicts).toEqual([]);
    expect(passed.bus.ofType('guardrail.verdict')).toEqual([]);
  });

  it('D79: the check’s own params.usd wins over the project cap', async () => {
    const { budgets, target, projectId } = harness(runCap('block', { usd: 5 }), {
      maxCostPerRunUsd: 0.01,
    });

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(0.5) });

    // Over the project's cent, well under the policy's five dollars: the policy decides.
    expect(outcome.halt).toBeUndefined();
  });

  it('with no cap anywhere the check does nothing at all', async () => {
    const { budgets, target, projectId } = harness(runCap());

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(1_000) });

    expect(outcome.halt).toBeUndefined();
    expect(outcome.verdicts).toEqual([]);
  });

  it('with no policy, and with a disabled check, nothing is checked', async () => {
    const none = harness(null, { maxCostPerRunUsd: 0.01 });
    const off = harness(
      policy({
        checks: [check({ point: 'cost', type: 'max_cost_per_run', action: 'block', enabled: false })],
      }),
      { maxCostPerRunUsd: 0.01 },
    );

    expect(
      (await none.budgets.afterNode({ target: none.target, projectId: none.projectId, totals: totals(9) }))
        .halt,
    ).toBeUndefined();
    expect(
      (await off.budgets.afterNode({ target: off.target, projectId: off.projectId, totals: totals(9) }))
        .halt,
    ).toBeUndefined();
  });
});

describe('FR-GRD-008 Daily budget', () => {
  const dailyPolicy = (action: 'block' | 'warn' | 'pass' = 'block'): GuardrailPolicy =>
    policy({ checks: [check({ point: 'cost', type: 'daily_budget', action })] });

  it('blocks the run at pre-flight once today’s spend has reached the cap (zero provider calls)', async () => {
    const { budgets, store, target, projectId } = harness(dailyPolicy(), { dailyBudgetUsd: 1 });
    store.dailyCost.set(TODAY, 1);

    const issues = await budgets.preflightIssues({ projectId, policy: target.policy });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'daily_budget_exceeded' });
    expect(issues[0]?.message).toContain('$1');
  });

  it('reports a warning instead of blocking when the check is set to warn (D79)', async () => {
    const { budgets, store, target, projectId } = harness(dailyPolicy('warn'), { dailyBudgetUsd: 1 });
    store.dailyCost.set(TODAY, 2);

    const [issue] = await budgets.preflightIssues({ projectId, policy: target.policy });

    expect(issue?.severity).toBe('warning');
  });

  it('says nothing at pre-flight while the day is still under its cap, or with the check at pass', async () => {
    const under = harness(dailyPolicy(), { dailyBudgetUsd: 1 });
    under.store.dailyCost.set(TODAY, 0.5);
    const passing = harness(dailyPolicy('pass'), { dailyBudgetUsd: 1 });
    passing.store.dailyCost.set(TODAY, 5);

    expect(
      await under.budgets.preflightIssues({ projectId: under.projectId, policy: under.target.policy }),
    ).toEqual([]);
    expect(
      await passing.budgets.preflightIssues({
        projectId: passing.projectId,
        policy: passing.target.policy,
      }),
    ).toEqual([]);
  });

  it('a run check never produces a pre-flight issue — a fresh run has spent nothing', async () => {
    const { budgets, target, projectId } = harness(runCap(), { maxCostPerRunUsd: 0.01 });

    expect(await budgets.preflightIssues({ projectId, policy: target.policy })).toEqual([]);
  });

  it('halts mid-run on the daily aggregate, and names the node when asked to', async () => {
    const { budgets, store, target, projectId, node } = harness(dailyPolicy(), { dailyBudgetUsd: 1 });
    store.dailyCost.set(TODAY, 0.995);

    const outcome = await budgets.beforeDispatch({
      target,
      projectId,
      totals: totals(0),
      node,
      pricing: PRICING,
    });

    expect(outcome.halt).toMatchObject({ scope: 'daily', capUsd: 1, projected: true });
    expect(outcome.halt?.costUsd).toBeCloseTo(1.005, 6);

    const [issue] = await budgets.preflightIssues({
      projectId,
      policy: target.policy,
      nodeId: node.id,
    });
    expect(issue).toBeUndefined();
  });

  it('the first cap crossed is the one reported when both would trip', async () => {
    const both = policy({
      checks: [
        check({ point: 'cost', type: 'max_cost_per_run', action: 'block' }),
        check({ point: 'cost', type: 'daily_budget', action: 'block' }),
      ],
    });
    const { budgets, store, target, projectId } = harness(both, {
      maxCostPerRunUsd: 0.01,
      dailyBudgetUsd: 1,
    });
    store.dailyCost.set(TODAY, 5);

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(0.02) });

    // A run halts once, for one reason; the checks are walked in policy order.
    expect(outcome.halt?.scope).toBe('run');
    expect(outcome.verdicts).toHaveLength(2);
  });
});

describe('FR-GRD-008 Projection and the day boundary', () => {
  it('projects a node at its whole output allowance, and at zero without a price', () => {
    const { node } = harness(null, { maxTokens: 2_000 });

    expect(projectedNodeCostUsd(node, PRICING)).toBeCloseTo(0.02, 6);
    // A local model with no published price projects to nothing rather than to a guess (round 2).
    expect(projectedNodeCostUsd(node, undefined)).toBe(0);
  });

  it('projects an input node at zero — it calls no model', () => {
    expect(projectedNodeCostUsd(inputNode(), PRICING)).toBe(0);
  });

  it('measures a daily budget over the UTC calendar day', () => {
    expect(utcDay(new Date('2026-09-26T23:59:59.999Z'))).toBe('2026-09-26');
    expect(utcDay(new Date('2026-09-27T00:00:00.000Z'))).toBe('2026-09-27');
  });

  it('max_tokens_per_node is left to execution.maxTokens and never halts a run (§2.3)', async () => {
    const { budgets, target, projectId } = harness(
      policy({
        checks: [
          check({ point: 'cost', type: 'max_tokens_per_node', action: 'block', params: { max: 1 } }),
        ],
      }),
      { maxCostPerRunUsd: 0.01 },
    );

    const outcome = await budgets.afterNode({ target, projectId, totals: totals(9) });

    expect(outcome.halt).toBeUndefined();
    expect(outcome.verdicts).toEqual([]);
  });
});
