import { expect, test } from '@playwright/test';

import { nodeCard } from './helpers';
import {
  controlState,
  engineNodeRuns,
  engineRun,
  engineRunCount,
  lastEventSeq,
  openRound3,
  runAction,
  runStatus,
  startRun,
  stillAllows,
  stopRun,
} from './round3';

/**
 * Run controls through the real Canvas (round 3 §5 item 2, §7.1): FR-CTL-001..006.
 *
 * `runs/control-wiring.test.tsx` already drives the toolbar at component level with the Canvas mocked
 * away, so these tests deliberately go where that one cannot: a real browser, a real React Flow
 * canvas with node cards and the node-anchored run menu, and a real navigation when a restart opens
 * the run it created.
 *
 * The rule TC-CTL-006 exists to protect is that the four buttons follow `run.allowedActions` and
 * nothing else, so every assertion below compares the toolbar with what the mock engine recorded on
 * the run rather than with a second table written here.
 */
test.describe('Run controls (FR-CTL-001..004, FR-CTL-006)', () => {
  test('TC-CTL-006: in every run state only the actions the engine allows are enabled', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'slow-stream');

    // Before a run there is no `allowedActions` at all, and the toolbar says so instead of guessing.
    await expect(page.getByTestId('run-controls-unknown')).toBeVisible();
    expect(await controlState(page)).toEqual({ allowed: [], enabled: [] });

    /** The toolbar against the engine's own answer, whatever state the run has reached. */
    const agree = async (expectedStatus: string) => {
      const run = await engineRun(page, seeded.workflowId);
      expect(run?.status).toBe(expectedStatus);
      const allowed = [...(run?.allowedActions ?? [])].sort();
      expect(allowed.length).toBeGreaterThan(0);
      // Neither list is written here: one comes from the engine, the other off the buttons.
      expect(await controlState(page)).toEqual({ allowed, enabled: allowed });
    };

    /** Each leg reads `allowedActions` off the engine first, so a race says so (`round3.ts`). */
    const allows = (action: string) => stillAllows(page, seeded.workflowId, action);

    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING', { timeout: 20_000 });
    await agree('RUNNING');

    await allows('pause');
    await runAction(page, 'pause').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED', { timeout: 20_000 });
    await agree('PAUSED');

    await allows('resume');
    await runAction(page, 'resume').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'RUNNING', { timeout: 20_000 });
    await agree('RUNNING');

    await allows('stop');
    await stopRun(page);
    await expect(runStatus(page)).toHaveAttribute('data-status', 'HALTED', { timeout: 20_000 });
    await agree('HALTED');
  });

  test('TC-CTL-006: a COMPLETE run offers restart alone', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'linear-complete');
    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });

    const run = await engineRun(page, seeded.workflowId);
    const allowed = [...(run?.allowedActions ?? [])].sort();
    expect(allowed.length).toBeGreaterThan(0);
    expect(await controlState(page)).toEqual({ allowed, enabled: allowed });
  });

  test('TC-CTL-001 + TC-CTL-002: Pause stops the next node from starting, Resume finishes the run', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'slow-stream');
    const [writer, editor] = seeded.agentIds as [string, string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 10_000,
    });

    await runAction(page, 'pause').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'PAUSED', { timeout: 10_000 });

    /*
     * FR-CTL-001: no new dispatch. A paused run emits nothing, so its event log stops moving — the
     * positive check behind a negative claim, and it fails if the queue kept playing. The window is
     * four frames of this script (250 ms between tokens at the slow pace, D200), so a queue that
     * kept going could not slip through it. Longer is stronger here, not weaker: this is a window in
     * which nothing may happen, not a wait for something to happen.
     */
    const frozenAt = await lastEventSeq(page);
    await page.waitForTimeout(1_000);
    expect(await lastEventSeq(page)).toBe(frozenAt);

    const runId = (await engineRun(page, seeded.workflowId))!.id;
    const startedEditor = (await engineNodeRuns(page, runId)).filter(
      (nodeRun) => nodeRun.nodeId === editor && nodeRun.status === 'RUNNING',
    );
    expect(startedEditor).toHaveLength(0);
    await expect(nodeCard(page, editor)).not.toHaveAttribute('data-state', 'RUNNING');

    await runAction(page, 'resume').click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 30_000 });
    await expect(nodeCard(page, editor)).toHaveAttribute('data-state', 'COMPLETED');
    await expect(page.getByTestId(`final-output-${seeded.outputId}`)).toBeVisible();
  });

  test('TC-CTL-003: Stop asks first, then halts the run "stopped by you" with no failure', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'slow-stream');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 10_000,
    });

    // The confirmation is not optional: a cancel leaves the run running.
    await runAction(page, 'stop').click();
    await expect(page.getByTestId('stop-confirm')).toBeVisible();
    await page.getByRole('button', { name: 'Keep running' }).click();
    await expect(page.getByTestId('stop-confirm')).toBeHidden();
    expect((await engineRun(page, seeded.workflowId))?.status).toBe('RUNNING');

    await stopRun(page);
    await expect(runStatus(page)).toHaveAttribute('data-status', 'HALTED', { timeout: 10_000 });

    const run = await engineRun(page, seeded.workflowId);
    expect(run?.haltReason).toBe('stopped');
    const halt = page.getByTestId('workflow-page').getByTestId('halt-reason');
    await expect(halt).toHaveAttribute('data-reason', 'stopped');
    await expect(halt).toContainText('stopped by you');
    await expect(halt.getByTestId('halt-reason-advice')).toContainText('Nothing failed');

    // FR-ERR-007: what the operator stopped is STOPPED, never FAILED.
    const nodeRuns = await engineNodeRuns(page, run!.id);
    expect(nodeRuns.some((nodeRun) => nodeRun.status === 'STOPPED')).toBe(true);
    expect(nodeRuns.some((nodeRun) => nodeRun.status === 'FAILED')).toBe(false);
  });

  test('TC-CTL-004: Restart opens a new run with a new id', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'linear-complete');
    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });

    const first = (await engineRun(page, seeded.workflowId))!;
    expect(await engineRunCount(page, seeded.workflowId)).toBe(1);

    await runAction(page, 'restart').click();

    // The restart answers with a *new* run, and the new run is the one the operator is shown.
    await expect(page).toHaveURL(/\/runs\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByTestId('run-detail-status')).toBeVisible();
    const openedRunId = page.url().split('/runs/')[1]!;
    expect(openedRunId).not.toBe(first.id);

    expect(await engineRunCount(page, seeded.workflowId)).toBe(2);
    const second = (await engineRun(page, seeded.workflowId))!;
    expect(second.id).toBe(openedRunId);
  });

  test('FR-CTL-005 + FR-ERR-003/004 + FR-EXE-013: the node carries its own run actions', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'linear-complete');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });

    // The menu is on the node card itself, not only in the inspector.
    await nodeCard(page, writer).getByTestId(`node-actions-${writer}`).click();

    // A COMPLETED node has nothing to retry (FR-ERR-003 needs a failure), but it can be re-run.
    await expect(page.getByTestId(`node-action-retry-${writer}`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByTestId(`node-action-retry-downstream-${writer}`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const rerun = page.getByTestId(`node-action-rerun-${writer}`);
    await expect(rerun).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(`node-action-start-from-${writer}`)).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const runId = (await engineRun(page, seeded.workflowId))!.id;
    const before = (await engineNodeRuns(page, runId)).filter((run) => run.nodeId === writer);
    await rerun.click();

    // FR-CTL-005: exactly one more attempt of that node, on the latest upstream output.
    await expect
      .poll(
        async () =>
          (await engineNodeRuns(page, runId)).filter((run) => run.nodeId === writer).length,
        { timeout: 15_000 },
      )
      .toBe(before.length + 1);
    const latest = (await engineNodeRuns(page, runId))
      .filter((run) => run.nodeId === writer)
      .at(-1)!;
    expect(latest.attempt).toBe(before.at(-1)!.attempt + 1);
  });

  test('FR-CTL-006: the run page offers the same controls the engine allows', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'linear-complete');
    await startRun(page).click();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });

    const run = (await engineRun(page, seeded.workflowId))!;
    await page.goto(`/runs/${run.id}`);
    await expect(page.getByTestId('run-detail-status')).toHaveAttribute('data-status', 'COMPLETE');

    const allowed = [...run.allowedActions].sort();
    expect(await controlState(page)).toEqual({ allowed, enabled: allowed });
  });
});
