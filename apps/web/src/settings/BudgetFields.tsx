import { BudgetUsdSchema } from '@ace/contracts';
import { Input } from '@ace/ui';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { HELP_CLASS, SettingField } from './SettingFields';

/**
 * A cap the contract accepts, or why it does not. Empty is not an error: no cap is `null`, which is
 * how a PATCH removes one (D72).
 */
export function readBudget(raw: string): { value: number | null } | { error: string } {
  if (raw.trim() === '') return { value: null };
  const parsed = BudgetUsdSchema.safeParse(Number(raw));
  return parsed.success ? { value: parsed.data } : { error: 'Must be an amount above 0.' };
}

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
};

/** One money box: blank means no cap, and an amount the contract refuses is never saved. */
function BudgetField({
  label,
  hint,
  testId,
  value,
  onSave,
  disabled,
}: {
  label: string;
  hint: string;
  testId: string;
  value: number | null | undefined;
  onSave: (value: number | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const asText = value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  useEffect(() => setDraft(asText), [asText]);

  const read = readBudget(draft);
  const error = 'error' in read ? read.error : undefined;

  const commit = () => {
    if ('error' in read) return;
    const current = value === undefined ? null : value;
    if (read.value !== current) onSave(read.value);
  };

  return (
    <SettingField label={label} htmlFor={id} {...(error === undefined ? { hint } : { error })}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="no cap"
        value={draft}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={error === undefined ? undefined : true}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        className="font-machine text-[12px]"
      />
    </SettingField>
  );
}

/**
 * The two spending caps of FR-GRD-008: what every run together may spend in a day (engine settings,
 * `Settings.dailyBudgetUsd`) and what one run of this project may spend (`Project.maxCostPerRunUsd`).
 * The third cap, max tokens per node, is already in a node's execution settings.
 *
 * Both are validated by the contract's own `BudgetUsdSchema`, so a zero or a negative cap is refused
 * inline and never saved — a run must not be stopped by a cap the engine would have rejected. A
 * blank box is no cap and saves `null`, which is how a PATCH removes one. Saving goes through the
 * callbacks: this component knows nothing about which resource each cap belongs to.
 */
/**
 * Which caps to show. The two live on different resources, so they live on different screens — the
 * daily budget under Settings, the per-run cap on the project — and `both` is what a test or a future
 * single screen uses.
 */
export type BudgetFieldSet = 'both' | 'daily' | 'run';

export function BudgetFields({
  dailyBudgetUsd,
  maxCostPerRunUsd,
  onSaveDailyBudget,
  onSaveMaxCostPerRun,
  fields = 'both',
  disabled,
}: {
  dailyBudgetUsd: number | null | undefined;
  maxCostPerRunUsd: number | null | undefined;
  onSaveDailyBudget: (value: number | null) => void;
  onSaveMaxCostPerRun: (value: number | null) => void;
  fields?: BudgetFieldSet;
  disabled?: boolean;
}) {
  return (
    <section className="flex flex-col gap-4" data-testid="budget-fields">
      <h2 className="text-[14px] font-bold">Budgets</h2>
      {fields !== 'run' && (
        <BudgetField
          label="Daily budget (USD)"
          hint="What every run together may spend in a day. Blank is no cap."
          testId="daily-budget"
          value={dailyBudgetUsd}
          onSave={onSaveDailyBudget}
          {...(disabled === undefined ? {} : { disabled })}
        />
      )}
      {fields !== 'daily' && (
        <BudgetField
          label="Max cost per run (USD)"
          hint="A run of this project that would cost more halts, reason budget_exceeded."
          testId="max-cost-per-run"
          value={maxCostPerRunUsd}
          onSave={onSaveMaxCostPerRun}
          {...(disabled === undefined ? {} : { disabled })}
        />
      )}
      <p className={HELP_CLASS}>
        Max tokens per node is set on the node itself, under execution settings.
      </p>
    </section>
  );
}
