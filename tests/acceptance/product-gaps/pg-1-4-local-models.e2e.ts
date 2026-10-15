import { createServer, type Server } from 'node:http';

import type { Provider } from '@ace/contracts';
import { test } from '@playwright/test';

import {
  NOT_BUILT,
  api,
  card,
  expect,
  mockProvider,
  open,
  openCanvas,
  seedAgents,
  settingsDialog,
} from './helpers.js';

/**
 * PG-1.4 Local and open models get their own section (product-gaps prompt, Phase 1). Today every
 * provider picker is one flat list. Red until PG-1.4 lands.
 *
 * The prompt asks for the detected Ollama to come from MSW; this suite drives the real engine, so a
 * small loopback server plays Ollama instead — `/v1/models` (what the engine's adapter lists) and
 * `/api/tags` (the native list with sizes, for the "found on this machine" view).
 */

const MODEL = 'llama3.2:1b';
let ollama: Server;
let ollamaUrl = '';

test.beforeAll(async () => {
  ollama = createServer((request, response) => {
    const json = (body: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url?.startsWith('/v1/models')) {
      return json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'library' }] });
    }
    if (request.url?.startsWith('/api/tags')) {
      return json({
        models: [{ name: MODEL, model: MODEL, size: 1_321_098_329, details: { family: 'llama' } }],
      });
    }
    if (request.url?.startsWith('/api/version')) return json({ version: '0.5.0' });
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
});

async function ollamaProvider(): Promise<string> {
  const name = `PG Ollama ${ollamaUrl.split(':').at(-1) ?? ''}`;
  const { items } = await api<{ items: Provider[] }>('/providers?limit=500');
  const known = items.find((provider) => provider.name === name);
  if (known !== undefined) return known.id;
  const created = await api<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify({ type: 'ollama', name, baseUrl: ollamaUrl }),
  });
  await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
  return created.id;
}

test.describe('PG-1.4 local and open models get their own section', () => {
  test('the Providers page lists a detected Ollama under "Local & open models" with its models', async ({
    page,
  }) => {
    // PG-1.4: the Providers page has no grouping today.
    test.fail(NOT_BUILT, 'PG-1.4: no "Local & open models" section on the Providers page');
    await mockProvider();
    await ollamaProvider();
    await open(page, '/providers');
    await expect(
      page
        .getByRole('heading', { name: 'Add provider' })
        .or(page.getByRole('button', { name: 'Add provider' }))
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    const local = page.getByRole('region', { name: 'Local & open models' });
    await expect(local).toBeVisible();
    await expect(local).toContainText(MODEL);
    await expect(local).toContainText('Free · runs on your machine');
    // The mock is not local: it stays out of the section.
    await expect(local).not.toContainText('PG mock');
  });

  test('the node provider picker groups Ollama under "Local & open models"', async ({ page }) => {
    // PG-1.4: the node settings Provider select is one flat list.
    test.fail(NOT_BUILT, 'PG-1.4: the Provider select is not grouped');
    const providerId = await mockProvider();
    const ollamaId = await ollamaProvider();
    const flow = await seedAgents('local-picker', [
      { name: 'Writer', providerId, modelId: 'mock-text' },
    ]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    const writer = card(page, flow.byName('Writer').id);
    await expect(writer).toBeVisible({ timeout: 15_000 });
    await writer.click({ position: { x: 40, y: 8 } });
    await expect(settingsDialog(page)).toBeVisible();

    await settingsDialog(page).getByRole('combobox', { name: 'Provider' }).click();
    const group = page.getByRole('group', { name: 'Local & open models' });
    await expect(group).toBeVisible();
    const { items } = await api<{ items: Provider[] }>('/providers?limit=500');
    const ollamaName = items.find((each) => each.id === ollamaId)?.name ?? '';
    await expect(group.getByRole('option', { name: new RegExp(ollamaName) })).toBeVisible();
    await expect(
      page
        .getByRole('group', { name: 'Cloud APIs' })
        .or(page.getByRole('group', { name: 'Custom endpoints' }))
        .first(),
    ).toBeAttached();
  });
});
