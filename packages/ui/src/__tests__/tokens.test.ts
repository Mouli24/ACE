import { NODE_STATES, PROVIDER_TYPES } from '@ace/contracts';

import { contrastRatio, tokens } from '../tokens.js';

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

  it('has one status colour per NodeState and one accent per ProviderType', () => {
    expect(Object.keys(tokens.color.status).sort()).toEqual([...NODE_STATES].sort());
    expect(Object.keys(tokens.color.provider).sort()).toEqual([...PROVIDER_TYPES].sort());
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
