import { NODE_STATES, PROVIDER_STATES, PROVIDER_TYPES } from '@ace/contracts';

import {
  CHART_SERIES_COLORS,
  THEME_COLORS,
  chartSeriesColor,
  contrastRatio,
  relativeLuminance,
  tokens,
} from '../tokens.js';

/**
 * NFR-USE-02: text contrast meets WCAG AA. 4.5:1 for body text, 3:1 for large text and for
 * non-text UI markers (borders, rings) against the surface they sit on.
 */
describe('NFR-USE-02 design tokens meet WCAG AA', () => {
  const textPairs: Array<[string, string, string]> = [
    ['fg on canvas', tokens.color.fg, tokens.color.canvas],
    ['fg on panel', tokens.color.fg, tokens.color.panel],
    ['fg on card', tokens.color.fg, tokens.color.card],
    ['muted fg on panel', tokens.color.fgMuted, tokens.color.panel],
    ['muted fg on card', tokens.color.fgMuted, tokens.color.card],
    ['danger on panel', tokens.color.danger, tokens.color.panel],
    ['accent fg on accent', tokens.color.accentFg, tokens.color.accent],
  ];

  it.each(textPairs)('%s ≥ 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PROVIDER_TYPES)('provider accent %s ≥ 3:1 against the card', (provider) => {
    expect(
      contrastRatio(tokens.color.provider[provider], tokens.color.card),
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(NODE_STATES)('status ring %s ≥ 3:1 against the card', (state) => {
    expect(contrastRatio(tokens.color.status[state], tokens.color.card)).toBeGreaterThanOrEqual(3);
  });

  it.each(PROVIDER_STATES)('provider status %s ≥ 3:1 against the panel', (state) => {
    expect(
      contrastRatio(tokens.color.providerStatus[state], tokens.color.panel),
    ).toBeGreaterThanOrEqual(3);
  });

  it('has one status colour per NodeState and one accent per ProviderType', () => {
    expect(Object.keys(tokens.color.status).sort()).toEqual([...NODE_STATES].sort());
    expect(Object.keys(tokens.color.provider).sort()).toEqual([...PROVIDER_TYPES].sort());
    expect(Object.keys(tokens.color.providerStatus).sort()).toEqual([...PROVIDER_STATES].sort());
  });

  it('names a serif face for human text and a monospace face for machine text', () => {
    expect(tokens.font.human).toMatch(/serif/i);
    expect(tokens.font.machine).toMatch(/mono/i);
  });

  it('canvas dot is visible but subtle against the canvas', () => {
    const ratio = contrastRatio(tokens.color.canvasDot, tokens.color.canvas);
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(3);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#123456', '#123456')).toBe(1);
  });
});

/**
 * FR-SYS-005, D241: the light theme carries the same contrast guarantees as the dark one, and both
 * themes define every slot. NFR-USE-02's thresholds: 4.5:1 for text, 3:1 for UI and graphics.
 */
describe('FR-SYS-005 both themes meet WCAG AA', () => {
  describe.each(['dark', 'light'] as const)('%s theme', (theme) => {
    const c = THEME_COLORS[theme];

    it.each([
      ['fg on canvas', c.fg, c.canvas],
      ['fg on panel', c.fg, c.panel],
      ['fg on card', c.fg, c.card],
      ['muted fg on canvas', c.fgMuted, c.canvas],
      ['muted fg on panel', c.fgMuted, c.panel],
      ['muted fg on card', c.fgMuted, c.card],
      ['danger on panel', c.danger, c.panel],
      ['accent fg on accent', c.accentFg, c.accent],
      ['canvas on danger (destructive button)', c.canvas, c.danger],
    ])('text: %s ≥ 4.5:1', (_label, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ['soft fg on card', c.fgSoft, c.card],
      ['soft fg on panel', c.fgSoft, c.panel],
      ['faint fg on card', c.fgFaint, c.card],
      ['faint fg on panel', c.fgFaint, c.panel],
      ['faint fg on canvas', c.fgFaint, c.canvas],
      ['fg on sunken', c.fg, c.sunken],
      ['muted fg on sunken', c.fgMuted, c.sunken],
    ])('text: %s ≥ 4.5:1', (_label, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it('border-strong is a step above border on the card', () => {
      expect(contrastRatio(c.borderStrong, c.card)).toBeGreaterThan(contrastRatio(c.border, c.card));
    });

    it.each([
      ...NODE_STATES.map((s) => [`status ${s}`, c.status[s]] as const),
      ...PROVIDER_TYPES.map((p) => [`provider ${p}`, c.provider[p]] as const),
      ...PROVIDER_STATES.map((s) => [`provider status ${s}`, c.providerStatus[s]] as const),
    ])('NFR-USE-02 %s doubles as text: ≥ 4.5:1 on card, panel and canvas', (_label, hex) => {
      expect(contrastRatio(hex, c.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, c.canvas)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(PROVIDER_TYPES)('provider accent %s ≥ 3:1 on the card', (p) => {
      expect(contrastRatio(c.provider[p], c.card)).toBeGreaterThanOrEqual(3);
    });

    it.each(NODE_STATES)('status ring %s ≥ 3:1 on the card and the canvas', (s) => {
      expect(contrastRatio(c.status[s], c.card)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.status[s], c.canvas)).toBeGreaterThanOrEqual(3);
    });

    it.each(PROVIDER_STATES)('provider status %s ≥ 3:1 on the panel', (s) => {
      expect(contrastRatio(c.providerStatus[s], c.panel)).toBeGreaterThanOrEqual(3);
    });

    it('selection ≥ 3:1 on the canvas', () => {
      expect(contrastRatio(c.selection, c.canvas)).toBeGreaterThanOrEqual(3);
    });

    it('dotted canvas stays visible but subtle', () => {
      const ratio = contrastRatio(c.canvasDot, c.canvas);
      expect(ratio).toBeGreaterThan(1.2);
      expect(ratio).toBeLessThan(3);
    });

    it.each(CHART_SERIES_COLORS[theme].map((hex, i) => [i + 1, hex] as const))(
      'FR-OBS-004 chart series %i (%s) ≥ 3:1 on the panel',
      (_slot, hex) => {
        expect(contrastRatio(hex, c.panel)).toBeGreaterThanOrEqual(3);
      },
    );
  });

  it('defines every slot in both themes, and the dark set is the default tokens', () => {
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
