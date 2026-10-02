import { expect, test, type Page } from '@playwright/test';

/**
 * The first-run wizard against the in-browser mock engine (FR-ONB-001/002/003, TC-ONB-001/002):
 * from a clean profile to a COMPLETE run with no key, for each of the four templates, and once with
 * the keyboard only.
 */

const TEMPLATES = [
  { id: 'linear-chain', name: /linear chain/i },
  { id: 'review-fix', name: /review and fix/i },
  { id: 'parallel-research', name: /parallel research/i },
  { id: 'rag-qa', name: /rag q&a/i },
] as const;

/** A clean mock engine and a clean session: what a brand-new user has. */
async function cleanProfile(page: Page) {
  await page.goto('/projects');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

const runStatus = (page: Page) => page.getByTestId('run-status');

test.describe('TC-ONB-001 clean profile → wizard → completed run', () => {
  test('/ opens the wizard; Mock → RAG Q&A → run COMPLETE with no key', async ({ page }) => {
    await cleanProfile(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByTestId('onboarding-step-1')).toHaveAttribute('aria-current', 'step');

    await page.getByTestId('onboarding-use-mock').click();
    await page.getByTestId('template-card-rag-qa').click();
    await page.getByTestId('onboarding-next').click();
    await page.getByLabel('Project name').fill('Docs helper');
    await page.getByRole('button', { name: 'Create project and run' }).click();

    await expect(page).toHaveURL(/\/projects\/\w+\/workflows\/\w+$/);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });
    await expect(page.getByTestId('project-name')).toHaveText('Docs helper');

    const providers = await page.evaluate(() => {
      const db = window.__aceMock!.db;
      db.load();
      return db.listProviders().map((p) => ({ type: p.type, keySet: p.keySet }));
    });
    expect(providers).toEqual([{ type: 'mock', keySet: false }]);

    // Done once means `/` no longer offers the wizard.
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/onboarding$/);
  });
});

test.describe('TC-ONB-002 each template reaches COMPLETE from the wizard', () => {
  for (const template of TEMPLATES) {
    test(template.id, async ({ page }) => {
      await cleanProfile(page);
      await page.goto('/onboarding');
      await page.getByTestId('onboarding-use-mock').click();
      await page.getByTestId(`template-card-${template.id}`).click();
      await page.getByTestId('onboarding-next').click();
      await page.getByRole('button', { name: 'Create project and run' }).click();
      await expect(page).toHaveURL(/\/workflows\/\w+$/);
      await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', {
        timeout: 20_000,
      });
    });
  }
});

test.describe('FR-ONB-001 skip and resume', () => {
  test('Skip setup opens the projects and creates nothing', async ({ page }) => {
    await cleanProfile(page);
    await page.goto('/onboarding');
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('leaving for the guide and coming back resumes the step', async ({ page }) => {
    await cleanProfile(page);
    await page.goto('/onboarding');
    await page.getByTestId('onboarding-use-mock').click();
    await page.getByTestId('template-card-review-fix').click();
    await page.getByTestId('help-link-building-a-workflow').click();
    await expect(page).toHaveURL(/\/help\/building-a-workflow$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Building a workflow');
    await page.goto('/onboarding');
    await expect(page.getByTestId('onboarding-step-2')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('radio', { name: /review and fix/i })).toBeChecked();
    const projects = await page.evaluate(() => {
      const db = window.__aceMock!.db;
      db.load();
      return db.listProjects().length;
    });
    expect(projects).toBe(0);
  });
});

/** Tab forward until the element with this test id has focus — Tab and nothing else. */
async function tabTo(page: Page, testId: string) {
  for (let i = 0; i < 60; i += 1) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (focused === testId) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${testId}`);
}

test('keyboard only: Tab, Enter, Space and arrows reach a completed run', async ({ page }) => {
  await cleanProfile(page);
  await page.goto('/onboarding');
  await expect(page.getByTestId('onboarding-use-mock')).toBeVisible();

  await tabTo(page, 'onboarding-use-mock');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('onboarding-step-2')).toHaveAttribute('aria-current', 'step');

  // Into the radio group, then the arrows choose: the fourth card is RAG Q&A.
  const first = page.getByRole('radio').first();
  await expect(first).toBeAttached();
  for (
    let i = 0;
    i < 60 && !(await first.evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /rag q&a/i })).toBeChecked();

  await tabTo(page, 'onboarding-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('onboarding-step-3')).toHaveAttribute('aria-current', 'step');

  await tabTo(page, 'onboarding-create');
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/\/workflows\/\w+$/);
  await expect(runStatus(page)).toHaveAttribute('data-status', 'COMPLETE', { timeout: 20_000 });
});

test('FR-ONB-003 every guide page renders from the help index', async ({ page }) => {
  await page.goto('/help/getting-started');
  const index = page.getByRole('navigation', { name: 'User guide' });
  const links = index.getByRole('link');
  await expect(links.first()).toBeVisible();
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < count; i += 1) {
    await links.nth(i).click();
    await expect(page.getByTestId('help-article').getByRole('heading', { level: 1 })).toBeVisible();
  }
  await page.goto('/help/does-not-exist');
  await expect(page.getByTestId('help-not-found')).toBeVisible();
});
