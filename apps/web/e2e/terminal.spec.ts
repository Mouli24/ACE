import { expect, test } from '@playwright/test';

import { forgeUrl, freshApp, openTerminal, runLine, seedForge, terminalText } from './helpers';

const FILES = {
  'src/app.ts': 'export const app = 1;\n',
  'package.json': JSON.stringify(
    {
      name: 'shop',
      packageManager: 'pnpm@9.15.9',
      scripts: { hello: 'echo hi from a script', dev: 'serve' },
    },
    null,
    2,
  ),
};

test.describe('Forge terminal (D301)', () => {
  test.beforeEach(async ({ page }) => freshApp(page));

  test('runs echo hello and shows its output', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'echo hello');
    // The output line itself, not the echoed command: row by row, then the next prompt.
    await expect(terminalText(page)).toContainText(/echo\shello\s+hello\s+~\s\$/, {
      useInnerText: true,
    });
  });

  test('a dev server streams, the footer counts it and opens it, Ctrl+C stops it, and Processes shows it ended', async ({
    page,
  }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'serve');
    await expect(terminalText(page)).toContainText('listening on 3000');
    await expect(terminalText(page)).toContainText('GET / 200 (2)', { timeout: 5_000 });
    const running = page.getByRole('contentinfo').getByRole('button', { name: '1 running' });
    await expect(running).toBeVisible();

    // Hidden with Ctrl+J, the footer's count brings the Terminal back (D334 as amended).
    await page.keyboard.press('Control+KeyJ');
    await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
    await running.click();
    await expect(page.getByTestId('terminal-panel')).toBeVisible();

    await page.getByTestId('terminal-view').click();
    await page.keyboard.press('Control+C');
    await expect(terminalText(page)).toContainText('[stopped (SIGKILL)]');
    await expect(
      page.getByRole('region', { name: 'Processes' }).getByText('stopped'),
    ).toBeVisible();
    await expect(
      page.getByRole('contentinfo').getByRole('button', { name: /running$/ }),
    ).toHaveCount(0);
  });

  test('a line prompt reads what is typed', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'ask');
    await expect(terminalText(page)).toContainText('name?');
    await runLine(page, 'Ada');
    await expect(terminalText(page)).toContainText('hello Ada');
  });

  test('cd src changes the prompt, and cd .. comes back', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'cd src');
    await expect(terminalText(page)).toContainText('src $');
    await runLine(page, 'cd ..');
    // Row by row (innerText); \s also matches the no-break spaces xterm may render.
    await expect(terminalText(page)).toContainText(/src\s\$\scd\s\.\.\s+~\s\$/, {
      useInnerText: true,
    });
  });

  test('cls and clear leave exactly one prompt on screen, with nothing above it', async ({
    page,
  }) => {
    await openTerminal(page, await seedForge(page, FILES));
    for (const word of ['cls', 'clear']) {
      await runLine(page, `echo before ${word}`);
      // Wait for the output line and the next prompt, so the word below is typed at the prompt.
      await expect(terminalText(page)).toContainText(
        new RegExp(String.raw`echo\sbefore\s${word}\s+before\s${word}\s+~\s\$`),
        { useInnerText: true },
      );
      await runLine(page, word);
      // The view resets in-stream with ESC c: only a fresh prompt remains.
      await expect(terminalText(page)).toHaveText(/^\s*~\s\$\s*$/, { useInnerText: true });
    }
  });

  test('a script button runs the script in a new tab', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await page
      .getByRole('group', { name: 'Scripts' })
      .getByRole('button', { name: 'hello' })
      .click();
    await expect(
      page.getByRole('tablist', { name: 'Terminals' }).getByRole('tab', { name: 'hello' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(terminalText(page)).toContainText('pnpm run hello');
    await expect(terminalText(page)).toContainText('hi from a script');
  });

  test('scrollback survives Ideate and back', async ({ page }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await runLine(page, 'echo kept across modes');
    await expect(terminalText(page)).toContainText('kept across modes');
    await page.keyboard.press('Control+Shift+Digit1');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.keyboard.press('Control+Shift+Digit2');
    await expect(terminalText(page)).toContainText('kept across modes');
  });

  test('with the terminal off, the notice shows and typing does nothing', async ({ page }) => {
    const seeded = await seedForge(page, FILES);
    await page.evaluate((id) => window.__aceMock!.setTerminal(id, 'off'), seeded.projectId);
    await page.goto(forgeUrl(seeded));
    await expect(page.getByTestId('forge')).toBeVisible();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-trust-notice')).toContainText(
      'The terminal is off for this project.',
    );
    await page.getByTestId('terminal-view').click();
    await page.keyboard.type('echo nope');
    await page.keyboard.press('Enter');
    await expect(terminalText(page)).not.toContainText('echo nope');
    await expect(page.getByRole('button', { name: 'New terminal' })).toBeDisabled();
  });

  test('Ctrl+` shows and hides the Terminal, the first of the panel’s two pills, even with focus in it', async ({
    page,
  }) => {
    await openTerminal(page, await seedForge(page, FILES));
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
    const pills = page.getByRole('tablist', { name: 'Panel views' }).getByRole('tab');
    await expect(pills).toHaveText(['Terminal', 'Problems']);
    await expect(pills.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
  });
});
