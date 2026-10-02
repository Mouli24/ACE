import { expect, test, type Page } from '@playwright/test';

import {
  CORRUPT_PDF_FIXTURE,
  KB_FIXTURES,
  PARAPHRASE_QUERY,
  RARE_TERM,
  type KbFixture,
} from '../src/mocks/knowledge-fixtures';
import { freshApp } from './helpers';

/**
 * Knowledge screens through the UI against the MSW mock engine (round 5 §5 item 2, FR-RAG-001/002/
 * 003/008/009). The uploads are the real fixture bytes, so the mock's parsers and search see what
 * the engine would.
 */

const filePayload = (fixture: KbFixture) => ({
  name: fixture.name,
  mimeType: fixture.mime,
  buffer: Buffer.from(fixture.bytes()),
});

async function seedEmptyBase(page: Page): Promise<{ projectId: string; knowledgeBaseId: string }> {
  return page.evaluate(() => window.__aceMock!.seedKnowledgeBase(undefined, []));
}

async function seedFullBase(page: Page) {
  return page.evaluate(() => window.__aceMock!.seedKnowledgeBase());
}

const docRowByName = (page: Page, name: string) =>
  page.locator('[data-testid^="kb-doc-"]').filter({ hasText: name }).first();

async function runSearch(page: Page, query: string, mode: string, k = 5): Promise<void> {
  const panel = page.getByRole('search');
  await panel.getByLabel('Query').fill(query);
  await panel.getByLabel('Results (k)').fill(String(k));
  await panel.getByLabel('Mode').selectOption(mode);
  await panel.getByRole('button', { name: /search/i }).click();
}

