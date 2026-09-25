import type { PolicyTestVerdict, Verdict } from '@ace/contracts';
import { VerdictBadge } from '@ace/ui';

/**
 * A list of guardrail verdicts: for each one the check, its point, the action taken, whether it
 * passed and why (FR-GRD-015, TC-GRD-019). The chip is `VerdictBadge` from `@ace/ui`, so the action
 * wording — `ask_user` as "ask user" — is written in one place (FR-GRD-011).
 *
 * A redaction shows the *types* removed and never the value (FR-GRD-014, TC-GRD-018): the contract
 * gives a `Verdict` no field to carry one, and nothing here renders anything but `redactedTypes`.
 */
export function VerdictList({ verdicts }: { verdicts: readonly Verdict[] }) {
  if (verdicts.length === 0) {
    return (
      <p data-testid="verdicts-empty" className="text-sm text-fg-muted">
        No verdicts.
      </p>
    );
  }

  return (
    <ul data-testid="verdict-list" className="flex flex-col gap-2">
      {verdicts.map((verdict) => (
        <li
          key={verdict.id}
          data-testid={`verdict-row-${verdict.id}`}
          className="flex flex-col gap-1 rounded-card border border-border bg-card px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={verdict} />
            <span
              data-testid={`verdict-passed-${verdict.id}`}
              className={verdict.passed ? 'text-xs text-fg-muted' : 'text-xs text-danger'}
            >
              {verdict.passed ? 'passed' : 'did not pass'}
            </span>
          </div>
          <p className="text-sm">{verdict.reason}</p>
          {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
            <p className="font-machine text-xs text-fg-muted">
              types removed: {verdict.redactedTypes.join(', ')} — the values are not recorded
              (FR-GRD-014).
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A tested verdict has neither `id` nor `nodeRunId` — it belongs to no node run (§2.2) — while the
 * shared `VerdictBadge` renders a stored one. This gives each tested verdict a key built from its
 * position, so the list can render without inventing anything a run would own.
 */
export function toDisplayVerdicts(
  verdicts: readonly PolicyTestVerdict[],
  prefix = 'test',
): Verdict[] {
  return verdicts.map((verdict, index) => ({
    ...verdict,
    id: `${prefix}-${index}`,
    nodeRunId: `${prefix}-none`,
  }));
}
