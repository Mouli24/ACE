import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { freshApp } from './helpers';

/**
 * The settings screen (round 5 §5 item 9): FR-SYS-005, TC-SYS-006 and FR-SYS-012.
 *
 * The mock engine keeps its database in localStorage, so a reload is this suite's "engine restart":
 * whatever the screen shows after one came back from the engine, not from a draft in the page.
 */
const engineSettings = (page: Page) => page.evaluate(() => window.__aceMock!.db.settings);

const projectNames = (page: Page) =>
  page.evaluate(() =>
    window
      .__aceMock!.db.listProjects()
      .map((project) => project.name)
      .sort(),
  );

async function openSettings(page: Page) {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-concurrency')).toBeEnabled();
}

test.describe('Settings (FR-SYS-005)', () => {
  test('TC-SYS-006: concurrency changed to 5 survives a restart', async ({ page }) => {
    await freshApp(page);
    await openSettings(page);
    const concurrency = page.getByTestId('settings-concurrency');
    await expect(concurrency).toHaveValue('20');

    await concurrency.fill('5');
    await concurrency.press('Enter');
    await expect.poll(async () => (await engineSettings(page)).concurrency).toBe(5);
    await expect(page.getByText('Settings saved').first()).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('settings-concurrency')).toHaveValue('5');
  });

  test('FR-SYS-005: a value the contract refuses is shown inline and never saved', async ({
    page,
  }) => {
    await freshApp(page);
    await openSettings(page);
    const concurrency = page.getByTestId('settings-concurrency');
    await concurrency.fill('65');
    await concurrency.blur();
    await expect(page.getByText('Must be a whole number from 1 to 64.')).toBeVisible();

    const searxng = page.getByTestId('settings-searxng');
    await searxng.fill('not a url');
    await searxng.blur();
    await expect(page.getByText('Must be a full URL, like http://localhost:8080.')).toBeVisible();

    const settings = await engineSettings(page);
    expect(settings.concurrency).toBe(20);
    expect(settings.searxngUrl).toBeUndefined();
  });

  /*
   * Light is the default now (D329, `ace-theme` in localStorage), so choosing it would change
   * nothing: the test picks Dark. The Settings select still patches `Settings.theme`.
   */
  test('FR-SYS-005: switching the theme to dark applies it to the page at once', async ({
    page,
  }) => {
    await freshApp(page);
    await openSettings(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('settings-theme').click();
    await page.getByRole('option', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(async () => (await engineSettings(page)).theme).toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('FR-SYS-005: usable at 380 px with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await freshApp(page);
    await openSettings(page);
    for (const id of ['settings-data-dir', 'settings-upload-limit', 'backup-export']) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Backup (FR-SYS-012)', () => {
  test('FR-SYS-012: export a backup, wipe the engine, import it back and the projects return', async ({
    page,
  }) => {
    await freshApp(page);
    await page.evaluate(() => {
      window.__aceMock!.db.createProject({ name: 'Alpha' });
      window.__aceMock!.db.createProject({ name: 'Beta' });
    });
    await openSettings(page);

    const downloadEvent = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/^ace-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    const path = await download.path();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    await page.evaluate(() => window.__aceMock!.reset());
    expect(await projectNames(page)).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('backup-import')).toBeEnabled();

    const chooserEvent = page.waitForEvent('filechooser');
    await page.getByTestId('backup-import').click();
    await (await chooserEvent).setFiles(path);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('replaces');
    await dialog.getByRole('button', { name: 'Replace and restore' }).click();

    await expect(page.getByTestId('backup-restored')).toContainText('2 projects');
    expect(await projectNames(page)).toEqual(['Alpha', 'Beta']);

    await page.goto('/projects');
    await expect(page.getByRole('link', { name: 'Alpha' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Beta' })).toBeVisible();
  });
});
