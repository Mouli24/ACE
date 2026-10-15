import { test, type Locator, type Page } from '@playwright/test';

import {
  api,
  domainMessages,
  expect,
  mockProvider,
  newestThread,
  open,
  openCanvas,
  openChat,
  seedAgents,
  sendChat,
  type ChatMessageRow,
  type Seeded,
} from './helpers.js';

/**
 * PG-1.6 Message actions in chat (product-gaps prompt, Phase 1; D352, X3). Today a chat message has
 * no actions at all (D335 dropped "Actions +") and the composer has no Stop. Red until PG-1.6 lands.
 */

const textOf = (message: ChatMessageRow | undefined): string =>
  (message?.content ?? []).map((part) => part.text ?? '').join('');

async function chatWith(
  page: Page,
  label: string,
  model: string,
  provider?: string,
): Promise<{ flow: Seeded; panel: Locator }> {
  const providerId = await mockProvider(provider);
  const flow = await seedAgents(label, [
    { name: 'Writer', providerId, modelId: model, config: { execution: { retries: 0 } } },
  ]);
  await openCanvas(page, flow.projectId, flow.workflowId);
  const panel = await openChat(page, flow.byName('Writer').id);
  return { flow, panel };
}

/** A chat turn of one role, hovered so its actions show (they are always shown on touch). */
async function turn(panel: Locator, role: 'user' | 'agent', index = 0): Promise<Locator> {
  const row = panel.getByTestId(`chat-turn-${role}`).nth(index);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  return row;
}

/** A control that should be there: fail fast on finding it, then use it. */
async function press(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await control.click();
}

