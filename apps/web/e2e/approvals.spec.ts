import { expect, test, type Page } from '@playwright/test';

import { nodeCard } from './helpers';
import {
  NODE_NAMES,
  engineNodeRuns,
  engineRun,
  inspect,
  openRound3,
  runStatus,
  startRun,
} from './round3';

/**
 * The approval card (round 3 §5 item 4, §7.1): FR-GRD-013, FR-MOB-002, TC-GRD-008/009, TC-MOB-002.
 *
 * A card is anchored to the node it is about, so these tests run on the real Canvas — which is
 * exactly what `runs/control-wiring.test.tsx` cannot do, because it mocks the Canvas away. What is
 * checked here and not there: the card sitting on its node, the real browser keyboard path, the
 * layout at phone width, and the badge in the top bar.
 */

/** The card anchored to a node; its own test id carries a node run id a test cannot know. */
const approvalOn = (page: Page, nodeId: string) =>
  page.getByTestId(`node-approval-${nodeId}`).locator('[data-testid^="approval-card-"]');

test.describe('Approvals (FR-GRD-013, TC-GRD-008/009)', () => {
  test('TC-GRD-008: the node waits, the card on it says why, and Approve continues the run', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer, editor] = seeded.agentIds as [string, string];

    await startRun(page).click();

    // The node is WAITING while the card is up, and stays WAITING until the engine hears a decision.
    const card = nodeCard(page, writer);
    await expect(card).toHaveAttribute('data-state', 'WAITING', { timeout: 15_000 });
    await expect(card.getByTestId('status-ring')).toHaveAttribute('aria-label', 'waiting');

    // Anchored to the node the question is about, and to no other node.
    const approval = approvalOn(page, writer);
    await expect(approval).toBeVisible();
    await expect(page.getByTestId(`node-approval-${editor}`)).toHaveCount(0);

    // FR-GRD-013's five facts: node name, point, check type, reason, preview.
    await expect(approval).toContainText(NODE_NAMES.first);
    await expect(approval).toHaveAttribute('data-point', 'output');
    await expect(approval).toHaveAttribute('data-check', 'pii');
    await expect(approval).toContainText('output · pii · asks you');
    await expect(approval.getByTestId('approval-reason')).toHaveText(
      'The output contains an email address.',
    );
    await expect(approval.getByTestId('approval-preview')).toContainText('[email redacted]');
    await expect(approval).toHaveAttribute('aria-label', `Approval needed for ${NODE_NAMES.first}`);

    // The top bar counts what is waiting, from the engine's own list rather than the socket's fold.
    await expect(page.getByTestId('approvals-badge')).toHaveAttribute('data-count', '1');

    await approval.getByRole('button', { name: /^Approve/ }).click();

    /*
     * `node.approval_decided` is what removes the card — not the click — so this is the assertion
     * that the engine was asked and answered. (The card's own "Approved — the node continues." line
     * lives only between the POST and that frame, which the mock engine answers too fast to catch.)
     */
    await expect(page.getByTestId(`node-approval-${writer}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('approvals-badge')).toHaveCount(0);

    // Approve continues the node it paused, and the run reaches its end.
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
    await expect(nodeCard(page, editor)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE');

    // The decision is on the record, with its time (FR-GRD-013).
    const inspector = await inspect(page, writer);
    const decisions = inspector.getByTestId('inspector-approvals');
    await expect(decisions).toBeVisible();
    await expect(decisions.locator('[data-decision="approve"]')).toHaveCount(1);
    await expect(decisions).toContainText('approved');
  });

  test('TC-GRD-009: Reject fails the node as GUARDRAIL_VIOLATION, shown apart from CONTRACT_VIOLATION', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer, editor] = seeded.agentIds as [string, string];

    await startRun(page).click();
    const approval = approvalOn(page, writer);
    await expect(approval).toBeVisible({ timeout: 15_000 });

    // A note travels with the decision.
    await approval.getByLabel('Decision note').fill('not for a customer');
    await approval.getByRole('button', { name: /^Reject/ }).click();

    await expect(page.getByTestId(`node-approval-${writer}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 15_000,
    });

    const guardrail = page.getByTestId(`failure-${writer}`);
    await expect(guardrail).toHaveAttribute('data-reason', 'GUARDRAIL_VIOLATION');
    await expect(guardrail).toHaveText('blocked by a guardrail');
    await expect(runStatus(page)).toHaveAttribute('data-status', 'HALTED');
    // Nothing downstream is dragged into a failure of its own.
    await expect(nodeCard(page, editor)).not.toHaveAttribute('data-state', 'FAILED');

    const run = (await engineRun(page, seeded.workflowId))!;
    const writerRun = (await engineNodeRuns(page, run.id))
      .filter((nodeRun) => nodeRun.nodeId === writer)
      .at(-1)!;
    expect(writerRun.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(writerRun.errorKind).toBe('guardrail');

    const inspector = await inspect(page, writer);
    await expect(inspector.getByTestId('inspector-failure-reason')).toHaveText(
      'GUARDRAIL_VIOLATION',
    );
    await expect(inspector.getByTestId('inspector-approvals')).toContainText('not for a customer');

    /*
     * BR-03: the other failure that is not this one. A contract violation reads differently in the
     * same place on the same card — if the two were ever folded together, these strings would be
     * equal and this test would fail.
     */
    const contract = await openRound3(page, 'chain', 'contract-violation');
    await startRun(page).click();
    const contractNode = page.getByTestId(`failure-${contract.agentIds[0]}`);
    await expect(contractNode).toHaveAttribute('data-reason', 'CONTRACT_VIOLATION', {
      timeout: 15_000,
    });
    await expect(contractNode).toHaveText('output did not match the contract');
    expect(await contractNode.textContent()).not.toBe('blocked by a guardrail');
  });

  test('TC-GRD-013: the keyboard decides the one open card — R rejects, A approves', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(approvalOn(page, writer)).toBeVisible({ timeout: 15_000 });

    // `R` rejects the card without a pointer ever touching it.
    await page.keyboard.press('r');
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 15_000,
    });

    // And `A` approves the next one.
    const approved = await openRound3(page, 'chain', 'waiting-approval');
    await startRun(page).click();
    await expect(approvalOn(page, approved.agentIds[0]!)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('a');
    await expect(nodeCard(page, approved.agentIds[0]!)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
  });

  test('TC-GRD-013: a letter typed into the note never decides the card', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];
    await startRun(page).click();
    const approval = approvalOn(page, writer);
    await expect(approval).toBeVisible({ timeout: 15_000 });

    const note = approval.getByLabel('Decision note');
    await note.click();
    await note.pressSequentially('a rare and reasonable note');
    await expect(note).toHaveValue('a rare and reasonable note');
    // Still asking: both buttons are there, and the node is still waiting.
    await expect(approval.getByRole('button', { name: /^Approve/ })).toBeVisible();
    await expect(approval.getByRole('button', { name: /^Reject/ })).toBeVisible();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'WAITING');
  });

  test('FR-GRD-013: the badge lists the pending card and decides it from the top bar', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    const badge = page.getByTestId('approvals-badge');
    await expect(badge).toHaveAttribute('data-count', '1', { timeout: 15_000 });
    await expect(badge).toHaveAttribute('aria-label', '1 approval waiting');

    await badge.click();
    const list = page.getByTestId('approvals-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText(NODE_NAMES.first);
    await list.getByRole('button', { name: /^Approve/ }).click();

    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  });

  test('FR-GRD-013: the run page shows the pending approval and the decision reaches the engine', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(approvalOn(page, writer)).toBeVisible({ timeout: 15_000 });
    const run = (await engineRun(page, seeded.workflowId))!;

    await page.goto(`/runs/${run.id}`);
    const section = page.getByTestId('run-detail-approvals');
    await expect(section).toBeVisible();
    await expect(section).toContainText(NODE_NAMES.first);
    await section.getByRole('button', { name: /^Approve/ }).click();

    /*
     * A decision taken away from the Canvas reaches the engine just the same: the node leaves WAITING
     * and the decision is on its record (FR-GRD-013, BR-01). The run does not go on to finish here,
     * because this page was loaded fresh and the mock engine's scripted playback is in-memory — a
     * reload loses the queue the approval would have resumed.
     */
    await expect
      .poll(
        async () =>
          (await engineNodeRuns(page, run.id)).filter((nodeRun) => nodeRun.nodeId === writer).at(-1)
            ?.status,
        { timeout: 15_000 },
      )
      .toBe('RUNNING');
  });

  /*
   * The run page has no socket of its own — `useApprovals` is keyed on the live overlay's `revision`,
   * which only moves on the Canvas — so what takes an answered card away here is the decision
   * invalidating the approvals query (`useApprovalDecision` in `apps/web/src/runs/hooks.ts`). This
   * test is why that invalidation exists: without it the card stayed and a second Approve earned a
   * 409 `invalid_run_state`.
   */
  test('FR-GRD-013: an answered approval leaves the run page', async ({ page }) => {
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(approvalOn(page, writer)).toBeVisible({ timeout: 15_000 });
    const run = (await engineRun(page, seeded.workflowId))!;

    await page.goto(`/runs/${run.id}`);
    const section = page.getByTestId('run-detail-approvals');
    await expect(section).toBeVisible();
    await section.getByRole('button', { name: /^Approve/ }).click();
    await expect(section).toHaveCount(0, { timeout: 10_000 });
  });

  test('TC-MOB-002: at 380 px the card is whole, usable, and Approve continues the node', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 760 });
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    const approval = approvalOn(page, writer);
    await expect(approval).toBeVisible({ timeout: 15_000 });

    /*
     * FR-MOB-002 asks for a card that is *usable* at 380 px — the fully responsive layouts are round
     * 5 — so what is checked is the card: it fits the screen, it is not taller than the screen, and
     * both buttons can actually be pressed.
     */
    const box = (await approval.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(380);
    expect(box.height).toBeLessThanOrEqual(760);

    // Both decisions are reachable, and the screen-reader label says whose decision it is.
    await expect(approval).toHaveAttribute('aria-label', `Approval needed for ${NODE_NAMES.first}`);
    const approveButton = approval.getByRole('button', { name: /^Approve/ });
    await expect(approveButton).toBeVisible();
    await expect(approval.getByRole('button', { name: /^Reject/ })).toBeVisible();

    await approveButton.click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
  });

  test('TC-MOB-002: at 380 px the keyboard path works too', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 760 });
    const seeded = await openRound3(page, 'chain', 'waiting-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(approvalOn(page, writer)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('a');
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
  });
});
