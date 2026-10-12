import { expect, test, type Page } from '@playwright/test';

import { freshApp } from './helpers';

/**
 * Home's "New project" is its Canvas card now (D337): the same New project dialog, and Create opens
 * the project's first workflow, named after it — so a test that wants the list goes back Home.
 */
async function createProject(page: Page, name: string, folderPath?: string): Promise<void> {
  await page.getByRole('button', { name: /^Canvas/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  if (folderPath !== undefined) await dialog.getByLabel(/folder path/i).fill(folderPath);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}\/workflows\/[0-9A-Z]{26}$/);
  await expect(page.getByTestId('project-name')).toHaveText(name);
}

/** Back to Home (`/projects`) through the Canvas breadcrumb. */
async function goHome(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'HOME' }).click();
  await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
}

test.describe('Projects (FR-PRJ-001..004)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-PRJ-001: create a project with a new folder path → listed', async ({ page }) => {
    await createProject(page, 'Demo', '/mock/projects/demo-new');
    await goHome(page);
    await expect(page.getByRole('link', { name: 'Demo' })).toBeVisible();
    // the folder path is no longer on Home's cards (D337); the project page shows it
    await page.getByRole('link', { name: 'Demo' }).click();
    await expect(page.getByTestId('project-page-name')).toHaveText('Demo');
    await expect(page.getByText('/mock/projects/demo-new')).toBeVisible();
  });

  test('TC-PRJ-002: unwritable folder → inline error naming the path', async ({ page }) => {
    await page.getByRole('button', { name: /^Canvas/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Nope');
    await dialog.getByLabel(/folder path/i).fill('/readonly/nope');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('/readonly/nope');
    await expect(dialog).toBeVisible();
  });

  test('TC-PRJ-003: delete asks for confirmation, then the project is gone', async ({ page }) => {
    await createProject(page, 'Gone');
    await goHome(page);
    await expect(page.getByRole('link', { name: 'Gone' })).toBeVisible();
    // Delete lives in the workspace "…" menu (D331): back to the project's workflow
    await page.goBack();
    await expect(page.getByTestId('project-name')).toHaveText('Gone');
    await page.getByTestId('workspace-menu').click();
    await page.getByTestId('menu-delete-project').click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Delete “Gone”?');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('link', { name: 'Gone' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Gone' })).toHaveCount(0);
  });

  test('TC-PRJ-004: open project B, relaunch → project B opens', async ({ page }) => {
    for (const name of ['Project A', 'Project B']) {
      await createProject(page, name);
      await goHome(page);
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Project B' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}$/);
    const url = page.url();
    await page.goto('/');
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('project-page-name')).toHaveText('Project B');
  });
});
