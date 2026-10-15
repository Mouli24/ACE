import { NODE_STATES, PROVIDER_STATES, PROVIDER_TYPES } from '@ace/contracts';

import {
  CHART_SERIES_COLORS,
  INK_COLORS,
  PORT_COLORS,
  THEME_COLORS,
  chartSeriesColor,
  contrastRatio,
  relativeLuminance,
  tokens,
} from '../tokens.js';

/*
 * NFR-USE-02 and D328. The palette is the Ace UI theme's, copied exactly. Text and surface pairs
 * still meet WCAG AA (4.5:1). A few theme colours measure lower and the theme wins (D328); for
 * those the floor below is the measured one, so a later change cannot quietly make them worse:
 *   - `#c94c27` (destructive): 4.31 on the light panel, 4.07 on the dark panel, 3.90 on the dark card;
 *   - the status / provider hues used as text (`#2f9e63`, `#1f97a3`, `#e8572e`, `#c2603f`):
 *     down to 2.99 (`#2f9e63` on the light canvas);
 *   - `#ef6b3f` as the focus/selection colour on the light canvas: 2.71;
 *   - the dark dot grid (`rgba(255,255,255,0.07)`) against the dark canvas: 1.15.
 */
const DESTRUCTIVE_FLOOR = 3.9;
const COLOURED_TEXT_FLOOR = 2.9;
const SELECTION_FLOOR = 2.7;

describe('NFR-USE-02 design tokens (D328 palette)', () => {
  it.each([
    ['fg on canvas', tokens.color.fg, tokens.color.canvas],
    ['fg on panel', tokens.color.fg, tokens.color.panel],
    ['fg on card', tokens.color.fg, tokens.color.card],
    ['muted fg on panel', tokens.color.fgMuted, tokens.color.panel],
    ['muted fg on card', tokens.color.fgMuted, tokens.color.card],
    ['accent fg on accent', tokens.color.accentFg, tokens.color.accent],
  ])('%s ≥ 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('has one status colour per NodeState and one accent per ProviderType', () => {
    expect(Object.keys(tokens.color.status).sort()).toEqual([...NODE_STATES].sort());
    expect(Object.keys(tokens.color.provider).sort()).toEqual([...PROVIDER_TYPES].sort());
    expect(Object.keys(tokens.color.providerStatus).sort()).toEqual([...PROVIDER_STATES].sort());
  });

  it('names Plus Jakarta Sans for human text and JetBrains Mono for machine text', () => {
    expect(tokens.font.human).toMatch(/^'Plus Jakarta Sans'/);
    expect(tokens.font.machine).toMatch(/^'JetBrains Mono'/);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#123456', '#123456')).toBe(1);
  });
});

