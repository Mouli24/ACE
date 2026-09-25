import { ProjectSchema, SettingsPatchSchema } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BudgetFields, readBudget } from './BudgetFields';

function setup(over: Partial<Parameters<typeof BudgetFields>[0]> = {}): {
  onSaveDailyBudget: ReturnType<typeof vi.fn>;
  onSaveMaxCostPerRun: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onSaveDailyBudget = vi.fn();
  const onSaveMaxCostPerRun = vi.fn();
  render(
    <BudgetFields
      dailyBudgetUsd={null}
      maxCostPerRunUsd={null}
      onSaveDailyBudget={onSaveDailyBudget}
      onSaveMaxCostPerRun={onSaveMaxCostPerRun}
      {...over}
    />,
  );
  return { onSaveDailyBudget, onSaveMaxCostPerRun, user: userEvent.setup() };
}

describe('FR-GRD-008 budget fields', () => {
  it('shows the daily budget and the per-run cap, and says where max tokens lives', () => {
    setup({ dailyBudgetUsd: 5, maxCostPerRunUsd: 0.01 });
    expect(screen.getByLabelText(/daily budget/i)).toHaveValue(5);
    expect(screen.getByLabelText(/max cost per run/i)).toHaveValue(0.01);
    expect(screen.getByTestId('budget-fields')).toHaveTextContent(
      'Max tokens per node is set on the node itself',
    );
  });

  it.each([
    ['0', 'zero'],
    ['-1', 'negative'],
  ])('refuses a %s cap inline and saves nothing (%s)', async (typed) => {
    const { onSaveDailyBudget, onSaveMaxCostPerRun, user } = setup();
    const daily = screen.getByLabelText(/daily budget/i);
    await user.clear(daily);
    await user.type(daily, typed);

    expect(await screen.findByRole('alert')).toHaveTextContent('Must be an amount above 0.');
    expect(daily).toHaveAttribute('aria-invalid', 'true');
    await user.tab();
    expect(onSaveDailyBudget).not.toHaveBeenCalled();
    expect(onSaveMaxCostPerRun).not.toHaveBeenCalled();
  });

  it('saves a cap the contract accepts, through the callback', async () => {
    const { onSaveDailyBudget, user } = setup();
    const daily = screen.getByLabelText(/daily budget/i);
    await user.type(daily, '2.5');
    await user.tab();
    expect(onSaveDailyBudget).toHaveBeenCalledWith(2.5);
    expect(SettingsPatchSchema.safeParse({ dailyBudgetUsd: 2.5 }).success).toBe(true);
  });

  it('saves the per-run cap separately from the daily one', async () => {
    const { onSaveDailyBudget, onSaveMaxCostPerRun, user } = setup();
    const perRun = screen.getByLabelText(/max cost per run/i);
    await user.type(perRun, '0.01');
    await user.tab();
    expect(onSaveMaxCostPerRun).toHaveBeenCalledWith(0.01);
    expect(onSaveDailyBudget).not.toHaveBeenCalled();
  });

  it('clears a cap to null — which is how a PATCH removes one', async () => {
    const { onSaveDailyBudget, user } = setup({ dailyBudgetUsd: 5 });
    const daily = screen.getByLabelText(/daily budget/i);
    await user.clear(daily);
    await user.tab();
    expect(onSaveDailyBudget).toHaveBeenCalledWith(null);
    expect(SettingsPatchSchema.safeParse({ dailyBudgetUsd: null }).success).toBe(true);
  });

  it('saves nothing when the amount is edited back to what it already was', async () => {
    const { onSaveDailyBudget, user } = setup({ dailyBudgetUsd: 5 });
    const daily = screen.getByLabelText(/daily budget/i);
    await user.clear(daily);
    await user.type(daily, '5');
    await user.tab();
    expect(onSaveDailyBudget).not.toHaveBeenCalled();
  });

  it('shows an absent cap as blank, not as zero', () => {
    setup({ dailyBudgetUsd: undefined, maxCostPerRunUsd: undefined });
    expect(screen.getByLabelText(/daily budget/i)).toHaveValue(null);
    expect(screen.getByLabelText(/max cost per run/i)).toHaveValue(null);
  });
});

describe('FR-GRD-008 budget bounds come from the contract', () => {
  it('accepts exactly what BudgetUsdSchema accepts', () => {
    expect(readBudget('0.01')).toEqual({ value: 0.01 });
    expect(readBudget('  12 ')).toEqual({ value: 12 });
    expect(readBudget('')).toEqual({ value: null });
    expect(readBudget('   ')).toEqual({ value: null });
    for (const refused of ['0', '-0.01', '-5', 'free']) {
      expect(readBudget(refused)).toEqual({ error: 'Must be an amount above 0.' });
    }
  });

  it('never produces a value the project schema would refuse', () => {
    for (const raw of ['0.01', '7', '1000.5']) {
      const read = readBudget(raw);
      expect('value' in read).toBe(true);
      const maxCostPerRunUsd = 'value' in read ? read.value : 0;
      expect(ProjectSchema.shape.maxCostPerRunUsd.safeParse(maxCostPerRunUsd).success).toBe(true);
    }
  });
});
