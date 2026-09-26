import type {
  BudgetHalt,
  BudgetScope,
  GuardrailCheck,
  GuardrailPolicy,
  Id,
  ModelPricing,
  Node,
  Usage,
  ValidationIssue,
  Verdict,
} from '@ace/contracts';

import type { Scope } from '../ports/index.js';
import { estimateCostUsd } from '../runs/cost.js';
import type { CheckOutcome } from '../guardrails/checks.js';
import type { EvaluationTarget } from '../guardrails/evaluator.js';
import type { ProjectLookup, SettingsLookup, UsageAggregateRepository } from '../guardrails/ports.js';

/**
 * Cost guardrails — the budgets of §2.3 and FR-GRD-008.
 *
 * Three moments, and they are not interchangeable:
 *
 * 1. **Pre-flight.** Today's spend is already at the daily cap, so the run is `BLOCKED` with a
 *    `daily_budget_exceeded` issue and **zero provider calls** (§2.3, Arch §19.2).
 * 2. **Before a dispatch.** `totals.costUsd + maxTokens × price` would cross a cap. The run halts
 *    *before* spending the money, which is the only version of a budget that is actually a budget.
 * 3. **After a node.** The real `totals.costUsd` crossed a cap — a model that answered longer than
 *    its projection, or a cap lowered mid-run.
 *
 * Every halt is `HALTED` with `haltReason: 'budget_exceeded'` and a `budgetHalt` saying which cap
 * tripped and by how much (D80), because `haltReason` alone cannot produce "budget exceeded: $0.012
 * > $0.01 cap": at (2) the totals are still *below* the cap, and the snapshot does not hold the cap.
 *
 * What the action means is D79: at the cost point `block` halts, `warn` records a verdict and the
 * run carries on, `pass` does nothing. The cap is the check's `params.usd` when a policy sets one,
 * else the project's `maxCostPerRunUsd` or the settings' `dailyBudgetUsd`.
 */

/** Which check type owns which scope (§2.2). */
const SCOPE_OF: Record<string, BudgetScope> = {
  max_cost_per_run: 'run',
  daily_budget: 'daily',
};

/** What a budget check decided. `halt` set means the run must end HALTED `budget_exceeded`. */
export interface BudgetOutcome {
  halt?: BudgetHalt;
  verdicts: Verdict[];
}

/** The evaluator's verdict writer — store and emit (FR-GRD-015). Narrowed so budgets cannot check. */
export interface VerdictRecorder {
  recordCheck(
    target: EvaluationTarget,
    check: GuardrailCheck,
    outcome: CheckOutcome,
  ): Promise<Verdict>;
}

export interface BudgetService {
  /**
   * Pre-flight (§2.3). An `error` issue blocks the run; a `warning` is reported and the run goes
   * ahead, which is what a `daily_budget` check set to `warn` asks for (D79).
   */
  preflightIssues(input: {
    projectId: Id;
    policy: GuardrailPolicy | null;
    nodeId?: Id;
  }): Promise<ValidationIssue[]>;

  /** Before the scheduler dispatches `node`: would this call cross a cap? (§2.3, FR-GRD-008) */
  beforeDispatch(input: {
    target: EvaluationTarget;
    projectId: Id;
    totals: Usage;
    node: Node;
    /** The price row of the model the node would use; absent for a model with no published price. */
    pricing?: ModelPricing;
  }): Promise<BudgetOutcome>;

  /** After a node run has been priced into `totals` (§2.3). */
  afterNode(input: {
    target: EvaluationTarget;
    projectId: Id;
    totals: Usage;
  }): Promise<BudgetOutcome>;
}

export interface BudgetServiceDeps {
  scope: Scope;
  projects: ProjectLookup;
  settings: SettingsLookup;
  usage: UsageAggregateRepository;
  verdicts: VerdictRecorder;
  /** Overridable so a test can pin the day boundary rather than wait for midnight. */
  today?: () => string;
}

/** The UTC calendar day a daily budget is measured over. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** What a node's next call could cost at worst: its whole output allowance, at output prices. */
export function projectedNodeCostUsd(node: Node, pricing: ModelPricing | undefined): number {
  const maxTokens =
    node.kind === 'agent' || node.kind === 'model' ? node.config.execution.maxTokens : undefined;
  if (maxTokens === undefined) return 0;

  return estimateCostUsd(0, maxTokens, pricing);
}

/** A check's cap, resolved through D79's order; `undefined` when nothing set one. */
function capFor(
  check: GuardrailCheck,
  fallbacks: { run?: number; daily?: number },
): number | undefined {
  const fromParams = check.params['usd'];
  if (typeof fromParams === 'number' && fromParams > 0) return fromParams;

  const scope = SCOPE_OF[check.type];
  const fallback = scope === 'run' ? fallbacks.run : fallbacks.daily;
  return fallback !== undefined && fallback > 0 ? fallback : undefined;
}

