import { test } from '@playwright/test';

import {
  NOT_BUILT,
  api,
  expect,
  mockProvider,
  newestThread,
  openCanvas,
  openChat,
  seedAgents,
  sendChat,
} from './helpers.js';

/**
 * PG-2.2 Chat obeys budgets and tool guardrails (product-gaps prompt, Phase 2). Today a chat turn
 * has no run and no cost cap (`chat/service.ts`), and its meta line shows tokens only. The mock
 * provider is priced (`MOCK_PRICING`), so a turn has a real cost to show. Red until PG-2.2 lands.
 */

test.describe('PG-2.2 chat obeys budgets', () => {
  test("the chat shows a turn's cost", async ({ page }) => {
    test.fail(NOT_BUILT, 'PG-2.2: a chat turn shows tokens, never its cost');
    const providerId = await mockProvider();
    const flow = await seedAgents('chat-cost', [
      { name: 'Writer', providerId, modelId: 'mock-chat' },
    ]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    const panel = await openChat(page, flow.byName('Writer').id);
    await sendChat(panel, 'How much does this cost?');
    await newestThread(flow.byName('Writer').id, (m) => m.some((x) => x.role === 'agent'));

    const agent = panel.getByTestId('chat-turn-agent').first();
    await expect(agent.getByTestId('chat-usage')).toBeVisible({ timeout: 15_000 });
    await expect(agent).toContainText(/\$\s?\d/u);
  });

  test("a chat turn over the project's cost cap is refused with the budget reason", async ({
    page,
  }) => {
    test.fail(NOT_BUILT, 'PG-2.2: chat ignores maxCostPerRunUsd and replies anyway');
    const providerId = await mockProvider();
    const flow = await seedAgents('chat-budget', [
      { name: 'Writer', providerId, modelId: 'mock-chat' },
    ]);
    // The smallest cap there is: any priced turn is over it.
    await api(`/projects/${flow.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ maxCostPerRunUsd: 0.000_000_1 }),
    });
    await openCanvas(page, flow.projectId, flow.workflowId);
    const panel = await openChat(page, flow.byName('Writer').id);
    await sendChat(panel, 'Answer me even though the budget is gone');
    await newestThread(flow.byName('Writer').id, (m) => m.some((x) => x.role === 'agent'));

    const conversation = panel.getByTestId('chat-conversation');
    await expect(conversation.getByTestId('chat-error-turn')).toBeVisible();
    await expect(conversation).toContainText(/budget/i);
  });
});