describe('FR-SYS-005 both themes define every slot and keep text readable', () => {
  describe.each(['dark', 'light'] as const)('%s theme', (theme) => {
    const c = THEME_COLORS[theme];

    it.each([
      ['fg on canvas', c.fg, c.canvas],
      ['fg on panel', c.fg, c.panel],
      ['fg on card', c.fg, c.card],
      ['muted fg on canvas', c.fgMuted, c.canvas],
      ['muted fg on panel', c.fgMuted, c.panel],
      ['muted fg on card', c.fgMuted, c.card],
      ['soft fg on card', c.fgSoft, c.card],
      ['faint fg on canvas', c.fgFaint, c.canvas],
      ['accent fg on accent', c.accentFg, c.accent],
      ['fg on sunken', c.fg, c.sunken],
      ['muted fg on sunken', c.fgMuted, c.sunken],
    ])('text: %s ≥ 4.5:1', (_label, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ['danger on panel', c.danger, c.panel],
      ['danger on card', c.danger, c.card],
      ['canvas on danger (destructive button)', c.canvas, c.danger],
    ])(`D328 theme destructive: %s ≥ ${DESTRUCTIVE_FLOOR}:1`, (_label, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(DESTRUCTIVE_FLOOR);
    });

    it('border-strong is a step above border on the card', () => {
      expect(contrastRatio(c.borderStrong, c.card)).toBeGreaterThan(
        contrastRatio(c.border, c.card),
      );
    });

    it.each([
      ...NODE_STATES.map((s) => [`status ${s}`, c.status[s]] as const),
      ...PROVIDER_TYPES.map((p) => [`provider ${p}`, c.provider[p]] as const),
      ...PROVIDER_STATES.map((s) => [`provider status ${s}`, c.providerStatus[s]] as const),
    ])(`D328 %s as text: ≥ ${COLOURED_TEXT_FLOOR}:1 on card, panel and canvas`, (_label, hex) => {
      expect(contrastRatio(hex, c.card)).toBeGreaterThanOrEqual(COLOURED_TEXT_FLOOR);
      expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(COLOURED_TEXT_FLOOR);
      expect(contrastRatio(hex, c.canvas)).toBeGreaterThanOrEqual(COLOURED_TEXT_FLOOR);
    });

    it.each(PROVIDER_TYPES)('provider accent %s ≥ 3:1 on the card', (p) => {
      expect(contrastRatio(c.provider[p], c.card)).toBeGreaterThanOrEqual(3);
    });

    it.each(PROVIDER_STATES)('provider status %s ≥ 3:1 on the panel', (s) => {
      expect(contrastRatio(c.providerStatus[s], c.panel)).toBeGreaterThanOrEqual(3);
    });

    it(`D328 selection (#ef6b3f) ≥ ${SELECTION_FLOOR}:1 on the canvas`, () => {
      expect(contrastRatio(c.selection, c.canvas)).toBeGreaterThanOrEqual(SELECTION_FLOOR);
    });

    it('dotted canvas stays visible but subtle', () => {
      const ratio = contrastRatio(c.canvasDot, c.canvas);
      expect(ratio).toBeGreaterThan(1.1);
      expect(ratio).toBeLessThan(3);
    });

    // PG-1.2 (D360): what carries meaning as text meets AA (4.5:1) on card, panel and canvas —
    // stronger than the D328 floors above, which now cover the theme hues as decoration only.
    it.each([
      ['danger ink', INK_COLORS[theme].dangerInk],
      ['accent ink (links, running)', INK_COLORS[theme].accentInk],
      ['ok ink (complete)', INK_COLORS[theme].okInk],
    ])('PG-1.2 %s (%s) ≥ 4.5:1 on card, panel and canvas', (_label, hex) => {
      expect(contrastRatio(hex, c.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, c.canvas)).toBeGreaterThanOrEqual(4.5);
    });

    it('PG-1.2 white on --accent-strong (pressed tool, checked box) ≥ 4.5:1', () => {
      expect(contrastRatio('#ffffff', INK_COLORS[theme].accentStrong)).toBeGreaterThanOrEqual(4.5);
    });

    it('PG-1.2 muted text ≥ 4.5:1 even on the accent tint (rgba(239,107,63,0.10) over the panel)', () => {
      // the Split toggle's pressed fill, composited: #f9e8e1 light; the dark tint is darker still
      const tint = theme === 'light' ? '#f9e8e1' : '#271813';
      expect(contrastRatio(c.fgMuted, tint)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(Object.entries(PORT_COLORS[theme]))(
      'PG-1.1 port dot %s (%s) ≥ 3:1 on card, panel and canvas',
      (_type, hex) => {
        expect(contrastRatio(hex, c.card)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(hex, c.canvas)).toBeGreaterThanOrEqual(3);
      },
    );

    it.each(CHART_SERIES_COLORS[theme].map((hex, i) => [i + 1, hex] as const))(
      'FR-OBS-004 chart series %i (%s) ≥ 3:1 on the panel',
      (_slot, hex) => {
        expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(3);
      },
    );
  });

  it('defines every slot in both themes, and light is the bright default', () => {
    expect(Object.keys(THEME_COLORS.light).sort()).toEqual(Object.keys(THEME_COLORS.dark).sort());
    expect(Object.keys(THEME_COLORS.light.status).sort()).toEqual([...NODE_STATES].sort());
    expect(Object.keys(THEME_COLORS.light.provider).sort()).toEqual([...PROVIDER_TYPES].sort());
    expect(Object.keys(THEME_COLORS.light.providerStatus).sort()).toEqual(
      [...PROVIDER_STATES].sort(),
    );
    expect(THEME_COLORS.dark.canvas).toBe(tokens.color.canvas);
    expect(tokens.color.light).toBe(THEME_COLORS.light);
    expect(relativeLuminance(THEME_COLORS.light.canvas)).toBeGreaterThan(0.8);
  });

  it('both chart palettes have the same number of slots, and chartSeriesColor wraps', () => {
    expect(CHART_SERIES_COLORS.light).toHaveLength(CHART_SERIES_COLORS.dark.length);
    expect(chartSeriesColor(0)).toBe('var(--color-chart-1)');
    expect(chartSeriesColor(CHART_SERIES_COLORS.dark.length)).toBe('var(--color-chart-1)');
    expect(chartSeriesColor(-1)).toBe(`var(--color-chart-${CHART_SERIES_COLORS.dark.length})`);
  });
});
