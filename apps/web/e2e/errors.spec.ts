import { expect, test, type Page } from '@playwright/test';

import { nodeCard } from './helpers';
import {
  NODE_NAMES,
  clickStartRun,
  engineNodeRuns,
  engineRun,
  expectRunStatus,
  openBottomTab,
  openRound3,
  stopRun,
} from './round3';

/**
 * Error cards, BLOCKED and STOPPED on the real Canvas (round 3 §5 item 3, §7.1): FR-ERR-002,
 * FR-ERR-006, FR-ERR-007 and NFR-USE-03.
 *
 * The same `ErrorCard` now appears twice — anchored to the failed node and in the Errors tab — so
 * every locator below says which of the two it means; a test that quietly matched either would stop
 * proving that both are there.
 *
 * The three endings a run can leave a node in are deliberately kept apart (BR-03): FAILED is a
 * failure, BLOCKED is a node the run never reached, STOPPED is a cancellation the operator asked for.
 */

/** The copy of a card that is anchored to its node on the Canvas. */
const onNode = (page: Page, nodeId: string) =>
  page.locator(`.react-flow__node[data-id="${nodeId}"]`).getByTestId(`error-card-${nodeId}`);

/** The copy of a card in the bottom pane's Errors tab. */
const inErrorsTab = (page: Page, nodeId: string) =>
  page.getByTestId('errors-tab').getByTestId(`error-card-${nodeId}`);

