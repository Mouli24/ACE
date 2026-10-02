import { expect, test, type Page } from '@playwright/test';

import { freshApp } from './helpers';

/**
 * Round 5 §5 item 5 against the MSW mock engine: the trace tab (FR-OBS-001, TC-OBS-001), the usage
 * screen (FR-OBS-004, TC-OBS-004), its 380 px layout (NFR-USE-03) and chart contrast in both
 * themes (D241, WCAG 1.4.11 ≥ 3:1).
 */

interface ApiTraceEntry {
  seq: number;
  kind: string;
  label: string;
}
interface ApiUsage {
  buckets: {
    key: Record<string, string>;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    runs: number;
  }[];
  totals: { tokensIn: number; tokensOut: number; costUsd: number };
}

/** A GET through the page, so the service worker (the mock engine) answers it. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const res = await fetch(`/api/v1${url}`, { headers: { authorization: 'Bearer mock' } });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return (await res.json()) as T;
  }, path);
}

const DAY_MS = 86_400_000;
/** The usage screen's default range: the last 7 UTC days, `[from, to)` (D234). */
function sevenDays(): { from: string; to: string } {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: new Date(today - 6 * DAY_MS).toISOString(),
    to: new Date(today + DAY_MS).toISOString(),
  };
}

function usagePath(groupBy: string[], range = sevenDays()): string {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const by of groupBy) params.append('groupBy', by);
  return `/usage?${params.toString()}`;
}

async function seedUsage(page: Page, days: number) {
  return page.evaluate((d) => window.__aceMock!.seedUsage(d), days);
}

/** Every table cell against the API, cell by cell (TC-OBS-004). */
async function expectTableEqualsApi(page: Page, groupBy: string[]) {
  const expected = await apiGet<ApiUsage>(page, usagePath(groupBy));
  expect(expected.buckets.length).toBeGreaterThan(0);
  await expect(page.locator('[data-testid^="usage-row-"]')).toHaveCount(expected.buckets.length);
  const shown = await page.getByTestId('usage-table').evaluate((table) => {
    const read = (el: Element, id: string) =>
      Number(el.querySelector(`[data-testid="${id}"]`)!.getAttribute('data-value'));
    const rows = [...table.querySelectorAll('[data-testid^="usage-row-"]')].map((row) => ({
      keys: [...row.querySelectorAll('[data-testid^="usage-key-"]')].map(
        (cell) => cell.getAttribute('data-key') ?? '',
      ),
      tokensIn: read(row, 'usage-tokensIn'),
      tokensOut: read(row, 'usage-tokensOut'),
      costUsd: read(row, 'usage-costUsd'),
      runs: read(row, 'usage-runs'),
    }));
    const totals = table.querySelector('[data-testid="usage-totals"]')!;
    return {
      rows,
      totals: {
        tokensIn: read(totals, 'usage-tokensIn'),
        tokensOut: read(totals, 'usage-tokensOut'),
        costUsd: read(totals, 'usage-costUsd'),
      },
    };
  });
  expect(shown.rows).toEqual(
    expected.buckets.map((b) => ({
      keys: groupBy.map((by) => b.key[by]),
      tokensIn: b.tokensIn,
      tokensOut: b.tokensOut,
      costUsd: b.costUsd,
      runs: b.runs,
    })),
  );
  expect(shown.totals).toEqual({
    tokensIn: expected.totals.tokensIn,
    tokensOut: expected.totals.tokensOut,
    costUsd: expected.totals.costUsd,
  });
}

test.beforeEach(async ({ page }) => {
  await freshApp(page);
});

test('TC-OBS-001: the trace tab is in the order of GET /runs/:id/trace and of the event log', async ({
  page,
}) => {
  const { runId } = await page.evaluate(() => window.__aceMock!.playRound5Scenario('trace-full'));
  expect(runId).toBeTruthy();
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const db = window.__aceMock!.db;
          db.load();
          return db.getRun(id)?.status;
        }, runId!),
      { timeout: 30_000 },
    )
    .toBe('COMPLETE');

  await page.goto(`/runs/${runId}`);
  const tab = page.getByTestId('trace-tab');
  await expect(tab).toBeVisible();
  await expect(tab.getByRole('heading', { name: 'Trace' })).toBeVisible();

  const api = await apiGet<ApiTraceEntry[]>(page, `/runs/${runId}/trace`);
  expect(new Set(api.map((e) => e.kind))).toEqual(
    new Set(['node_run', 'tool_call', 'verdict', 'approval', 'loop', 'run_event']),
  );
  const entries = tab.locator('[data-testid^="trace-entry-"]');
  await expect(entries).toHaveCount(api.length);
  const shown = await entries.evaluateAll((lis) =>
    lis.map((li) => ({
      seq: Number(li.getAttribute('data-testid')!.replace('trace-entry-', '')),
      kind: li.getAttribute('data-kind'),
    })),
  );
  expect(shown).toEqual(api.map((e) => ({ seq: e.seq, kind: e.kind })));

  // …and the API's order is the event log's: the run's persisted events, ascending seq.
  const logged = await page.evaluate((id) => {
    const db = window.__aceMock!.db;
    db.load();
    return db.events
      .filter((e) => {
        const p = e.payload as {
          runId?: string;
          run?: { id?: string };
          message?: { runId?: string };
        };
        return (
          e.seq !== undefined &&
          e.type !== 'node.token' &&
          (p.runId === id || p.run?.id === id || p.message?.runId === id)
        );
      })
      .map((e) => e.seq!);
  }, runId!);
  expect(shown.map((e) => e.seq)).toEqual(logged);

  // the detail opens
  const first = entries.first();
  await first.getByRole('button').click();
  await expect(first.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
});

