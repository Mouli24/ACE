import AxeBuilder from '@axe-core/playwright';
import { test, type Page } from '@playwright/test';

import {
  card,
  closeSettings,
  expect,
  fitView,
  mockProvider,
  open,
  openCanvas,
  runToEnd,
  seedAgents,
  useTheme,
  type Theme,
} from './helpers.js';

/**
 * PG-1.2 Every control visible (product-gaps prompt, Phase 1; D360).
 *
 * Every route is scanned in both themes by axe-core (`@axe-core/playwright`) for the rule families
 * PG-1.2 names — WCAG AA colour contrast, and an accessible name on every button, link, input and
 * ARIA widget — plus the prompt's own rule that no control is a unicode glyph (a glyph renders as a
 * box or not at all on some Windows setups), which axe has no rule for and is checked in the page.
 */

interface Violation {
  route: string;
  rule: string;
  what: string;
}

/**
 * The axe rules PG-1.2 asks for: contrast, and the name rules for every kind of control. Run with
 * only these, so a scan reports what this item fixes and nothing it does not own.
 */
const AXE_RULES = [
  'color-contrast',
  'button-name',
  'link-name',
  'input-button-name',
  'select-name',
  'label',
  'aria-command-name',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-meter-name',
  'aria-progressbar-name',
  'aria-tooltip-name',
  'aria-dialog-name',
];

/**
 * The glyph rule: a symbol from the arrows, technical, geometric, dingbat, misc-symbol or emoji
 * blocks, or a variation selector, inside a control's visible text — `⚙︎ ⛶ ⌕ ⌁ ✳ ✎ ◦ 🔒︎ ⋯ ✕ ▸`.
 */
const GLYPH_SOURCE =
  '[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u25FF\\u2600-\\u27BF\\u2900-\\u2BFF\\u22EF\\u2026\\u00D7\\uFE0E\\uFE0F\\u{1F300}-\\u{1FAFF}]';

/** Glyph controls: a control whose visible text is a glyph (and at most one other character). */
async function glyphControls(page: Page, route: string): Promise<Violation[]> {
  const found = await page.evaluate(
    ({ glyphSource }) => {
      const glyph = new RegExp(glyphSource, 'u');
      const out: string[] = [];
      const visible = (el: Element): boolean => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        for (let at: Element | null = el; at !== null; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.visibility === 'hidden' || style.display === 'none') return false;
        }
        return true;
      };
      const controls = Array.from(
        document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="radio"], [role="checkbox"]',
        ),
      ).filter(visible);
      for (const el of controls) {
        const text = (el.textContent ?? '').trim();
        if (
          text !== '' &&
          glyph.test(text) &&
          text.replace(new RegExp(glyphSource, 'gu'), '').trim().length <= 1
        ) {
          const html = el.outerHTML.replace(/\s+/gu, ' ');
          out.push(`"${text}" ${html.length > 140 ? `${html.slice(0, 140)}…` : html}`);
        }
      }
      return out;
    },
    { glyphSource: GLYPH_SOURCE },
  );
  return found.map((what) => ({ route, rule: 'glyph', what }));
}

/** axe-core over the page as it stands, with PG-1.2's rules. */
async function axe(page: Page, route: string): Promise<Violation[]> {
  const results = await new AxeBuilder({ page }).withRules(AXE_RULES).analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      route,
      rule: violation.id,
      what: `${node.target.join(' ')} — ${node.failureSummary?.replace(/\s+/gu, ' ') ?? ''}`.slice(
        0,
        320,
      ),
    })),
  );
}

async function scan(page: Page, route: string): Promise<Violation[]> {
  return [...(await axe(page, route)), ...(await glyphControls(page, route))];
}

interface Routes {
  projectId: string;
  workflowId: string;
  runId: string;
}

async function seedRoutes(theme: Theme): Promise<Routes> {
  const providerId = await mockProvider();
  const flow = await seedAgents(
    `visible-${theme}`,
    [
      { name: 'Writer', providerId, modelId: 'mock-text' },
      { name: 'Editor', providerId, modelId: 'mock-text' },
    ],
    { edges: [['Writer', 'Editor']] },
  );
  const run = await runToEnd(flow.workflowId);
  return { projectId: flow.projectId, workflowId: flow.workflowId, runId: run.id };
}