test.describe('Errors, BLOCKED and STOPPED (FR-ERR-002/006/007)', () => {
  test('TC-ERR-002: an auth failure names the node, kind, message, provider, state, Retry and what to do next', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'blocked-downstream');
    const [writer] = seeded.agentIds as [string];

    await clickStartRun(page);
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'FAILED', {
      timeout: 15_000,
    });

    // FR-ERR-002's facts, first where the failure happened: on the node.
    const anchored = onNode(page, writer);
    await expect(anchored).toBeVisible();
    await expect(anchored).toHaveAttribute('data-kind', 'auth');
    await expect(anchored).toHaveAttribute('data-state', 'FAILED');
    await expect(anchored).toContainText(NODE_NAMES.first);
    await expect(anchored).toContainText('The provider rejected the key.');
    await expect(anchored.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(anchored.getByTestId(`error-next-step-${writer}`)).toHaveText(
      'Update the provider key in Providers.',
    );

    // And again in the Errors tab, which is where every failure of the run is listed.
    await openBottomTab(page, 'Errors');
    const card = inErrorsTab(page, writer);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-kind', 'auth');
    await expect(card).toHaveAttribute('data-state', 'FAILED');
    await expect(card.getByTestId(`error-kind-${writer}`)).toHaveText('auth');
    await expect(card.getByTestId(`error-provider-${writer}`)).toContainText('Mock');
    await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
    // NFR-USE-03: what happened, then the one place to go and change it.
    await expect(card.getByTestId(`error-next-step-${writer}`)).toHaveText(
      'Update the provider key in Providers.',
    );
    // An auth failure is not retried by the engine (Arch §28), and the card says so.
    await expect(card).toContainText('not retried automatically');
  });

  test('TC-ERR-007: the node after a failure is BLOCKED — shown as Blocked and blamed on the right node — never FAILED', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'blocked-downstream');
    const [writer, editor] = seeded.agentIds as [string, string];

    await clickStartRun(page);
    await expect(nodeCard(page, editor)).toHaveAttribute('data-state', 'BLOCKED', {
      timeout: 15_000,
    });

    // The Stage card's status row says Blocked (D332: the lock and the grey filter left with the
    // old card), and the note under it names the node that failed.
    const status = nodeCard(page, editor).getByTestId('status-chip');
    await expect(status).toHaveAttribute('data-state', 'BLOCKED');
    await expect(status).toHaveText('Blocked');
    await expect(page.getByTestId(`blocked-by-${editor}`)).toHaveText(
      `blocked by ${NODE_NAMES.first}`,
    );
    // Never wearing the failure line a FAILED node wears — nor an error card.
    await expect(page.getByTestId(`failure-${editor}`)).toHaveCount(0);
    await expect(onNode(page, editor)).toHaveCount(0);

    // The engine agrees: BLOCKED with the `workflow` kind, not FAILED (BR-03).
    const run = (await engineRun(page, seeded.workflowId))!;
    const editorRuns = (await engineNodeRuns(page, run.id)).filter(
      (nodeRun) => nodeRun.nodeId === editor,
    );
    expect(editorRuns.map((nodeRun) => nodeRun.status)).toEqual(['BLOCKED']);
    expect(editorRuns[0]!.failureReason).toBe('BLOCKED');
    expect(editorRuns[0]!.errorKind).toBe('workflow');

    // The Errors tab keeps the two apart: one failure, one node that never ran.
    await openBottomTab(page, 'Errors');
    await expect(page.getByTestId('errors-tab-blocked')).toContainText(
      `blocked by ${NODE_NAMES.first}`,
    );
    const summary = page.getByTestId('errors-tab').getByTestId('run-summary');
    await expect(summary).toHaveAttribute('data-failed', '1');
    await expect(summary).toHaveAttribute('data-blocked', '1');
    await expect(inErrorsTab(page, editor)).toHaveCount(0);
    await expect(inErrorsTab(page, writer)).toBeVisible();
  });

  test('TC-ERR-008: a stopped node is not a failure in the summary and is never red', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'slow-stream');
    const [writer] = seeded.agentIds as [string];

    await clickStartRun(page);
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'RUNNING', {
      timeout: 10_000,
    });
    await stopRun(page);
    await expectRunStatus(page, 'HALTED', { timeout: 10_000 });
    await expect(nodeCard(page, writer)).toHaveAttribute('data-state', 'STOPPED');

    await openBottomTab(page, 'Errors');
    const summary = page.getByTestId('errors-tab').getByTestId('run-summary');
    // The one number that must never be wrong (FR-ERR-007).
    await expect(summary).toHaveAttribute('data-failed', '0');
    await expect(summary).toHaveAttribute('data-stopped', '1');
    await expect(summary.getByTestId('run-summary-failed')).toHaveText('0 failed');
    await expect(summary.getByTestId('run-summary-stopped')).toHaveText('1 stopped');
    await expect(page.getByTestId('errors-tab-no-failures')).toBeVisible();
    await expect(page.getByTestId('errors-tab-stopped')).toContainText('not a failure');
    // No error card anywhere: a stop is not something that went wrong.
    await expect(page.getByTestId(`error-card-${writer}`)).toHaveCount(0);

    // Never red: neither the node card nor the note carries the danger colour. The browser resolves
    // the token to `rgb(r, g, b)`; comparing its channels catches translucent tints too.
    const danger = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-danger)';
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return /rgba?\((\d+, \d+, \d+)/.exec(rgb)?.[1] ?? '';
    });
    expect(danger).toMatch(/^\d+, \d+, \d+$/);
    for (const locator of [nodeCard(page, writer), page.getByTestId(`stopped-note-${writer}`)]) {
      const colours = await locator.evaluate((el) =>
        [el, ...Array.from(el.querySelectorAll('*'))].map((node) => {
          const style = getComputedStyle(node);
          return [style.color, style.borderTopColor, style.backgroundColor].join(' ');
        }),
      );
      expect(colours.join(' ')).not.toContain(danger);
    }
    // The card's status row says Stopped (D332), and the Errors tab's note says what it means.
    const status = nodeCard(page, writer).getByTestId('status-chip');
    await expect(status).toHaveAttribute('data-state', 'STOPPED');
    await expect(status).toHaveText('Stopped');
    await expect(page.getByTestId(`stopped-note-${writer}`)).toContainText(
      'stopped — not a failure',
    );
  });

  test('TC-ERR-005 + FR-ERR-002: an automatically retried 429 shows each attempt and its next step', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'retry-429');
    const [writer] = seeded.agentIds as [string];

    await clickStartRun(page);
    await expectRunStatus(page, 'COMPLETE', { timeout: 30_000 });

    // Attempts 1 and 2 failed with the provider kind, attempt 3 completed (Arch §28).
    const run = (await engineRun(page, seeded.workflowId))!;
    const attempts = (await engineNodeRuns(page, run.id)).filter(
      (nodeRun) => nodeRun.nodeId === writer,
    );
    expect(attempts.map((nodeRun) => `${nodeRun.attempt}:${nodeRun.status}`)).toEqual([
      '1:FAILED',
      '2:FAILED',
      '3:COMPLETED',
    ]);
    expect(attempts[0]!.errorKind).toBe('provider');

    await openBottomTab(page, 'Errors');
    const summary = page.getByTestId('errors-tab').getByTestId('run-summary');
    await expect(summary).toHaveAttribute('data-failed', '2');
    const card = inErrorsTab(page, writer).first();
    await expect(card).toHaveAttribute('data-kind', 'provider');
    await expect(card).toContainText('attempt');
    await expect(card.getByTestId(`error-next-step-${writer}`)).toHaveText(
      'Retry, or add a fallback model on this node.',
    );
  });

  test('FR-ERR-002 + FR-OBS-002: the Events tab lists the run chronologically and filters by node', async ({
    page,
  }) => {
    const seeded = await openRound3(page, 'chain', 'linear-complete');
    await clickStartRun(page);
    await expectRunStatus(page, 'COMPLETE', { timeout: 20_000 });

    await openBottomTab(page, 'Events');
    const list = page.getByTestId('events-list');
    await expect(list).toBeVisible();
    const seqs = await list
      .locator('li')
      .evaluateAll((items) =>
        items.map((item) => Number(item.getAttribute('data-testid')?.replace('event-', ''))),
      );
    expect(seqs.length).toBeGreaterThan(3);
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
    await expect(list.locator('li[data-type="run.started"]')).toHaveCount(1);
    await expect(list.locator('li[data-type="run.completed"]')).toHaveCount(1);

    const all = seqs.length;
    await page.getByLabel('Filter by node').click();
    await page.getByRole('option', { name: NODE_NAMES.first }).click();
    await expect
      .poll(async () => page.getByTestId('events-list').locator('li').count())
      .toBeLessThan(all);
    const filtered = page.getByTestId('events-list').locator('li');
    expect(await filtered.count()).toBeGreaterThan(0);
    for (const nodeId of await filtered.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-node-id')),
    )) {
      expect(nodeId).toBe(seeded.agentIds[0]);
    }
  });
});
