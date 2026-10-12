import { expect, test, type Page } from '@playwright/test';

import { freshApp, nodeCard, openSheet } from './helpers';
import { clickStartRun, expectRunStatus, inspect, openWorkspaceMenu } from './round3';

// Type-only: brings `window.__aceMock` into scope.
import type {} from '../src/mocks/browser';

type Scenario = Parameters<NonNullable<Window['__aceMock']>['setScenario']>[0];

interface Runnable {
  projectId: string;
  workflowId: string;
  providerId: string;
  inputId: string;
  agentId: string;
  outputId: string;
  edgeIds: string[];
}

/** Seed Input → Agent → Output on the mock provider, pick a scenario and open the Canvas. */
async function openRunnable(
  page: Page,
  scenario: Scenario,
  options: { text?: string; modelId?: string; outputTypes?: string[] } = {},
): Promise<Runnable> {
  await freshApp(page);
  const seeded = await page.evaluate((opts) => window.__aceMock!.seedRunnable(opts), options);
  // The choice is stored, so it survives the navigation to the Canvas below.
  await page.evaluate((name) => window.__aceMock!.setScenario(name), scenario);
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return seeded;
}

test.describe('Round 2 live run (FR-EXE-001/008/009/015)', () => {
  test('TC-EXE-007 + TC-EXE-008: streamed text lands in the node’s chat, and the states are distinct', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'slow-stream');
    await clickStartRun(page);

    const card = nodeCard(page, seeded.agentId);
    // The status chip follows the node's own state machine (Arch §19.1).
    await expect(card).toHaveAttribute('data-state', 'RUNNING', { timeout: 10_000 });
    const ring = card.getByTestId('status-chip');
    await expect(ring).toHaveAttribute('data-state', 'RUNNING');
    await expect(ring).toHaveText('Running');

    // D285: the card says it is running and never prints the text; the text is read in the node's
    // chat, which streams it live. The note hangs under the card (D332).
    await expect(page.getByTestId(`running-note-${seeded.agentId}`)).toBeVisible();
    await expect(page.getByTestId(`stream-${seeded.agentId}`)).toHaveCount(0);
    await page.getByTestId(`chat-mention-${seeded.agentId}`).click();
    const streamed = page.getByTestId('chat-run-live');
    await expect(streamed).toBeVisible();
    const first = (await streamed.textContent()) ?? '';
    // TC-EXE-007: the text grows while the node is still running, not only at the end.
    await expect
      .poll(async () => ((await streamed.textContent()) ?? '').length, { timeout: 10_000 })
      .toBeGreaterThan(first.length);

    await expect(card).toHaveAttribute('data-state', 'COMPLETED', { timeout: 20_000 });
    await expect(ring).toHaveAttribute('data-state', 'COMPLETED');
    await expect(ring).toHaveText('Done');
    // …and once it settles, the run's result stays in the node's session
    await expect(page.getByTestId('chat-run-badge').first()).toBeVisible({ timeout: 10_000 });
  });

  test('TC-EXE-014: the edge animates when an envelope travels it', async ({ page }) => {
    const seeded = await openRunnable(page, 'linear-complete');
    const agentEdge = page.getByTestId(`edge-${seeded.edgeIds[1]}`);
    await expect(agentEdge).toHaveAttribute('data-transferred', 'false');

    await clickStartRun(page);

    await expect(agentEdge).toHaveAttribute('data-animating', 'true', { timeout: 15_000 });
    await expect(agentEdge.locator('title')).not.toHaveText('no data yet');

    // The drawn line's class has to name a real animation, and the highlight has to switch itself
    // off again (D-018: it did neither — the keyframes did not exist and nothing re-rendered the
    // edge). The theme's line always flows (D332), with its `flow` keyframes.
    const animation = await page
      .getByTestId(`edge-line-${seeded.edgeIds[1]}`)
      .locator('.ace-edge-flow')
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('flow');

    await expect(agentEdge).toHaveAttribute('data-animating', 'false', { timeout: 10_000 });
    await expect(agentEdge).toHaveAttribute('data-transferred', 'true');
  });

  test('TC-RTR-004 + D285: the card names the fallback model and the result is read in the chat', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'fallback-used');
    await clickStartRun(page);

    await expect(page.getByTestId(`used-model-${seeded.agentId}`)).toHaveText(
      /used: mock-text-fallback \(fallback\)/,
      { timeout: 15_000 },
    );
    await expectRunStatus(page, 'COMPLETE', { timeout: 15_000 });
    // the Output card points to where its result is and never prints it (D285)…
    await expect(page.getByTestId(`final-output-${seeded.outputId}`)).toHaveCount(0);
    // …and the agent's chat holds the run's goal and answer
    await page.getByTestId(`chat-mention-${seeded.agentId}`).click();
    await expect(page.getByTestId('chat-run-badge').first()).toBeVisible({ timeout: 10_000 });
    // The footer carries the run's tokens (D330); its cost is on the Run details page.
    await expect(page.getByTestId('footer-tokens')).toHaveText(
      /^[\d.]+[kM]? in \/ [\d.]+[kM]? out$/,
    );
    const menu = await openWorkspaceMenu(page);
    await menu.getByTestId('menu-run-details').click();
    await expect(page.getByTestId('run-detail-totals')).toContainText('$');
  });

  test('TC-NODE-009: the provider accent does not change while the state does', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'slow-stream');
    const card = nodeCard(page, seeded.agentId);
    // The Stage card's provider look (D332): its provider, its border and its orb.
    const accent = () =>
      card.evaluate((el) => {
        const orb = el.querySelector('[data-testid^="stage-orb-"]');
        const orbStyle = orb === null ? undefined : getComputedStyle(orb);
        return [
          el.getAttribute('data-provider'),
          getComputedStyle(el).borderTopColor,
          orbStyle?.backgroundImage,
          orbStyle?.backgroundColor,
          orbStyle?.boxShadow,
        ].join(' | ');
      });

    await expect(card).not.toHaveAttribute('data-provider', 'none');
    const before = await accent();

    await clickStartRun(page);
    await expect(card).toHaveAttribute('data-state', 'RUNNING', { timeout: 10_000 });
    expect(await accent()).toBe(before);

    await expect(card).toHaveAttribute('data-state', 'COMPLETED', { timeout: 20_000 });
    expect(await accent()).toBe(before);
  });

  test('FR-EXE-003: a blocked run shows its pre-flight issues and selects the node', async ({
    page,
  }) => {
    await openRunnable(page, 'preflight-blocked');
    await clickStartRun(page);

    const panel = page.getByTestId('preflight-issues');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText('provider_unreachable');

    await panel
      .getByRole('button', { name: /show node/i })
      .first()
      .click();
    await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  });

  test('TC-EXE-013: dropping the socket mid-run leaves the same overlay after the resume', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'slow-stream');
    await clickStartRun(page);

    const card = nodeCard(page, seeded.agentId);
    await expect(card).toHaveAttribute('data-state', 'RUNNING', { timeout: 10_000 });

    await page.evaluate(() => window.__aceMock!.dropSocket());
    await expect(page.getByTestId('socket-reconnecting')).toBeVisible();

    // The run finishes anyway: the SDK reconnects, resumes after its last seq and folds the rest.
    await expect(card).toHaveAttribute('data-state', 'COMPLETED', { timeout: 30_000 });
    await expectRunStatus(page, 'COMPLETE');
    await expect(page.getByTestId('socket-reconnecting')).toBeHidden();
  });

  test('TC-EXE-009 + TC-PRM-004/005: the inspector shows the run and the prompt as sent', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'linear-complete');
    await clickStartRun(page);
    await expectRunStatus(page, 'COMPLETE', { timeout: 15_000 });

    const inspector = await inspect(page, seeded.agentId);
    await expect(inspector.getByTestId('inspector-facts')).toContainText('mock-text');
    await expect(inspector.getByTestId('envelope-trust')).toBeVisible();
    await expect(inspector.getByTestId('prompt-version')).toContainText('version');

    await inspector.getByRole('button', { name: 'View prompt' }).click();
    const prompt = page.getByTestId('prompt-text');
    await expect(prompt).toContainText('UNTRUSTED');
    await expect(prompt).toContainText('summarise the report');
  });

  test('TC-EXE-011: the run history lists the run, newest first, and opens its page', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'linear-complete');
    await clickStartRun(page);
    await expectRunStatus(page, 'COMPLETE', { timeout: 15_000 });

    await openSheet(page, 'Runs');
    // the run history is a list of cards now, not table rows
    const rows = page.getByTestId('runs-table').locator('[data-testid^="run-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'COMPLETE');

    await rows.first().getByRole('link').click();
    await expect(page.getByTestId('run-detail-status')).toHaveAttribute('data-status', 'COMPLETE');
    await expect(page.getByTestId('run-detail-nodes').locator('li')).toHaveCount(3);

    // The project-level list finds the same run.
    await page.goto(`/projects/${seeded.projectId}/runs`);
    await expect(page.getByTestId('runs-table').first()).toBeVisible();
  });
});

