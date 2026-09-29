import { expect, test, type Page } from '@playwright/test';

import { nodeCard } from './helpers';
import { inspect, openRound3, runStatus, startRun } from './round3';

/**
 * The inspector's "Tool calls" tab, "View prompt" untrusted highlighting, and the approval card's
 * destructive-tool preview (round 4 §5 items 7–8; FR-TOOL-009, FR-TOOL-010, FR-PRM-002, FR-GRD-006;
 * TC-TOOL-010, TC-PRM-002).
 *
 * Driven against the MSW `tool-loop` and `destructive-approval` scenarios. The approval-preview test
 * needs nothing beyond the wired-in Canvas approval card; the two inspector tests assume the
 * "Tool calls" tab / section and the highlighting `PromptText` are wired into `Inspector.tsx` as the
 * M4 area-G report describes (the components and their component tests ship green regardless).
 */

/** The approval card anchored to its node on the Canvas (as in approvals.spec.ts). */
const approvalOn = (page: Page, nodeId: string) =>
  page.getByTestId(`node-approval-${nodeId}`).locator('[data-testid^="approval-card-"]');

/** Open the inspector's Tool calls region, clicking the tab first if the wiring uses one. */
async function openToolCalls(page: Page, nodeId: string) {
  const inspector = await inspect(page, nodeId);
  const tab = page.getByRole('tab', { name: 'Tool calls' });
  if (await tab.count()) await tab.click();
  const region = inspector.getByTestId('inspector-tool-calls');
  await expect(region).toBeVisible({ timeout: 15_000 });
  return region;
}

test.describe('Tool calls & untrusted prompt (TC-TOOL-010, TC-PRM-002)', () => {
  test('TC-TOOL-010: the inspector lists each tool call with name, args, result, duration and verdicts', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'tool-loop', { text: 'echo this' });
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });

    const region = await openToolCalls(page, writer);
    const rows = region.locator('[data-testid^="tool-call-"][data-status]');
    await expect(rows.first()).toBeVisible();

    const first = rows.first();
    await expect(first.locator('[data-testid^="tool-call-name-"]')).toHaveText('echo');
    await expect(first.locator('[data-testid^="tool-call-args-"]')).toContainText('echo this');
    await expect(first.locator('[data-testid^="tool-call-result-"]')).toContainText('echo');
    await expect(first.locator('[data-testid^="tool-call-duration-"]')).toContainText('ms');
    await expect(first.locator('[data-testid^="tool-call-status-"]')).toHaveAttribute(
      'data-status',
      'ok',
    );
    // The tool-point verdict rode along with the call (FR-TOOL-009).
    await expect(first.locator('[data-testid^="tool-call-verdicts-"]')).toContainText(
      'tool_allowed',
    );
  });

  test('TC-TOOL-010: a destructive call waits, the card previews the tool and path, and the decision is linked', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'destructive-approval');
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();

    // The card is anchored to the waiting node and names the destructive tool and its path.
    const card = approvalOn(page, writer);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const preview = page.getByTestId(`node-approval-${writer}`).getByTestId('approval-tool-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('approval-tool-name')).toHaveText('sandbox_delete');
    await expect(preview.getByTestId('approval-tool-args')).toContainText('notes.txt');

    await card.getByRole('button', { name: /^Approve/ }).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE');

    // The call is on the record, and the approval it waited for is linked to it.
    const region = await openToolCalls(page, writer);
    const destructive = region
      .locator('[data-testid^="tool-call-"][data-status]')
      .filter({ hasText: 'sandbox_delete' });
    await expect(destructive).toBeVisible();
    await expect(destructive.locator('[data-testid^="tool-call-approval-"]')).toHaveAttribute(
      'data-decision',
      'approve',
    );
  });

  test('TC-PRM-002: View prompt after a tool run highlights the untrusted block with its label', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'tool-loop', { text: 'echo this' });
    const [writer] = seeded.agentIds as [string];

    await startRun(page).click();
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'COMPLETED', {
      timeout: 20_000,
    });

    await inspect(page, writer);
    await page.getByRole('button', { name: 'View prompt' }).click();

    const prompt = page.getByTestId('prompt-text');
    await expect(prompt).toBeVisible();
    const block = prompt.getByTestId('untrusted-block').first();
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-untrusted', 'true');
    await expect(prompt.getByTestId('untrusted-label').first()).toContainText('UNTRUSTED');
  });
});