test('TC-OBS-004: usage numbers equal GET /usage cell by cell for several groupings', async ({
  page,
}) => {
  await seedUsage(page, 10);
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();

  await expectTableEqualsApi(page, ['provider']);
  await expect(page.getByTestId('usage-key-provider').filter({ hasText: 'Anthropic' })).toHaveCount(
    1,
  );

  await page.getByTestId('usage-group-model').click();
  await page.getByTestId('usage-group-day').click();
  await page.getByTestId('usage-group-provider').click();
  await expectTableEqualsApi(page, ['model', 'day']);

  await page.getByTestId('usage-group-workflow').click();
  await expectTableEqualsApi(page, ['model', 'day', 'workflow']);
  await expect(page.getByTestId('usage-key-workflow').first()).toHaveText('Daily digest');
});

async function openUsageAt380(page: Page) {
  await seedUsage(page, 30);
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/usage');
  await page.getByTestId('usage-preset-30d').click();
  await page.getByTestId('usage-group-day').click();
  await expect(page.locator('[data-testid^="usage-card-"]').first()).toBeVisible();
  await expect(page.getByTestId('usage-table')).toBeHidden();
  await expect(page.getByTestId('bar').first()).toBeVisible();
}

test('NFR-USE-03: the usage screen itself fits 380 px — cards, chart, filters', async ({
  page,
}) => {
  await openUsageAt380(page);
  const fit = await page.getByTestId('usage-page').evaluate((main) => ({
    scroll: main.scrollWidth,
    client: main.clientWidth,
    widest: Math.max(
      ...[...main.querySelectorAll('*')].map((el) => el.getBoundingClientRect().right),
    ),
    viewport: document.documentElement.clientWidth,
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.widest).toBeLessThanOrEqual(fit.viewport);
});

/*
 * Kept red on purpose: at 380 px the shared top bar's trailing icon links (settings, help) end at
 * ~427 px, so the document scrolls sideways although the usage screen fits. The top bar is outside
 * this area's paths; the responsive work (FR-MOB-001) owns it. When it lands, this starts passing
 * and Playwright flags the `test.fail` — remove it then.
 */
test('NFR-USE-03: /usage at 380 px has no horizontal page scroll (top bar overflows)', async ({
  page,
}) => {
  await openUsageAt380(page);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
});

/** WCAG relative luminance and contrast of two `rgb(...)` colours. */
function contrast(a: string, b: string): number {
  const lum = (css: string) => {
    const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [
      number,
      number,
      number,
    ];
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

for (const theme of ['dark', 'light'] as const) {
  test(`D241: usage chart bars keep ≥ 3:1 against the panel in the ${theme} theme`, async ({
    page,
  }) => {
    await seedUsage(page, 7);
    await page.evaluate((t) => {
      const db = window.__aceMock!.db;
      db.load();
      db.patchSettings({ theme: t });
    }, theme);
    await page.goto('/usage');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    for (const mode of ['cost', 'tokens'] as const) {
      await page.getByTestId(`usage-chart-${mode}`).click();
      await expect(page.getByTestId('bar').first()).toBeVisible();
      const colours = await page.getByTestId('usage-chart-panel').evaluate((panel) => ({
        panel: getComputedStyle(panel).backgroundColor,
        bars: [...panel.querySelectorAll('[data-testid="bar"]')].map(
          (bar) => getComputedStyle(bar).fill,
        ),
      }));
      expect(colours.bars.length).toBeGreaterThan(0);
      for (const fill of new Set(colours.bars)) {
        expect(fill).toMatch(/^rgb/);
        expect(contrast(fill, colours.panel), `${fill} on ${colours.panel}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });
}