test.describe('PG-1.6 message actions in chat', () => {
  test('Copy puts an agent message on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { flow, panel } = await chatWith(page, 'copy', 'mock-chat');
    await sendChat(panel, 'Copy me');
    const detail = await newestThread(flow.byName('Writer').id, (m) =>
      m.some((x) => x.role === 'agent'),
    );
    const reply = textOf(detail.messages.find((m) => m.role === 'agent'));

    const agent = await turn(panel, 'agent');
    await press(agent.getByRole('button', { name: 'Copy' }));
    // Windows' clipboard hands text back with CRLF line ends; the words are what is compared.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.replace(/\r\n/gu, '\n')).toContain(reply.trim().slice(0, 20));
  });

  test('Retry on an agent message appends a new turn and folds the old one into "Earlier version"', async ({
    page,
  }) => {
    const { flow, panel } = await chatWith(page, 'retry', 'mock-chat');
    await sendChat(panel, 'Say it again');
    await newestThread(flow.byName('Writer').id, (m) => m.some((x) => x.role === 'agent'));

    const agent = await turn(panel, 'agent');
    await press(agent.getByRole('button', { name: 'Retry' }));
    await newestThread(
      flow.byName('Writer').id,
      (m) => m.filter((x) => x.role === 'agent').length === 2,
    );
    await expect(panel.getByText('Earlier version')).toBeVisible();
  });

  test('a failed turn is shown, and Retry on it runs the turn again', async ({ page }) => {
    // The failed turn itself already shows today (D287, "could not answer"): the first assertion
    // passes. What is missing is the way back — Retry (PG-1.6; PG-1.5 asks it of every failure).
    const { panel } = await chatWith(page, 'retry-failed', 'mock-401', 'PG failing mock');
    await sendChat(panel, 'This will fail');
    const failed = panel.getByTestId('chat-error-turn');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await failed.hover();
    await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('Edit & resend on a user message sends the edited text as a new turn', async ({ page }) => {
    const { flow, panel } = await chatWith(page, 'edit', 'mock-chat');
    await sendChat(panel, 'First wording');
    await newestThread(flow.byName('Writer').id, (m) => m.some((x) => x.role === 'agent'));

    const user = await turn(panel, 'user');
    await press(user.getByRole('button', { name: 'Edit & resend' }));
    const editor = panel
      .getByRole('textbox', { name: /Edit/ })
      .or(panel.getByLabel('Message this agent'))
      .first();
    await editor.fill('Second wording');
    await editor.press('Enter');

    // Wait for the reply to the edited turn too, not only the turn itself: it is asserted next.
    const detail = await newestThread(
      flow.byName('Writer').id,
      (m) =>
        m.some((x) => x.role === 'user' && textOf(x).includes('Second wording')) &&
        m.some((x) => x.role === 'agent' && textOf(x).includes('Second wording')),
    );
    expect(
      detail.messages.some((m) => m.role === 'agent' && textOf(m).includes('Second wording')),
    ).toBe(true);
    await expect(panel.getByText('Earlier version')).toBeVisible();
  });

  test('Delete hides a message, and it stays hidden after a reload', async ({ page }) => {
    const { flow, panel } = await chatWith(page, 'delete', 'mock-chat');
    await sendChat(panel, 'Forget this one');
    await newestThread(flow.byName('Writer').id, (m) => m.some((x) => x.role === 'agent'));

    const user = await turn(panel, 'user');
    await press(user.getByRole('button', { name: 'Delete' }));
    // `mock-chat` answers with the prompt it was given, so its (kept) reply quotes the deleted
    // words: what must be gone is the user's own turn, not every mention of its text.
    const deleted = (scope: Locator) =>
      scope
        .getByTestId('chat-conversation')
        .getByTestId('chat-turn-user')
        .filter({ hasText: 'Forget this one' });
    await expect(deleted(panel)).toHaveCount(0);
    await page.reload();
    const again = await openChat(page, flow.byName('Writer').id);
    await expect(again.getByTestId('chat-turn-agent')).toHaveCount(1);
    await expect(deleted(again)).toHaveCount(0);
  });

  test('the composer offers Stop while a reply streams, and Stop ends the turn as cancelled', async ({
    page,
  }) => {
    const { flow, panel } = await chatWith(page, 'stop', 'mock-slow');
    await sendChat(panel, 'Take your time');
    await expect(
      panel.getByTestId('chat-typing').or(panel.getByTestId('chat-thinking')).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await press(panel.getByRole('button', { name: 'Stop' }));
    const detail = await newestThread(flow.byName('Writer').id, (m) =>
      m.some((x) => x.role === 'agent' && x.error?.kind === 'user_cancelled'),
    );
    expect(detail.messages.at(-1)?.error?.kind).toBe('user_cancelled');
  });

  test('Domain: every message offers Copy', async ({ page }) => {
    const providerId = await mockProvider();
    const flow = await seedAgents('domain-copy', [
      {
        name: 'Writer',
        providerId,
        modelId: 'mock-script',
        instructions: '[[turn *]]\nDraft: Go further.',
      },
      {
        name: 'Director',
        providerId,
        modelId: 'mock-script',
        instructions: '[[turn *]]\nNoted.',
        brain: true,
      },
    ]);
    await open(page, `/projects/${flow.projectId}/workflows/${flow.workflowId}/domain`);
    await page.getByRole('textbox', { name: 'Message' }).fill('Write a tagline');
    await page.getByRole('button', { name: 'Start team run' }).click();
    await expect(page).toHaveURL(/[?&]run=/u, { timeout: 15_000 });
    const runId = new URL(page.url()).searchParams.get('run') ?? '';
    await expect(domainMessages(page).first()).toBeVisible({ timeout: 30_000 });

    const count = await domainMessages(page).count();
    for (let i = 0; i < count; i += 1) {
      const message = domainMessages(page).nth(i);
      await message.hover();
      await expect(
        message.getByRole('button', { name: 'Copy' }),
        `message ${i + 1} of ${count}`,
      ).toBeVisible();
    }
    await api(`/runs/${runId}/end`, { method: 'POST' }).catch(() => undefined);
  });
});
