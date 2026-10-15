import type { Provider } from '@ace/contracts';
import { test, type Page } from '@playwright/test';

import { api, expect, open } from './helpers.js';

/**
 * PG-2.3 No silent Full auto (product-gaps prompt, Phase 2; X6, D342). Today the provider dialog
 * offers "Full auto" for a CLI provider (`providers/ProviderDialogs.tsx` PermissionField,
 * `providers/provider-meta.ts`), which bypasses every ACE approval, budget and guardrail.
 * Red until PG-2.3 lands. (The "no code path builds the bypass flags" test is Vitest, not here.)
 */

async function permissionOptions(page: Page): Promise<string[]> {
  await page.getByRole('combobox', { name: 'Permission' }).click();
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  return options.allTextContents();
}

test.describe('PG-2.3 no silent Full auto', () => {
  test('the Add provider dialog does not offer Full auto for a CLI provider', async ({ page }) => {
    await open(page, '/providers');
    await page.getByRole('button', { name: 'Add provider' }).click({ timeout: 30_000 });
    const dialog = page.getByRole('dialog', { name: 'Add provider' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Type' }).click();
    await page.getByRole('option', { name: 'Claude Code' }).click();

    const offered = await permissionOptions(page);
    expect(
      offered.some((label) => /edit (project )?files/i.test(label)),
      'Edit files is offered',
    ).toBe(true);
    expect(
      offered.filter((label) => /full auto/i.test(label)),
      'Full auto is not offered',
    ).toEqual([]);
  });

  test('a provider saved on Full auto is not offered it again when edited', async ({ page }) => {
    const name = `PG full auto ${Date.now().toString(36)}`;
    // A row from before X6: the contract still parses `full_auto` so old rows load.
    await api<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude_code', name, cliPermission: 'full_auto' }),
    });
    await open(page, '/providers');
    await page.getByRole('button', { name: `Actions for ${name}` }).click({ timeout: 30_000 });
    await page.getByRole('menuitem', { name: /Edit/ }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${name}` });
    await expect(dialog).toBeVisible();

    const offered = await permissionOptions(page);
    expect(
      offered.filter((label) => /full auto/i.test(label)),
      'Full auto is not offered',
    ).toEqual([]);
  });
});
