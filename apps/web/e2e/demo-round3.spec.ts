import { expect, test } from '@playwright/test';

import { nodeCard } from './helpers';
import {
  NODE_NAMES,
  controlState,
  engineNodeRuns,
  engineRun,
  enginePolicies,
  inspect,
  openBottomTab,
  openRound3,
  runAction,
  runStatus,
  setRunCostCap,
  startRun,
  stillAllows,
  stopRun,
} from './round3';

/**
 * Round 3 §1, walked end to end in one browser, in the order an operator would meet it.
 *
 * Every other spec in this round proves one thing carefully. This one proves they hold *together*:
 * the same person pausing a run, resuming it, stopping the next one, reading a failure and the node
 * it blocked, answering a guardrail, watching a budget stop a run, and editing the policy that asked
 * — without a reload between the steps that belong to one story.
 */
test.describe('Round 3 §1 — the operator can control, understand and constrain a run', () => {
  test('§1: pause, resume, and the loop that ran three times', async ({ page }) => {
    /*
     * `pace: 'slow'` is what makes the pause below reachable. At the default pace this loop's six
     * node runs are over in 1.49 s measured, and on the 2-vCPU CI runner the Pause click landed
     * after COMPLETE — the run had already finished while Playwright was still scrolling the button
     * into view (D200). `slow` is `mock-slow`'s pace against the real engine, so what this walks is
     * what an operator would actually be looking at.
     */
    const seeded = await openRound3(page, 'loop', 'loop-3-iterations', { pace: 'slow' });
    const [writer] = seeded.agentIds as [string];
    const loopEdgeId = seeded.loopEdgeId!;

    // The Review → Fix loop is on the Canvas before anything runs, with its maximum on show.
    await expect(page.getByTestId(`loop-edge-${loopEdgeId}`)).toHaveAttribute('data-kind', 'loop');

    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING', { timeout: 10_000 });

    // Pause and resume, each offered only because the engine said so (FR-CTL-006).
    await stillAllows(page, seeded.workflowId, 'pause');
    await runAction(page, 'pause').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED', { timeout: 10_000 });
    const paused = await engineRun(page, seeded.workflowId);
    expect(await controlState(page)).toEqual({
      allowed: [...paused!.allowedActions].sort(),
      enabled: [...paused!.allowedActions].sort(),
    });

    await stillAllows(page, seeded.workflowId, 'resume');
    await runAction(page, 'resume').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 30_000 });

    // Three iterations, each recorded and each tellable apart (FR-PAR-005).
    const inspector = await inspect(page, writer);
    await expect(inspector.getByTestId('iteration-selector')).toContainText('3 iterations');
    await expect(page.getByTestId(`loop-edge-iteration-${loopEdgeId}`)).toHaveText('3/3');
  });

  test('§1: a stop is not a failure, and a restart is a new run', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'slow-stream');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 10_000,
    });
    await stopRun(page);
    await expect(runStatus(page)).toHaveAttribute('data-status', 'HALTED', { timeout: 10_000 });
    await expect(page.getByTestId('run-controls').getByTestId('halt-reason')).toContainText(
      'stopped by you',
    );

    await openBottomTab(page, 'Errors');
    const summary = page.getByTestId('errors-tab').getByTestId('run-summary');
    await expect(summary).toHaveAttribute('data-failed', '0');
    await expect(summary).toHaveAttribute('data-stopped', '1');

    // And it can be started again from the ending it reached (FR-CTL-004).
    const first = (await engineRun(page, seeded.workflowId))!;
    await runAction(page, 'restart').click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/, { timeout: 10_000 });
    expect(page.url().split('/runs/')[1]).not.toBe(first.id);
  });

  test('§1: a failure is explained, what it blocked is not blamed, and the retry is offered', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'blocked-downstream');
    const [writer, editor] = seeded.agentIds as [string, string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 15_000,
    });
    await expect(nodeCard(page, editor)).toHaveAttribute('data-state', 'BLOCKED');

    // The failure names itself on its own node, and says where to go (NFR-USE-03).
    const onNode = page
      .locator(`.react-flow__node[data-id="${writer}"]`)
      .getByTestId(`error-card-${writer}`);
    await expect(onNode).toHaveAttribute('data-kind', 'auth');
    await expect(onNode.getByTestId(`error-next-step-${writer}`)).toHaveText(
      'Update the provider key in Providers.',
    );

    // The node it stopped is greyed and blamed on the right node — never failed (FR-ERR-006).
    await expect(page.getByTestId(`blocked-by-${editor}`)).toHaveText(
      `blocked by ${NODE_NAMES.first}`,
    );

    // Retry is offered on the failed node, and is the engine's call to make (FR-ERR-003).
    await nodeCard(page, writer).getByTestId(`node-actions-${writer}`).click();
    await expect(page.getByTestId(`node-action-retry-${writer}`)).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
  });

  test('§1: a guardrail asks, the run waits, the answer lets it finish, and the policy is editable', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();

    // WAITING, with the question anchored to the node that is asking (FR-GRD-013).
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'WAITING', {
      timeout: 15_000,
    });
    const approval = page
      .getByTestId(`node-approval-${writer}`)
      .locator('[data-testid^="approval-card-"]');
    await expect(approval).toBeVisible();
    await expect(page.getByTestId('approvals-badge')).toHaveAttribute('data-count', '1');
    await approval.getByRole('button', { name: /^Approve/ }).click();

    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 25_000 });

    // The verdicts that led to the question are on the record, values never among them (FR-GRD-014).
    const inspector = await inspect(page, writer);
    await expect(inspector.getByTestId('verdict-list')).toContainText('removed api_key');
    expect(await page.content()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/);

    // And the policy that asked can be changed, as a new version (FR-GRD-001).
    await page.goto(`/guardrails?projectId=${seeded.projectId}`);
    const policy = (await enginePolicies(page, seeded.projectId))[0]!;
    await expect(page.getByTestId(`policy-version-${policy.id}`)).toHaveText('version 1');
    // The default policy warns on content at the output point (D10); tighten it to a block.
    const action = page.getByTestId('action-moderation-output');
    await expect(action).toContainText('warn');
    await action.click();
    await page.getByRole('option', { name: 'block' }).click();
    await page.getByRole('button', { name: 'Save as new version' }).click();
    await expect(page.getByTestId('policy-saved-version')).toHaveText('saved as version 2');
  });

  test('§1: a budget stops the run before it spends more, and says which cap', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'budget-halt');
    await setRunCostCap(page, seeded.projectId, 0.01);
    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();

    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'HALTED', { timeout: 20_000 });
    await expect(page.getByTestId('run-controls').getByTestId('halt-reason')).toContainText(
      'budget exceeded: $0.012 > $0.01 cap',
    );

    // Nothing failed, and nothing was dispatched after the halt (FR-GRD-008, TC-GRD-012).
    const run = (await engineRun(page, seeded.workflowId))!;
    const nodeRuns = await engineNodeRuns(page, run.id);
    expect(nodeRuns.some((nodeRun) => nodeRun.status === 'FAILED')).toBe(false);
    expect(nodeRuns.filter((nodeRun) => nodeRun.nodeId === seeded.agentIds[1])).toHaveLength(0);
  });
});