test.describe('Knowledge screens (M5 §5 item 2)', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__aceMock!.setIngestPace(40));
  });

  test('TC-RAG-001: create a knowledge base from the project page on the mock embedder', async ({
    page,
  }) => {
    const projectId = await page.evaluate(() => {
      const mock = window.__aceMock!;
      mock.db.load();
      mock.db.createProvider({ type: 'mock', name: 'Mock' });
      return mock.db.createProject({ name: 'Handbook' }).id;
    });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('link', { name: 'Knowledge' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/knowledge$`));
    await expect(page.getByTestId('kb-empty')).toBeVisible();

    await page.getByRole('button', { name: 'New knowledge base' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Team handbook');
    await expect(dialog.getByLabel('Embedding model')).toHaveValue('mock-embed');
    await expect(dialog.getByLabel('Chunk size (tokens)')).toHaveValue('700');
    await expect(dialog.getByLabel('Overlap (tokens)')).toHaveValue('90');

    // overlap must be smaller than the chunk size
    await dialog.getByLabel('Overlap (tokens)').fill('700');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByText(/smaller than the chunk size/i).last()).toBeVisible();
    await dialog.getByLabel('Overlap (tokens)').fill('90');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(page).toHaveURL(/\/knowledge\/[0-9A-Z]+$/);
    await expect(page.getByTestId('kb-name')).toHaveText('Team handbook');
    const kbId = page.url().split('/').pop()!;

    await page.getByRole('link', { name: '← Knowledge' }).click();
    await expect(page.getByTestId(`kb-card-${kbId}`)).toContainText('0 documents · 0 chunks');
  });

  test('TC-RAG-002 / TC-RAG-003: six fixtures plus the corrupt PDF — six ready, one failed with its reason', async ({
    page,
  }) => {
    const { knowledgeBaseId } = await seedEmptyBase(page);
    await page.goto(`/knowledge/${knowledgeBaseId}`);
    await expect(page.getByText(/no documents yet/i)).toBeVisible();

    await page
      .getByTestId('kb-upload-input')
      .setInputFiles([...KB_FIXTURES, CORRUPT_PDF_FIXTURE].map(filePayload));

    for (const fixture of KB_FIXTURES) {
      await expect(
        docRowByName(page, fixture.name).locator('[data-testid^="kb-doc-status-"]'),
      ).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    }
    const corrupt = docRowByName(page, CORRUPT_PDF_FIXTURE.name);
    await expect(corrupt.locator('[data-testid^="kb-doc-status-"]')).toHaveAttribute(
      'data-status',
      'failed',
      { timeout: 20_000 },
    );
    await expect(corrupt.locator('[data-testid^="kb-doc-error-"]')).toHaveText(
      'Could not parse PDF: the file is damaged or not a PDF.',
    );
    await expect(page.locator('[data-testid^="kb-doc-error-"]')).toHaveCount(1);
    await expect(page.getByTestId('kb-meta')).toContainText('7 documents');
  });

  test('FR-RAG-003: the progress bar climbs live from kb.ingest', async ({ page }) => {
    await page.evaluate(() => window.__aceMock!.setIngestPace(400));
    const { knowledgeBaseId } = await seedEmptyBase(page);
    await page.goto(`/knowledge/${knowledgeBaseId}`);
    await page.getByTestId('kb-upload-input').setInputFiles([filePayload(KB_FIXTURES[2]!)]);

    const row = docRowByName(page, KB_FIXTURES[2]!.name);
    await expect(row.getByRole('progressbar')).toBeVisible();
    await expect(row.locator('[data-testid^="kb-doc-status-"]')).toHaveAttribute(
      'data-status',
      'embedding',
      { timeout: 10_000 },
    );
    await expect(row.locator('[data-testid^="kb-doc-status-"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 10_000 },
    );
    await expect(row.getByRole('progressbar')).toHaveCount(0);
  });

  test('FR-RAG-008: rare term via keyword, paraphrase via vector, scores and highlights shown', async ({
    page,
  }) => {
    const { knowledgeBaseId } = await seedFullBase(page);
    await page.goto(`/knowledge/${knowledgeBaseId}`);

    await runSearch(page, RARE_TERM, 'keyword');
    const first = page.locator('[data-testid^="kb-search-hit-"]').first();
    await expect(first).toContainText(RARE_TERM);
    await expect(first.locator('mark').first()).toHaveText(RARE_TERM);
    await expect(first.getByTestId('source-via')).toHaveText('keyword');
    await expect(first.getByTestId('kb-hit-score')).toHaveText(/^[01]\.\d\d$/);
    await expect(first.getByTestId('source-chip')).toContainText('security-handbook.pdf');

    await runSearch(page, PARAPHRASE_QUERY, 'vector', 3);
    const hits = page.locator('[data-testid^="kb-search-hit-"]');
    await expect(hits.first()).toContainText(/twenty-five days of paid annual leave/i);
    await expect(hits.first().getByTestId('source-via')).toHaveText('vector');
    expect(await hits.count()).toBeLessThanOrEqual(3);
  });

  test('TC-RAG-008: deleting a document stops search returning its content', async ({ page }) => {
    const { knowledgeBaseId } = await seedFullBase(page);
    await page.goto(`/knowledge/${knowledgeBaseId}`);

    await runSearch(page, RARE_TERM, 'keyword');
    await expect(page.locator('[data-testid^="kb-search-hit-"]').first()).toContainText(RARE_TERM);

    await page.getByRole('button', { name: 'Delete security-handbook.pdf' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
    await expect(docRowByName(page, 'security-handbook.pdf')).toHaveCount(0);

    // the open search re-runs on its own
    await expect(page.getByTestId('kb-search-summary')).toBeVisible();
    await expect(page.getByText(RARE_TERM)).toHaveCount(0);
    await page.reload();
    await runSearch(page, RARE_TERM, 'keyword');
    await expect(page.getByTestId('kb-search-summary')).toBeVisible();
    await expect(
      page.locator('[data-testid^="kb-search-hit-"]').filter({ hasText: RARE_TERM }),
    ).toHaveCount(0);
  });

  test('FR-RAG-009: rename, reindex and delete the base', async ({ page }) => {
    const { projectId, knowledgeBaseId } = await seedFullBase(page);
    await page.goto(`/knowledge/${knowledgeBaseId}`);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Renamed base');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('kb-name')).toHaveText('Renamed base');

    await page.getByTestId('kb-reindex').click();
    await expect(page.getByRole('progressbar').first()).toBeVisible();
    await expect(page.locator('[data-status="ready"]')).toHaveCount(KB_FIXTURES.length, {
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Delete knowledge base' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete knowledge base' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/knowledge$`));
    await expect(page.getByTestId('kb-empty')).toBeVisible();
  });

  test('works at 380 px with no horizontal scroll', async ({ page }) => {
    const { knowledgeBaseId } = await seedFullBase(page);
    await page.setViewportSize({ width: 380, height: 800 });
    await page.goto(`/knowledge/${knowledgeBaseId}`);
    await expect(page.locator('[data-testid^="kb-doc-status-"]').first()).toBeVisible();
    await runSearch(page, RARE_TERM, 'hybrid');
    await expect(page.locator('[data-testid^="kb-search-hit-"]').first()).toBeVisible();

    const overflow = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="knowledge-base-page"]')!;
      return {
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: main.scrollWidth - main.clientWidth,
      };
    });
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.main).toBeLessThanOrEqual(0);
  });
});
