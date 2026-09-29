import { expect, test, type Page } from '@playwright/test';

import { freshApp, serverGraph } from './helpers';

// Type-only: brings `window.__aceMock` into scope.
import type {} from '../src/mocks/browser';

type Scenario = Parameters<NonNullable<Window['__aceMock']>['setScenario']>[0];

interface Runnable {
  projectId: string;
  workflowId: string;
  inputId: string;
  agentId: string;
  outputId: string;
}

/** Seed Input → Agent → Output on the mock provider, pick a scenario and open the Canvas. */
async function openRunnable(page: Page, scenario: Scenario): Promise<Runnable> {
  await freshApp(page);
  const seeded = await page.evaluate(() => window.__aceMock!.seedRunnable({}));
  await page.evaluate((name) => window.__aceMock!.setScenario(name), scenario);
  await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return seeded;
}

const start = (page: Page) =>
  page.getByTestId('run-bar').getByRole('button', { name: 'Start', exact: true });

const openTimeline = (page: Page) => page.getByRole('tab', { name: 'Timeline' }).click();

const timeline = (page: Page) => page.getByTestId('timeline');
const bubbles = (page: Page) => timeline(page).getByTestId('message-bubble');

test.describe('Round 4 Timeline (FR-CHAT-001/002/003)', () => {
  test('TC-CHAT-001: the six message styles are visible after a run with an error', async ({
    page,
  }) => {
    await openRunnable(page, 'timeline-six-types');
    await start(page).click();
    await openTimeline(page);

    // One bubble per style; the timeline-six-types scenario emits exactly the six of FR-CHAT-001.
    await expect(bubbles(page)).toHaveCount(6, { timeout: 15_000 });
    const types = await bubbles(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-type')).sort(),
    );
    expect(types).toEqual(['agent', 'error', 'event', 'output', 'system', 'user']);
  });

  test('TC-CHAT-002: filtering by node and type shows only matching messages', async ({ page }) => {
    await openRunnable(page, 'timeline-six-types');
    await start(page).click();
    await openTimeline(page);
    await expect(bubbles(page)).toHaveCount(6, { timeout: 15_000 });

    // The agent produced both an `agent` message and an `error` message; the user/event/system rows
    // name no node. Filter to the Agent node → those two remain.
    await page.getByLabel('Filter by node').click();
    await page.getByRole('option', { name: 'Agent', exact: true }).click();
    await expect(bubbles(page)).toHaveCount(2);

    // Add the error type → only the error row is left (the two filters intersect, FR-CHAT-002).
    await page.getByLabel('Filter by type').click();
    await page.getByRole('option', { name: 'error', exact: true }).click();
    await expect(bubbles(page)).toHaveCount(1);
    await expect(bubbles(page).first()).toHaveAttribute('data-type', 'error');
  });

  test('TC-CHAT-003: "Send to workflow" sets the Input node text and starts a run', async ({
    page,
  }) => {
    const seeded = await openRunnable(page, 'linear-complete');
    await openTimeline(page);

    await timeline(page).getByLabel('Message to send to the workflow').fill('hello');
    await timeline(page).getByTestId('timeline-send').click();

    // FR-CHAT-003: the posted message is set as the Input node's pending text.
    await expect
      .poll(async () => {
        const graph = await serverGraph(page, seeded.workflowId);
        const input = graph.nodes.find((node) => node.id === seeded.inputId);
        return (input?.config as { text?: string } | undefined)?.text;
      })
      .toBe('hello');

    // The message rides the timeline.
    await expect(timeline(page).getByText('hello')).toBeVisible();

    // FR-CHAT-003: a run starts with it (run: true) — the engine now has a run for this workflow.
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const db = window.__aceMock!.db;
            db.load();
            return db.listRuns(id).length;
          }, seeded.workflowId),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });

  test('FR-CHAT-002: the full page keeps its filter in the URL', async ({ page }) => {
    const seeded = await openRunnable(page, 'timeline-six-types');
    await start(page).click();
    // Let the run's messages persist before leaving the Canvas.
    await openTimeline(page);
    await expect(bubbles(page)).toHaveCount(6, { timeout: 15_000 });

    await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}/timeline`);
    await expect(page.getByTestId('timeline-page')).toBeVisible();
    await expect(bubbles(page)).toHaveCount(6, { timeout: 15_000 });

    await page.getByLabel('Filter by type').click();
    await page.getByRole('option', { name: 'error', exact: true }).click();

    await expect(page).toHaveURL(/type=error/);
    await expect(bubbles(page)).toHaveCount(1);

    // The filter is linkable: a reload from the URL restores it.
    await page.reload();
    await expect(bubbles(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(bubbles(page).first()).toHaveAttribute('data-type', 'error');
  });
});
