import { HALT_REASONS, type BudgetHalt, type HaltReason } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { HaltReasonNote, haltReasonAdvice, haltReasonText, money } from './HaltReason';

/** The words §5 item 3 asks for, one per `HaltReason` — the list is the contract's, not ours. */
const EXPECTED: Readonly<Record<HaltReason, string>> = {
  stopped: 'stopped by you',
  budget_exceeded: 'budget exceeded',
  failure: 'a node failed',
  shutdown: 'the engine shut down',
  crash: 'the engine crashed',
};

const BUDGET: BudgetHalt = { scope: 'run', capUsd: 0.01, costUsd: 0.012, projected: false };

describe('FR-GRD-008 a HALTED run says why, in plain words', () => {
  it.each(HALT_REASONS)('%s reads as a sentence and carries a next step', (reason) => {
    render(
      <HaltReasonNote
        reason={reason}
        {...(reason === 'budget_exceeded' ? { budgetHalt: BUDGET } : {})}
      />,
    );
    const note = screen.getByTestId('halt-reason');
    expect(note).toHaveAttribute('data-reason', reason);
    expect(note).toHaveTextContent(EXPECTED[reason]);
    // NFR-USE-03: what happened is never the whole message.
    expect(screen.getByTestId('halt-reason-advice')).toHaveTextContent(/\w/);
    // No snake_case enum name leaks into the sentence (`budget_exceeded` is the one that could).
    expect(note.textContent).not.toContain('_');
  });

  it('spells the budget out as "$0.012 > $0.01 cap" and names the cap to raise (TC-GRD-012)', () => {
    render(<HaltReasonNote reason="budget_exceeded" budgetHalt={BUDGET} />);
    expect(screen.getByTestId('halt-reason')).toHaveTextContent(
      'budget exceeded: $0.012 > $0.01 cap',
    );
    expect(screen.getByTestId('halt-reason-advice')).toHaveTextContent('max cost per run');
  });

  it('sends a daily halt to Settings instead, and says a projected figure was not all spent', () => {
    const daily: BudgetHalt = { scope: 'daily', capUsd: 2, costUsd: 2.5, projected: true };
    expect(haltReasonText('budget_exceeded', daily)).toBe('budget exceeded: $2.50 > $2.00 cap');
    expect(haltReasonAdvice('budget_exceeded', daily)).toContain('daily budget in Settings');
    expect(haltReasonAdvice('budget_exceeded', daily)).toContain('projected cost');
  });

  it('still reads as words when the engine recorded no budgetHalt (the field is optional)', () => {
    expect(haltReasonText('budget_exceeded')).toBe('budget exceeded');
    expect(haltReasonAdvice('budget_exceeded')).toContain('Raise the cap');
  });

  it('a stop is not a failure: its next step is a restart, not a fix (FR-ERR-007)', () => {
    expect(haltReasonAdvice('stopped')).toContain('Nothing failed');
  });

  it('money keeps two decimals and drops the rest of the zeros', () => {
    expect([money(1), money(0.01), money(0.012), money(0.0001)]).toEqual([
      '$1.00',
      '$0.01',
      '$0.012',
      '$0.0001',
    ]);
  });
});
