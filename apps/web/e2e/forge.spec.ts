import { expect, test } from '@playwright/test';

import { diskFile, forgeUrl, freshApp, monacoEditor, seedForge, typeAtEnd } from './helpers';

const FILES = {
  'src/app.ts': 'export const app = 1;\n',
  'src/util/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'README.md': '# Shop\n',
  'logo.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
};

test.describe('Forge (D299, FR-GIT-003, FR-GIT-004)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('switches Ideate ⇄ Forge by button and by key, with the chat on the right in both', async ({
    page,
  }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(`/projects/${seeded.projectId}/workflows/${seeded.workflowId}`);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('chat-aside')).toBeVisible();

    await page.getByTestId('mode-forge').click();
    await expect(page).toHaveURL(/\/forge$/);
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toBeVisible();
    await expect(page.getByTestId('chat-aside')).toBeVisible();

    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(page.getByTestId('forge')).toBeVisible();
  });

  test('opens a file in the real Monaco, edits it and saves it with Ctrl+S', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    await page.getByTestId('tree-item-src/app.ts').dblclick();
    await expect(monacoEditor(page)).toContainText('export const app = 1;');

    await typeAtEnd(page, '// edited');
    await expect(page.getByTestId('dirty-src/app.ts')).toBeVisible();
    await page.keyboard.press('Control+S');
    await expect(page.getByTestId('dirty-src/app.ts')).toHaveCount(0);
    expect(await diskFile(page, seeded.projectId, 'src/app.ts')).toContain('// edited');
  });

  test('an unsaved buffer survives a switch to Ideate and back', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-README.md').dblclick();
    await typeAtEnd(page, 'kept across modes');
    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(page.getByTestId('dirty-README.md')).toBeVisible();
    await expect(monacoEditor(page)).toContainText('kept across modes');
  });

  test('a clean buffer follows the disk; an unsaved one gets the conflict bar, and Keep mine wins on save', async ({
    page,
  }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-README.md').dblclick();
    await expect(monacoEditor(page)).toContainText('# Shop');

    await page.evaluate(
      (id) => window.__aceMock!.writeFileExternally(id, 'README.md', '# Theirs\n'),
      seeded.projectId,
    );
    await expect(monacoEditor(page)).toContainText('# Theirs');

    await typeAtEnd(page, 'mine');
    await page.evaluate(
      (id) => window.__aceMock!.writeFileExternally(id, 'README.md', '# Theirs again\n'),
      seeded.projectId,
    );
    await expect(page.getByTestId('conflict-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
    await page.keyboard.press('Control+S');
    await expect.poll(() => diskFile(page, seeded.projectId, 'README.md')).toContain('mine');
  });

  test('quick open finds a file by a few letters', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('forge')).toBeVisible();
    await page.keyboard.press('Control+P');
    await page.getByRole('combobox', { name: 'Go to file' }).fill('mth');
    await expect(page.getByRole('option', { name: /math\.ts/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-src/util/math.ts')).toBeVisible();
  });

  test('creates, renames, moves by drag and deletes in the Explorer', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByRole('button', { name: 'New File', exact: true }).click();
    await page.getByRole('textbox', { name: 'New file name' }).fill('todo.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-todo.md')).toBeVisible();

    await page.getByTestId('tree-item-todo.md').click();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename todo.md' }).fill('done.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-done.md')).toBeVisible();

    await page.getByTestId('tree-item-done.md').dragTo(page.getByTestId('tree-item-src'));
    await page.getByRole('dialog').getByRole('button', { name: 'Move' }).click();
    await expect.poll(() => diskFile(page, seeded.projectId, 'src/done.md')).toBe('');
    await expect(page.getByTestId('tab-src/done.md')).toBeVisible();

    await page.getByTestId('tree-item-src/done.md').click();
    await page.keyboard.press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => diskFile(page, seeded.projectId, 'src/done.md')).toBeUndefined();
    await expect(page.getByTestId('tab-src/done.md')).toHaveCount(0);
  });

  test('panels are the person’s choice and are remembered across a reload', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Panel' })).toHaveCount(0);

    await page.keyboard.press('Control+J');
    await expect(page.getByRole('region', { name: 'Panel' })).toBeVisible();
    await page.keyboard.press('Control+B');
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('region', { name: 'Panel' })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Files of Shop' })).toHaveCount(0);
  });

  test('git decorations mark a changed file and colour its folder', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.evaluate(
      (id) => window.__aceMock!.setRepoStatus(id, [{ path: 'src/app.ts', status: 'modified' }]),
      seeded.projectId,
    );
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    // the theme's row marks are CSS content (D334), so a row's text stays its name
    await expect(page.getByTestId('tree-item-src/app.ts').getByTitle('Modified')).toHaveAttribute(
      'data-glyph',
      'M',
    );
  });

  test('Problems lists a TypeScript error from the real language service, and a click reveals it', async ({
    page,
  }) => {
    const seeded = await seedForge(page, {
      ...FILES,
      'src/bad.ts': 'const n: number = "text";\nexport { n };\n',
    });
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-src').click();
    await page.getByTestId('tree-item-src/bad.ts').dblclick();
    await expect(page.getByRole('button', { name: /^1 error/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^1 error/ }).click();
    await expect(page.getByRole('region', { name: 'Panel' })).toContainText(
      "Type 'string' is not assignable to type 'number'.",
    );
  });

  test('Alt+W closes the editor tab; an image opens as a picture', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.goto(forgeUrl(seeded));
    await page.getByTestId('tree-item-logo.svg').dblclick();
    await expect(page.getByRole('img', { name: 'logo.svg' })).toBeVisible();
    await page.keyboard.press('Alt+W');
    await expect(page.getByTestId('tab-logo.svg')).toHaveCount(0);
  });

  test('on a phone Forge is browse-only', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('compact-forge')).toBeVisible();
    await page.getByTestId('tree-item-README.md').click();
    await expect(page.getByLabel('Contents of README.md')).toContainText('# Shop');
    await expect(page.getByTestId('monaco-host')).toHaveCount(0);
  });
});