const ROUTES = (r: Routes): Array<[string, string]> => [
  ['Home', '/projects'],
  ['Project', `/projects/${r.projectId}`],
  ['Ideate', `/projects/${r.projectId}/workflows/${r.workflowId}`],
  ['Forge', `/projects/${r.projectId}/workflows/${r.workflowId}/forge`],
  ['Domain', `/projects/${r.projectId}/workflows/${r.workflowId}/domain`],
  ['Run detail', `/runs/${r.runId}`],
  ['Timeline', `/projects/${r.projectId}/workflows/${r.workflowId}/timeline`],
  ['Providers', '/providers'],
  ['Settings', '/settings'],
  ['Onboarding', '/onboarding'],
];

test.describe('PG-1.2 every control visible', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`a scan of every route has no unnamed control, no glyph control and no text under AA contrast (${theme})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await useTheme(page, theme);
      const routes = await seedRoutes(theme);
      const violations: Violation[] = [];
      for (const [name, path] of ROUTES(routes)) {
        await open(page, path);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        violations.push(...(await scan(page, name)));
      }
      const report = violations.map((v) => `${v.route} · ${v.rule} · ${v.what}`);
      expect(report, `every route is clean in the ${theme} theme`).toEqual([]);
    });
  }

  test('each node card has always-visible Settings and More buttons, and More holds the node actions', async ({
    page,
  }) => {
    // PG-1.2 (D360): was red while a card had no buttons (settings on a click, the rest right-click).
    const providerId = await mockProvider();
    const flow = await seedAgents('card-buttons', [
      { name: 'Writer', providerId, modelId: 'mock-text' },
    ]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    await closeSettings(page);
    await fitView(page);

    const writer = card(page, flow.byName('Writer').id);
    // No hover: the buttons are there to be seen.
    await page.mouse.move(2, 2);
    await expect(writer.getByRole('button', { name: 'Settings' })).toBeVisible();
    const more = writer.getByRole('button', { name: 'More' });
    await expect(more).toBeVisible();
    await more.click();
    const menu = page.getByRole('menu');
    for (const item of ['Open in Domain', 'Connect to…', 'Duplicate', 'Delete', 'Run from here']) {
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
    }
  });

  for (const mode of ['Ideate', 'Forge', 'Domain'] as const) {
    // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
    test.skip(`run controls sit in the header in ${mode}: Run, Pause, Stop, Restart`, async ({
      page,
    }) => {
      // PG-1.2 (D360): was red while the run controls lived only in Ideate's "…" menu.
      const providerId = await mockProvider();
      const flow = await seedAgents(`header-${mode}`, [
        { name: 'Writer', providerId, modelId: 'mock-text' },
      ]);
      const base = `/projects/${flow.projectId}/workflows/${flow.workflowId}`;
      await open(page, mode === 'Ideate' ? base : `${base}/${mode.toLowerCase()}`);
      await expect(page.getByRole('radio', { name: new RegExp(mode) })).toHaveAttribute(
        'aria-checked',
        'true',
        {
          timeout: 30_000,
        },
      );

      const header = page.locator('header').first();
      await expect(header.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
      for (const name of ['Pause', 'Stop', 'Restart']) {
        await expect(header.getByRole('button', { name, exact: true })).toBeAttached();
      }
    });
  }

  test('Problems & events has a visible footer button', async ({ page }) => {
    // PG-1.2 (D360): was red while Problems & events was reachable only from the "…" menu.
    const providerId = await mockProvider();
    const flow = await seedAgents('footer', [{ name: 'Writer', providerId, modelId: 'mock-text' }]);
    await openCanvas(page, flow.projectId, flow.workflowId);
    const footer = page.getByRole('contentinfo');
    await expect(footer).toBeVisible();
    const problems = footer.getByRole('button', { name: /Problems/ });
    await expect(problems).toBeVisible();
    await problems.click();
    await expect(page.getByTestId('bottom-section')).toBeVisible();
  });
});
