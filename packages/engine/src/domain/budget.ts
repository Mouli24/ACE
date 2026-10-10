/**
 * The run token budget (D7, D313): input + output tokens, cached input included. At 80 % the
 * conversation is warned, at 100 % no new turn starts and the run goes BLOCKED `BUDGET_EXCEEDED`
 * (D305). Each threshold is said once per limit; a new limit starts fresh.
 */

export const BUDGET_WARN_SHARE = 0.8;

export interface BudgetState {
  /** Tokens; `null` is no budget. */
  limit: number | null;
  warned: boolean;
  exceeded: boolean;
}

export const freshBudget = (limit: number | null): BudgetState => ({
  limit,
  warned: false,
  exceeded: false,
});

/** At or over the limit: no new turn may start. */
export const isOverBudget = (state: BudgetState, used: number): boolean =>
  state.limit !== null && used >= state.limit;

/**
 * Whether `used` crosses a threshold not yet said. A turn that jumps straight past both says
 * EXCEEDED alone: the warning it skipped has nothing left to warn about.
 */
export function budgetCrossing(
  state: BudgetState,
  used: number,
): { state: BudgetState; level?: 'WARN' | 'EXCEEDED' } {
  if (state.limit === null) return { state };
  if (!state.exceeded && used >= state.limit) {
    return { state: { ...state, warned: true, exceeded: true }, level: 'EXCEEDED' };
  }
  if (!state.warned && used >= state.limit * BUDGET_WARN_SHARE) {
    return { state: { ...state, warned: true }, level: 'WARN' };
  }
  return { state };
}
