import { expect, test } from '@playwright/test';

import { freshApp } from './helpers';

test.describe('Projects (FR-PRJ-001..004)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-PRJ-001: create a project with a new folder path → listed', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Demo');
    await dialog.getByLabel(/folder path/i).fill('/mock/projects/demo-new');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('link', { name: 'Demo' })).toBeVisible();
    await expect(page.getByText('/mock/projects/demo-new')).toBeVisible();
  });

  test('TC-PRJ-002: unwritable folder → inline error naming the path', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Nope');
    await dialog.getByLabel(/folder path/i).fill('/readonly/nope');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('/readonly/nope');
    await expect(dialog).toBeVisible();
  });

  test('TC-PRJ-003: delete asks for confirmation, then the project is gone', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Gone');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('link', { name: 'Gone' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Gone' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Delete “Gone”?');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('link', { name: 'Gone' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Gone' })).toHaveCount(0);
  });

  test('TC-PRJ-004: open project B, relaunch → project B opens', async ({ page }) => {
    for (const name of ['Project A', 'Project B']) {
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('dialog').getByLabel('Name').fill(name);
      await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Project B' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}$/);
    const url = page.url();
    await page.goto('/');
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('project-name')).toHaveText('Project B');
  });
});