test.describe('Round 2 providers UI in a real browser (FR-PRV-004)', () => {
  test('TC-PRV-005: a provider.status frame updates the Providers page with no reload', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'linear-complete');
    // On desktop the provider status lives on the Providers page (D330), reached from the
    // workspace menu without a reload.
    const menu = await openWorkspaceMenu(page);
    await menu.getByTestId('menu-providers').click();
    await expect(page).toHaveURL(/\/providers$/);
    const chip = page
      .getByTestId(`provider-row-${seeded.providerId}`)
      .getByTestId(`provider-status-${seeded.providerId}`);
    await expect(chip).toHaveAttribute('data-status', 'UNKNOWN');

    await page.evaluate(
      (id) => window.__aceMock!.setProviderStatus(id, 'CONNECTED', 'all good'),
      seeded.providerId,
    );

    await expect(chip).toHaveAttribute('data-status', 'CONNECTED');
  });

  test('TC-PRV-001..003: a provider can be added and tested from the screen', async ({ page }) => {
    await freshApp(page);
    await page.goto('/providers');

    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'Mock' }).click();
    await dialog.getByLabel('Name').fill('My mock');
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    const row = page.locator('[data-testid^="provider-row-"]').first();
    await expect(row).toContainText('My mock');
    await expect(row).toContainText('key set: no');

    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.locator('[data-testid^="provider-status-"]')).toHaveAttribute(
      'data-status',
      'CONNECTED',
    );

    // TC-MOD-003: the models tab lists the mock catalogue and filters it.
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.getByTestId('models-table')).toBeVisible();
    await page.getByLabel('Input type').click();
    await page.getByRole('option', { name: 'image' }).click();
    await expect(page.locator('[data-testid^="model-row-"]')).toHaveCount(1);
    await expect(page.getByTestId('model-row-mock-vision')).toBeVisible();
  });
});
