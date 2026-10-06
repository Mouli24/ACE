import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from '@ace/contracts';
import { cn } from '@ace/ui';

/** One sentence each, from the contract's own description of the modes (settings.ts, D270). */
const MODES: readonly { mode: ApprovalMode; label: string; sentence: string }[] = [
  {
    mode: 'ask',
    label: 'Ask for approval',
    sentence:
      'Agents work inside the project’s bounded access and ask before anything broader; every final action — apply, merge, accept, send — waits for you.',
  },
  {
    mode: 'auto_review',
    label: 'Approve for me',
    sentence:
      'A coding-agent CLI may use its provider’s own permission preset; final actions still wait for you.',
  },
  {
    mode: 'full_access',
    label: 'Full access',
    sentence:
      'A coding-agent CLI may run with full access, and an Autopilot task’s final action runs by itself once its checks pass.',
  },
];

/**
 * Settings › Approval mode (ACE parity P0, D270): ACE's one approval choice, as three radio cards.
 * Absent reads as Ask. None of the three lets a destructive tool call skip its approval card.
 */
export function ApprovalModeSection({
  value,
  disabled,
  onChange,
}: {
  value: ApprovalMode | undefined;
  disabled: boolean;
  onChange: (mode: ApprovalMode) => void;
}) {
  const current = value ?? DEFAULT_APPROVAL_MODE;
  return (
    <section className="flex flex-col gap-4" data-testid="settings-approval">
      <h2 id="settings-approval-title" className="font-human text-sm font-semibold">
        Approval mode
      </h2>
      <div
        role="radiogroup"
        aria-labelledby="settings-approval-title"
        className="grid grid-cols-1 gap-2"
      >
        {MODES.map(({ mode, label, sentence }) => (
          <label
            key={mode}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-card border border-border bg-panel p-3 transition-colors hover:border-fg-muted',
              current === mode && 'border-fg-muted bg-card',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name="approval-mode"
              value={mode}
              checked={current === mode}
              disabled={disabled}
              className="mt-1"
              onChange={() => {
                if (mode !== current) onChange(mode);
              }}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-human text-sm font-medium">{label}</span>
              <span className="text-xs leading-snug text-fg-muted">{sentence}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        Whatever the mode, a destructive tool call still waits for its approval card.
      </p>
    </section>
  );
}
