import { test, type Page } from '@playwright/test';

import {
  NOT_BUILT,
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
 * PG-1.2 Every control visible (product-gaps prompt, Phase 1). Red until PG-1.2 lands.
 *
 * The prompt asks for an axe-core scan. `@axe-core/playwright` is not a dependency of this package,
 * and adding it would change the workspace lockfile for one test; the scan below checks in the page
 * the two rule families PG-1.2 names — every control has an accessible name, and its text meets WCAG
 * AA contrast (4.5:1, 3:1 for large text) against the background it is drawn on — plus the prompt's
 * own rule that no control is a unicode glyph (a glyph renders as a box or not at all on some
 * Windows setups). If axe is added later, it replaces `scan()`; the assertions stay.
 */

interface Violation {
  route: string;
  rule: 'name' | 'contrast' | 'glyph';
  what: string;
}

/**
 * The glyph rule: a symbol from the arrows, technical, geometric, dingbat, misc-symbol or emoji
 * blocks, or a variation selector, inside a control's visible text — `⚙︎ ⛶ ⌕ ⌁ ✳ ✎ ◦ 🔒︎ ⋯ ✕ ▸`.
 */
const GLYPH_SOURCE =
  '[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u25FF\\u2600-\\u27BF\\u2900-\\u2BFF\\u22EF\\u2026\\u00D7\\uFE0E\\uFE0F\\u{1F300}-\\u{1FAFF}]';

/** Scan the page as it stands: controls without a name, glyph controls, text under AA contrast. */
async function scan(page: Page, route: string): Promise<Violation[]> {
  const found = await page.evaluate((glyphSource) => {
    const glyph = new RegExp(glyphSource, 'u');
    const out: Array<{ rule: 'name' | 'contrast' | 'glyph'; what: string }> = [];

    const visible = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
      }
      return true;
    };
    const describe = (el: Element): string => {
      const html = el.outerHTML.replace(/\s+/gu, ' ');
      return html.length > 140 ? `${html.slice(0, 140)}…` : html;
    };
    const nameOf = (el: Element): string => {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy !== null) {
        const text = labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text !== '') return text;
      }
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        const label = el.labels?.[0]?.textContent?.trim();
        if (label) return label;
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return placeholder;
      }
      const text = (el.textContent ?? '').trim();
      if (text !== '') return text;
      const img = el.querySelector('img[alt], svg[aria-label], [title]');
      return (
        img?.getAttribute('alt') ??
        img?.getAttribute('aria-label') ??
        img?.getAttribute('title') ??
        el.getAttribute('title') ??
        ''
      ).trim();
    };

    const parse = (value: string): [number, number, number, number] | null => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/u.exec(value);
      if (m === null) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    /** The first opaque-enough background behind an element, blended over white at the root. */
    const backgroundOf = (el: Element): [number, number, number, number] => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const bg = parse(getComputedStyle(at).backgroundColor);
        if (bg !== null && bg[3] >= 0.9) return bg;
      }
      return [255, 255, 255, 1];
    };

    const controls = Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="radio"], [role="checkbox"], input:not([type="hidden"]), select, textarea',
      ),
    ).filter(visible);

    for (const el of controls) {
      const name = nameOf(el);
      if (name === '') out.push({ rule: 'name', what: describe(el) });
      const text = (el.textContent ?? '').trim();
      if (
        text !== '' &&
        glyph.test(text) &&
        text.replace(new RegExp(glyphSource, 'gu'), '').trim().length <= 1
      ) {
        out.push({ rule: 'glyph', what: `"${text}" ${describe(el)}` });
      }
      if (text !== '') {
        const style = getComputedStyle(el);
        const fg = parse(style.color);
        if (fg !== null) {
          const bg = backgroundOf(el);
          const alpha = fg[3] * Number(style.opacity);
          const blended: [number, number, number, number] = [
            fg[0] * alpha + bg[0] * (1 - alpha),
            fg[1] * alpha + bg[1] * (1 - alpha),
            fg[2] * alpha + bg[2] * (1 - alpha),
            1,
          ];
          const [hi, lo] = [luminance(blended), luminance(bg)].sort((a, b) => b - a) as [
            number,
            number,
          ];
          const ratio = (hi + 0.05) / (lo + 0.05);
          const size = parseFloat(style.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          const needed = large ? 3 : 4.5;
          const disabled =
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute('aria-disabled') === 'true';
          if (!disabled && ratio < needed) {
            out.push({
              rule: 'contrast',
              what: `${ratio.toFixed(2)}:1 < ${needed}:1 "${text.slice(0, 40)}" ${describe(el)}`,
            });
          }
        }
      }
    }
    return out;
  }, GLYPH_SOURCE);
  return found.map((each) => ({ route, ...each }));
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
      // PG-1.2: glyph controls (⚙︎ ⛶ ⌕ …) and under-contrast controls exist on today's routes.
      test.fail(NOT_BUILT, 'PG-1.2: unicode glyph controls and AA contrast failures today');
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
    // PG-1.2: a card has no buttons today; settings open on a click, the rest is a right-click menu.
    test.fail(NOT_BUILT, 'PG-1.2: node cards have no visible Settings / More buttons');
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
    test(`run controls sit in the header in ${mode}: Run, Pause, Stop, Restart`, async ({
      page,
    }) => {
      // PG-1.2: today the run controls live only in Ideate's "…" menu (`canvas/Canvas.tsx`).
      test.fail(NOT_BUILT, `PG-1.2: no run controls in the ${mode} header`);
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
    // PG-1.2: Problems & events is reachable only from the "…" workspace menu today.
    test.fail(NOT_BUILT, 'PG-1.2: no Problems & events button in the footer');
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
