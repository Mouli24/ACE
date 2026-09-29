import { expect, test, type Page } from '@playwright/test';

import { freshApp, openWorkflow, seedGraph, serverGraph } from './helpers';

/** Drop a file (built in the browser, so its bytes are deterministic) onto an element. */
async function dropFile(
  page: Page,
  testId: string,
  file: { name: string; type: string; size: number },
): Promise<void> {
  const dataTransfer = await page.evaluateHandle((f) => {
    const dt = new DataTransfer();
    // A zero-filled buffer of a fixed size hashes the same every time → dedupe is testable.
    dt.items.add(new File([new Uint8Array(f.size)], f.name, { type: f.type }));
    return dt;
  }, file);
  const zone = page.locator(`[data-testid="${testId}"]`);
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });
}

const artifactIdsOf = async (page: Page, workflowId: string, nodeId: string): Promise<string[]> => {
  const graph = await serverGraph(page, workflowId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  const config = node?.config as { artifactIds?: string[] } | undefined;
  return config?.artifactIds ?? [];
};

test.describe('Uploads onto the Input node (M4 §2, FR-MM-001/007)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('TC-MM-007 / TC-MM-002: dropping a file attaches it; dropping the same file keeps one entry', async ({
    page,
  }) => {
    const seeded = await seedGraph(page, ['input']);
    const [input] = seeded.nodeIds as [string];
    await openWorkflow(page, seeded);

    await dropFile(page, `input-dropzone-${input}`, {
      name: 'sample.png',
      type: 'image/png',
      size: 16,
    });

    // The card shows one attachment, and the engine (mock) has one id on the node config.
    await expect(page.getByTestId(`input-attachment-count-${input}`)).toHaveText(
      /1 file attached/i,
    );
    await expect
      .poll(async () => (await artifactIdsOf(page, seeded.workflowId, input)).length)
      .toBe(1);
    const first = (await artifactIdsOf(page, seeded.workflowId, input))[0];

    // Drop the identical bytes again → the engine dedupes to the same id and the list stays at one.
    await dropFile(page, `input-dropzone-${input}`, {
      name: 'sample.png',
      type: 'image/png',
      size: 16,
    });
    await expect(page.getByTestId(`input-attachment-count-${input}`)).toHaveText(
      /1 file attached/i,
    );
    const ids = await artifactIdsOf(page, seeded.workflowId, input);
    expect(ids).toEqual([first]);

    // It survives a reload (it is on the node config, not in the page).
    await page.reload();
    await expect(page.getByTestId(`input-attachment-count-${input}`)).toHaveText(
      /1 file attached/i,
    );
  });

  test('TC-MM-001: an oversized file is refused inline with the limit', async ({ page }) => {
    const seeded = await seedGraph(page, ['input']);
    const [input] = seeded.nodeIds as [string];
    await openWorkflow(page, seeded);

    // Shrink the limit so a 2 MB file is over it without moving 100 MB of bytes around.
    await page.evaluate(() => {
      window.__aceMock!.db.load();
      window.__aceMock!.db.patchSettings({ maxUploadMb: 1 });
    });

    await dropFile(page, `input-dropzone-${input}`, {
      name: 'big.png',
      type: 'image/png',
      size: 2 * 1024 * 1024,
    });

    const error = page.getByTestId(`input-drop-error-${input}`);
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-code', 'upload_too_large');
    await expect(error).toContainText(/1 MB/);
    // Nothing was attached.
    expect(await artifactIdsOf(page, seeded.workflowId, input)).toEqual([]);
  });
});
