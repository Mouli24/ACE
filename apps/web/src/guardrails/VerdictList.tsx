import type { PolicyTestVerdict, Verdict } from '@ace/contracts';
import { VerdictBadge } from '@ace/ui';

/**
 * A list of guardrail verdicts: for each one the check, its point, the action taken, whether it
 * passed and why (FR-GRD-015, TC-GRD-019). The chip is `VerdictBadge` from `@ace/ui`, so the action
 * wording — `ask_user` as "ask user" — is written in one place (FR-GRD-011).
 *
 * A redaction shows the *types* removed and never the value (FR-GRD-014, TC-GRD-018): the contract
 * gives a `Verdict` no field to carry one, and nothing here renders anything but `redactedTypes`.
 * The context point's hidden-instruction sanitiser is the same: `strippedTypes` names the kinds it
 * took out, never the text (round 5 §2.3, FR-GRD-004). Each verdict is a theme inner box (D328).
 */
export function VerdictList({ verdicts }: { verdicts: readonly Verdict[] }) {
  if (verdicts.length === 0) {
    return (
      <p data-testid="verdicts-empty" className="text-[13px] text-[var(--muted)]">
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
          className="flex flex-col gap-1 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={verdict} />
            <span
              data-testid={`verdict-passed-${verdict.id}`}
              className={
                verdict.passed
                  ? 'text-[11px] text-[var(--muted)]'
                  : 'text-[11px] font-semibold text-[#c94c27]'
              }
            >
              {verdict.passed ? 'passed' : 'did not pass'}
            </span>
          </div>
          <p className="text-[12.5px]">{verdict.reason}</p>
          {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
            <p className="font-machine text-[10px] text-[var(--muted)]">
              types removed: {verdict.redactedTypes.join(', ')} — the values are not recorded
              (FR-GRD-014).
            </p>
          )}
          {verdict.strippedTypes !== undefined && verdict.strippedTypes.length > 0 && (
            <p
              data-testid={`verdict-stripped-${verdict.id}`}
              className="font-machine text-[10px] text-[var(--muted)]"
            >
              hidden instructions stripped: {verdict.strippedTypes.join(', ')} — the text is not
              recorded (FR-GRD-004).
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
