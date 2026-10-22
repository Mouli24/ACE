import type { BudgetHalt, HaltReason } from '@ace/contracts';

/**
 * Why a run HALTED, in words (round 3 §5 item 3, FR-GRD-008, NFR-USE-03). The enum stays the
 * contract — `HaltReason` is what the engine sends and what the tests assert — and this module is
 * the only place that turns one into a sentence, so the run bar, the Errors tab and the Events tab
 * all read the same.
 *
 * A halt never reads as "an error happened": it says what ended the run and, where there is one,
 * the single thing to change to get further (NFR-USE-03).
 */

/**
 * Costs are compared at four decimal places by the engine, so that is what is shown — with the
 * trailing zeros dropped, because "$0.012 > $0.01 cap" is the sentence §5 item 3 asks for and
 * "$0.0120 > $0.0100" is not. Never fewer than two decimals, so a cap still reads as money.
 */
export function money(value: number): string {
  const trimmed = value.toFixed(4).replace(/0+$/, '');
  const [whole = '0', fraction = ''] = (trimmed.endsWith('.') ? `${trimmed}00` : trimmed).split(
    '.',
  );
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/**
 * What ended the run. `budgetHalt` is what makes the budget sentence exact (D80); a run recorded
 * without one — the field is optional — still gets a whole sentence rather than an enum name.
 */
export function haltReasonText(reason: HaltReason, budgetHalt?: BudgetHalt): string {
  switch (reason) {
    case 'stopped':
      return 'stopped by you';
    case 'budget_exceeded':
      return budgetHalt === undefined
        ? 'budget exceeded'
        : `budget exceeded: ${money(budgetHalt.costUsd)} > ${money(budgetHalt.capUsd)} cap`;
    case 'failure':
      return 'a node failed';
    case 'shutdown':
      return 'the engine shut down';
    case 'crash':
      return 'the engine crashed';
  }
}

/** The next step: for a budget halt, which of the two caps to raise — they live in two places. */
export function haltReasonAdvice(reason: HaltReason, budgetHalt?: BudgetHalt): string {
  switch (reason) {
    // D388: a run cut off with work left can be carried on where it stopped, not only restarted.
    case 'stopped':
      return 'Nothing failed. Continue runs what you stopped and keeps what finished; Restart starts over.';
    case 'budget_exceeded': {
      if (budgetHalt === undefined) return 'Raise the cap, or make the run cheaper, then restart.';
      const cap =
        budgetHalt.scope === 'run'
          ? "Raise this project's max cost per run, or make the run cheaper."
          : 'Raise the daily budget in Settings, or wait for tomorrow.';
      return budgetHalt.projected
        ? `${cap} The figure includes the next node's projected cost, so the run spent less than that.`
        : cap;
    }
    case 'failure':
      return 'Open the Errors tab to see which node failed, then retry it.';
    case 'shutdown':
      return 'Continue carries the run on where the shutdown cut it off, or restart it.';
    case 'crash':
      return 'The run up to the crash is recorded. Continue carries it on where it stopped, or restart it.';
  }
}

export interface HaltReasonNoteProps {
  reason: HaltReason;
  /** Set by the engine only when `reason` is `budget_exceeded` (D80). */
  budgetHalt?: BudgetHalt;
  /** Hide the second line where the surrounding card already says what to do. */
  hideAdvice?: boolean;
  className?: string;
}

/**
 * The halt in words, with the next step under it (FR-GRD-008, NFR-USE-03): the theme's status dot in
 * the neutral STOPPED colour — a halt is not painted as a fault — the sentence at 13px, the advice
 * as the theme's 11px help line.
 */
export function HaltReasonNote({ reason, budgetHalt, hideAdvice, className }: HaltReasonNoteProps) {
  return (
    <div
      data-testid="halt-reason"
      data-reason={reason}
      className={['flex items-start gap-2', className].filter(Boolean).join(' ')}
    >
      <span
        aria-hidden
        className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-status-STOPPED)]"
      />
      <div className="flex flex-col gap-[2px]">
        <p className="m-0 text-[13px] text-[var(--ink)]">
          Run halted — {haltReasonText(reason, budgetHalt)}
        </p>
        {!hideAdvice && (
          <p
            className="m-0 text-[11px] leading-[1.45] text-[var(--muted)]"
            data-testid="halt-reason-advice"
          >
            {haltReasonAdvice(reason, budgetHalt)}
          </p>
        )}
      </div>
    </div>
  );
}
