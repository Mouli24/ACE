import { expect, test } from '@playwright/test';

import { freshApp } from './helpers';
import {
  clickStartRun,
  engineDailyBudget,
  engineProject,
  engineRun,
  expectRunStatus,
  openBottomTab,
  openRound3,
  seedShape,
  setRunCostCap,
} from './round3';

/**
 * Budgets and the halt they cause (round 3 §5 items 3, 10, §7.1): FR-GRD-008 and NFR-USE-03.
 *
 * A cap has two halves that have to agree: the number the operator typed, and the sentence the run
 * shows when that number stops it. These tests hold both ends — the field refuses a cap the contract
 * would not accept, and the halt names the amount, the cap and the one thing to change.
 */
test.describe('Budgets (FR-GRD-008)', () => {
  test('FR-GRD-008: a budget halt says how much, against which cap, and which cap to raise', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'budget-halt');
    // The cap the run is measured against is the project's, not a number this test invents.
    await setRunCostCap(page, seeded.projectId, 0.01);
    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    expect((await engineProject(page, seeded.projectId))?.maxCostPerRunUsd).toBe(0.01);

    await clickStartRun(page);
    await expectRunStatus(page, 'HALTED', { timeout: 20_000 });

    const run = await engineRun(page, seeded.workflowId);
    expect(run?.haltReason).toBe('budget_exceeded');

    const halt = page.getByTestId('workflow-page').getByTestId('halt-reason');
    await expect(halt).toHaveAttribute('data-reason', 'budget_exceeded');
    await expect(halt).toContainText('budget exceeded: $0.012 > $0.01 cap');
    // NFR-USE-03: which of the two caps to raise, since they live on two different screens.
    await expect(halt.getByTestId('halt-reason-advice')).toContainText('max cost per run');
    await expect(halt.getByTestId('halt-reason-advice')).toContainText('projected');

    // A budget halt is not a node failure: nothing is FAILED and the run is HALTED, not COMPLETE.
    await openBottomTab(page, 'Errors');
    const summary = page.getByTestId('errors-tab').getByTestId('run-summary');
    await expect(summary).toHaveAttribute('data-failed', '0');
    await expect(summary.getByTestId('halt-reason')).toContainText(
      'budget exceeded: $0.012 > $0.01 cap',
    );

    // The Events tab carries the cost verdict that stopped it (FR-GRD-015, FR-OBS-002).
    await openBottomTab(page, 'Events');
    const verdict = page.getByTestId('events-list').locator('li[data-type="guardrail.verdict"]');
    await expect(verdict).toHaveCount(1);
    await expect(verdict).toContainText('max_cost_per_run');
  });

  test('FR-GRD-008: the per-run cap is saved on the project and a zero or negative cap is refused inline', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedShape(page, 'chain');
    await page.goto(`/projects/${seeded.projectId}`);
    const fields = page.getByTestId('budget-fields');
    await expect(fields).toBeVisible();

    const cap = fields.getByTestId('max-cost-per-run');
    await expect(cap).toHaveAttribute('placeholder', 'no cap');
    expect((await engineProject(page, seeded.projectId))?.maxCostPerRunUsd).toBeNull();

    // A cap the contract accepts is saved.
    await cap.fill('0.25');
    await cap.blur();
    await expect
      .poll(async () => (await engineProject(page, seeded.projectId))?.maxCostPerRunUsd)
      .toBe(0.25);

    // Zero is refused inline and never saved — a run must not be stopped by a cap the engine
    // would have rejected (`BudgetUsdSchema`).
    await cap.fill('0');
    await cap.blur();
    await expect(fields.getByRole('alert')).toHaveText('Must be an amount above 0.');
    await expect(cap).toHaveAttribute('aria-invalid', 'true');
    expect((await engineProject(page, seeded.projectId))?.maxCostPerRunUsd).toBe(0.25);

    // And so is a negative one.
    await cap.fill('-5');
    await cap.blur();
    await expect(fields.getByRole('alert')).toHaveText('Must be an amount above 0.');
    expect((await engineProject(page, seeded.projectId))?.maxCostPerRunUsd).toBe(0.25);

    // Blank is not an error: it is "no cap", which is how a cap is removed (D72).
    await cap.fill('');
    await cap.blur();
    await expect(fields.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(async () => (await engineProject(page, seeded.projectId))?.maxCostPerRunUsd)
      .toBeNull();
  });

  test('FR-GRD-008: the daily budget lives in Settings, saves, and refuses a zero cap inline', async ({
    page,
  }) => {
    await freshApp(page);
    await page.goto('/settings');
    const fields = page.getByTestId('budget-fields');
    await expect(fields).toBeVisible();

    // The two caps live on two resources, so each screen shows only its own.
    const daily = fields.getByTestId('daily-budget');
    await expect(daily).toBeVisible();
    await expect(fields.getByTestId('max-cost-per-run')).toHaveCount(0);
    await expect(fields).toContainText('Max tokens per node is set on the node itself');

    await daily.fill('2.5');
    await daily.blur();
    await expect.poll(async () => engineDailyBudget(page)).toBe(2.5);

    await daily.fill('0');
    await daily.blur();
    await expect(fields.getByRole('alert')).toHaveText('Must be an amount above 0.');
    expect(await engineDailyBudget(page)).toBe(2.5);

    // It is the engine's setting now, not a draft: a reload shows it back (BR-01).
    await page.reload();
    await expect(fields.getByTestId('daily-budget')).toHaveValue('2.5');
  });
});
