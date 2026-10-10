import { describe, expect, it } from 'vitest';

import { budgetCrossing, freshBudget, isOverBudget } from '../budget.js';

/* D7, D313: the run token budget says WARN once at 80 % and EXCEEDED once at 100 %. */

describe('D313 budgetCrossing', () => {
  it('says nothing without a limit', () => {
    const { level, state } = budgetCrossing(freshBudget(null), 1_000_000);
    expect(level).toBeUndefined();
    expect(isOverBudget(state, 1_000_000)).toBe(false);
  });

  it('warns once at 80 %, and only once', () => {
    let state = freshBudget(100);
    const at = (used: number) => {
      const crossing = budgetCrossing(state, used);
      state = crossing.state;
      return crossing.level;
    };
    expect(at(79)).toBeUndefined();
    expect(at(80)).toBe('WARN');
    expect(at(95)).toBeUndefined();
  });

  it('says EXCEEDED once at 100 %; a turn that jumps straight past both says EXCEEDED alone', () => {
    let state = freshBudget(100);
    const first = budgetCrossing(state, 50);
    state = first.state;
    const jump = budgetCrossing(state, 120);
    expect(jump.level).toBe('EXCEEDED');
    expect(jump.state).toEqual({ limit: 100, warned: true, exceeded: true });
    expect(budgetCrossing(jump.state, 130).level).toBeUndefined();
    expect(isOverBudget(jump.state, 130)).toBe(true);
  });

  it('counts exactly the limit as over it', () => {
    expect(isOverBudget(freshBudget(100), 100)).toBe(true);
    expect(isOverBudget(freshBudget(100), 99)).toBe(false);
  });

  it('a new limit starts fresh, so its own thresholds are said again', () => {
    const raised = freshBudget(1_000);
    expect(budgetCrossing(raised, 120).level).toBeUndefined();
    expect(budgetCrossing(raised, 850).level).toBe('WARN');
  });
});