function costChecks(policy: GuardrailPolicy | null): GuardrailCheck[] {
  return (policy?.checks ?? []).filter(
    (check) =>
      check.enabled &&
      check.point === 'cost' &&
      // `max_tokens_per_node` is already enforced where §2.3 puts it: `execution.maxTokens` is the
      // generation cap handed to the provider, so there is nothing left for a cost check to stop.
      SCOPE_OF[check.type] !== undefined,
  );
}

const money = (usd: number): string => `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;

export function createBudgetService(deps: BudgetServiceDeps): BudgetService {
  const { scope, projects, settings, usage, verdicts } = deps;
  const today = deps.today ?? ((): string => utcDay(new Date()));

  async function fallbacks(projectId: Id): Promise<{ run?: number; daily?: number }> {
    const project = await projects.get(scope, projectId);
    const config = await settings.get(scope);

    return {
      ...(project?.maxCostPerRunUsd === undefined || project.maxCostPerRunUsd === null
        ? {}
        : { run: project.maxCostPerRunUsd }),
      ...(config.dailyBudgetUsd === undefined || config.dailyBudgetUsd === null
        ? {}
        : { daily: config.dailyBudgetUsd }),
    };
  }

  /**
   * Walk the cost checks once. The first `block` that trips wins and the halt it produces is the
   * one reported — a run halts for one reason, and the first cap crossed is the one that stopped it.
   */
  async function evaluate(input: {
    target: EvaluationTarget;
    projectId: Id;
    runCostUsd: number;
    extraUsd: number;
    projected: boolean;
  }): Promise<BudgetOutcome> {
    const checks = costChecks(input.target.policy);
    if (checks.length === 0) return { verdicts: [] };

    const caps = await fallbacks(input.projectId);
    const collected: Verdict[] = [];
    let halt: BudgetHalt | undefined;

    // Read once, and only when a daily check is actually configured: a per-dispatch aggregate query
    // on every node would be the most expensive part of a cheap run.
    let dailySoFar: number | undefined;

    for (const check of checks) {
      const capUsd = capFor(check, caps);
      if (capUsd === undefined) continue;

      const budgetScope = SCOPE_OF[check.type]!;
      if (budgetScope === 'daily') dailySoFar ??= await usage.costUsdForDay(scope, today());

      const spent = budgetScope === 'run' ? input.runCostUsd : dailySoFar!;
      const costUsd = spent + input.extraUsd;
      const over = costUsd > capUsd;

      const outcome: CheckOutcome = {
        passed: !over,
        reason: over
          ? `${budgetScope === 'run' ? 'This run' : 'Today'} would cost ${money(costUsd)}, over the ${money(capUsd)} cap.`
          : `${budgetScope === 'run' ? 'This run' : 'Today'} has cost ${money(costUsd)} of the ${money(capUsd)} cap.`,
      };

      // Only a cap that was actually crossed is worth a row, and `pass` is configured to do nothing
      // at all (D79) — the same rule the evaluator applies to every other point.
      if (over && check.action !== 'pass') {
        collected.push(await verdicts.recordCheck(input.target, check, outcome));
      }

      if (over && check.action !== 'pass' && check.action !== 'warn' && halt === undefined) {
        halt = { scope: budgetScope, capUsd, costUsd, projected: input.projected };
      }
    }

    return { ...(halt === undefined ? {} : { halt }), verdicts: collected };
  }

  return {
    async preflightIssues({ projectId, policy, nodeId }) {
      const issues: ValidationIssue[] = [];
      const caps = await fallbacks(projectId);

      for (const check of costChecks(policy)) {
        if (SCOPE_OF[check.type] !== 'daily') continue;

        const capUsd = capFor(check, caps);
        if (capUsd === undefined) continue;

        const spent = await usage.costUsdForDay(scope, today());
        if (spent < capUsd) continue;
        // `pass` is configured to do nothing, so it does not block a run either.
        if (check.action === 'pass') continue;

        issues.push({
          // A `warn` daily budget reports and lets the run start; anything stronger blocks it, with
          // zero provider calls made (§2.3, D79).
          severity: check.action === 'warn' ? 'warning' : 'error',
          code: 'daily_budget_exceeded',
          message: `Today's spend is ${money(spent)}, at or over the ${money(capUsd)} daily budget.`,
          ...(nodeId === undefined ? {} : { nodeId }),
        });
      }

      return issues;
    },

    beforeDispatch: ({ target, projectId, totals, node, pricing }) =>
      evaluate({
        target,
        projectId,
        runCostUsd: totals.costUsd,
        extraUsd: projectedNodeCostUsd(node, pricing),
        projected: true,
      }),

    afterNode: ({ target, projectId, totals }) =>
      evaluate({ target, projectId, runCostUsd: totals.costUsd, extraUsd: 0, projected: false }),
  };
}
