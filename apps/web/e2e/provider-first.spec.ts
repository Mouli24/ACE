import { expect, test } from '@playwright/test';

import { freshApp, openWorkflow, seedGraph, serverGraph } from './helpers';

/**
 * PG-1.3 (D351) no node without a provider, and PG-1.4 (D359) local and open models get their own
 * section — against the MSW mock engine, whose `GET /providers/detect` reports an Ollama on its
 * default address and whose Ollama catalogue carries the tag's size.
 */

test.describe('PG-1.3 / PG-1.4 provider first, local models in their own section', () => {
  test('PG-1.4 a detected Ollama is added from the Add node picker and appears under Local & open models with its models', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['input']);
    await openWorkflow(page, seeded);

    await page.getByTestId('new-node-button').click();
    const picker = page.getByTestId('provider-picker');
    await expect(picker).toBeVisible();
    // no provider connected: the way to the Providers page, and the detected Ollama (FR-PRV-007)
    await expect(picker.getByRole('link', { name: /Connect a provider/ })).toBeVisible();
    await picker.getByRole('button', { name: 'Add Ollama' }).click();

    const local = picker.getByRole('group', { name: 'Local & open models' });
    await expect(local.getByRole('option', { name: /Ollama/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const model = picker.getByRole('option', { name: /Llama mock/ });
    await expect(model).toContainText('1.2 GB');
    await expect(model).toContainText('Free · runs on your machine');

    // PG-1.3: Cancel creates nothing
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(picker).toHaveCount(0);
    expect((await serverGraph(page, seeded.workflowId)).nodes).toHaveLength(1);

    // the Providers page: the same Ollama, in its own section, with what it has on this machine
    await page.goto('/providers');
    const section = page.getByRole('region', { name: 'Local & open models' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('llama-mock');
    await expect(section).toContainText('1.2 GB');
    await expect(section).toContainText('Free · runs on your machine');
  });

  test('PG-1.3 Add node sends nothing until a provider and a model are chosen, then makes the node on them', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['input', 'agent'], { withModel: true });
    await openWorkflow(page, seeded);

    await page.getByTestId('new-node-button').click();
    const picker = page.getByTestId('provider-picker');
    await expect(picker).toBeVisible();
    const add = picker.getByRole('button', { name: 'Add node' });
    await expect(add).toBeDisabled();
    await picker.getByRole('group', { name: 'Test providers' }).getByRole('option').first().click();
    await expect(add).toBeDisabled();
    expect((await serverGraph(page, seeded.workflowId)).nodes).toHaveLength(2);

    await picker.getByRole('option', { name: /Mock JSON/ }).click();
    await add.click();
    await expect
      .poll(async () => (await serverGraph(page, seeded.workflowId)).nodes.length)
      .toBe(3);
    const added = (await serverGraph(page, seeded.workflowId)).nodes.find(
      (node) => !seeded.nodeIds.includes(node.id),
    )!;
    const config = added.config as { providerId?: string; modelId?: string };
    expect(config.modelId).toBe('mock-json');
    expect(config.providerId).toBeTruthy();
  });

  test('PG-1.3 a pasted or imported agent whose provider is missing is a red "Choose a provider" card', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['agent']);
    await openWorkflow(page, seeded);
    const card = page.getByTestId(`node-card-${seeded.nodeIds[0]!}`);
    await expect(card).toHaveAttribute('data-needs-provider', 'true');
    await card.getByRole('button', { name: /Choose a provider/ }).click();

    const picker = page.getByTestId('provider-picker');
    await picker.getByRole('button', { name: 'Add Ollama' }).click();
    await picker.getByRole('option', { name: /Llama mock/ }).click();
    await picker.getByRole('button', { name: 'Use this model' }).click();
    await expect(card).not.toHaveAttribute('data-needs-provider', 'true');
    await expect
      .poll(async () => {
        const [node] = (await serverGraph(page, seeded.workflowId)).nodes;
        return (node?.config as { modelId?: string }).modelId;
      })
      .toBe('llama-mock');
  });
});
