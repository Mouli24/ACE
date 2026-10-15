import type { Run } from '@ace/contracts';
import { test, type Page } from '@playwright/test';

import {
  api,
  domain,
  engine,
  expect,
  mockProvider,
  open,
  openCanvas,
  openChat,
  seedAgents,
  sendChat,
  type Seeded,
} from './helpers.js';

/**
 * PG-1.5 A failed message always shows (product-gaps prompt, Phase 1). Red until PG-1.5 lands.
 *
 * A model that fails in Ideate chat is already a stored failed turn ("could not answer", D287), so
 * that is not this item's symptom (Retry on it is PG-1.6's). What a user can still hit: a turn whose
 * answer never arrives shows "typing…" forever; Domain does not say why a node failed; a failed post
 * loses its text; a post to a run that has ended does not say so.
 */

/** A team for Domain: Writer on `model`, Director the Brain (D304) on `mock-script`. */
async function team(
  label: string,
  model: string,
  outputTypes: string[] = ['text'],
): Promise<Seeded> {
  const providerId = await mockProvider();
  return seedAgents(label, [
    {
      name: 'Writer',
      providerId,
      modelId: model,
      outputTypes,
      config: { execution: { retries: 0 } },
    },
    {
      name: 'Director',
      providerId,
      modelId: 'mock-script',
      instructions: '[[turn *]]\nNoted.',
      brain: true,
    },
  ]);
}

const domainPath = (flow: Seeded, run?: string) =>
  `/projects/${flow.projectId}/workflows/${flow.workflowId}/domain${run === undefined ? '' : `?run=${run}`}`;

/** Drop every chat.token / chat.message frame the engine sends this page: an answer that never comes. */
async function swallowChatFrames(page: Page): Promise<void> {
  const port = new URL(engine().url).port;
  await page.routeWebSocket(new RegExp(`:${port}/ws(\\?|$)`, 'u'), (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string' && /"type":"chat\.(token|message)"/u.test(message)) return;
      ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });
}

test.describe('PG-1.5 a failed message always shows', () => {
  test('Ideate chat: a turn with no answer shows "No answer — Retry" after the node timeout + 10 s', async ({
    page,
  }) => {
    // PG-1.5 client stall rule: today the conversation says "typing…" for as long as nothing comes.
    test.setTimeout(90_000);
    const providerId = await mockProvider();
    const flow = await seedAgents('stall', [
      {
        name: 'Writer',
        providerId,
        modelId: 'mock-chat',
        config: { execution: { timeoutMs: 1_000 } },
      },
    ]);
    await swallowChatFrames(page);
    await openCanvas(page, flow.projectId, flow.workflowId);
    const panel = await openChat(page, flow.byName('Writer').id);
    await sendChat(panel, 'Are you there?');

    // 1 s timeout + 10 s, and a little slack.
    const stalled = panel.getByTestId('chat-conversation').getByText(/No answer/);
    await expect(stalled).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('Domain: a failed node turn says why in words, with Retry', async ({ page }) => {
    // PG-1.5: Domain never reads `failureReason` (`domain/looks.ts`).
    test.setTimeout(90_000);
    const flow = await team('domain-fail', 'mock-bad-json', ['json']);
    await open(page, domainPath(flow));
    await page.getByRole('textbox', { name: 'Message' }).fill('@writer Write a tagline');
    await page.getByRole('button', { name: 'Start team run' }).click();
    await expect(page).toHaveURL(/[?&]run=/u, { timeout: 15_000 });
    const runId = new URL(page.url()).searchParams.get('run') ?? '';
    await expect
      .poll(
        async () =>
          (await api<Array<{ nodeId: string; status: string }>>(`/runs/${runId}/node-runs`)).some(
            (nodeRun) => nodeRun.nodeId === flow.byName('Writer').id && nodeRun.status === 'FAILED',
          ),
        {
          timeout: 30_000,
          message: 'the Writer fails CONTRACT_VIOLATION',
        },
      )
      .toBe(true);

    await expect(
      domain(page)
        .getByText(/contract violation/i)
        .first(),
    ).toBeVisible();
    await expect(domain(page).getByRole('button', { name: 'Retry' }).first()).toBeVisible();
  });

  test('Domain: a failed post keeps its text in the composer with a Resend button', async ({
    page,
  }) => {
    // PG-1.5: a post that fails on the wire offers no Resend.
    const flow = await team('domain-post', 'mock-text');
    await open(page, domainPath(flow));
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeVisible({ timeout: 30_000 });
    // The network drops every POST from here on: the post fails before the engine sees it.
    await page.route('**/api/v1/**', (route) =>
      route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
    );
    await box.fill('Write a tagline for ACE');
    await page.getByRole('button', { name: 'Start team run' }).click();

    await expect(page.getByRole('button', { name: 'Resend' })).toBeVisible();
    await expect(box).toHaveValue('Write a tagline for ACE');
  });

  test('Domain: a post to a run that has ended says so and offers to start a new run with it', async ({
    page,
  }) => {
    // PG-1.5: a run that has ended says so, and a message offers itself as a new run's goal.
    const flow = await team('domain-ended', 'mock-text');
    const run = await api<Run>(`/workflows/${flow.workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'A tagline', domain: { stayOpen: true } }),
    });
    await open(page, domainPath(flow, run.id));
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

    // The run ends behind the page's back (another tab, the API). Since PG-3.3 Domain hears the
    // end at once, so the page says so before anything is sent, and a message starts a new run
    // with itself as the goal (D312) instead of meeting a 409. The 409 path itself (a post racing
    // the end) is the composer's, covered at component level (tests-todo, PG-1.5).
    await api(`/runs/${run.id}/end`, { method: 'POST' });
    await expect(domain(page).getByText(/run has ended/i).first()).toBeVisible({ timeout: 30_000 });
    await box.fill('One more idea');
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/workflows/${flow.workflowId}/runs`),
    );
    await page.getByRole('button', { name: 'Start team run' }).click();
    const response = await started;
    expect(response.status(), 'a new run starts').toBe(201);
    const body = response.request().postDataJSON() as { goal?: string };
    expect(body.goal, 'with the message as its goal').toBe('One more idea');
    expect(((await response.json()) as Run).id).not.toBe(run.id);
  });
});
