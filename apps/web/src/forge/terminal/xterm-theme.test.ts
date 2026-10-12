import { describe, expect, it } from 'vitest';

import { AGENT_COLORS, PAL_D, PAL_L, T } from '../../theme/constants';
import { ACCENT, DANGER, DONE, FORGE_LOOKS } from '../editor/forge-theme';
import { terminalTheme } from './xterm-theme';

/** Every colour the theme already has: the code view's two looks, the palettes, accents and tints. */
const THEME_COLOURS = new Set<string>([
  ...[FORGE_LOOKS.light, FORGE_LOOKS.dark].flatMap((look) =>
    Object.values(look).filter((value): value is string => typeof value === 'string'),
  ),
  ...Object.values(PAL_L),
  ...Object.values(PAL_D),
  ACCENT,
  DANGER,
  DONE,
  ...AGENT_COLORS,
  ...Object.values(T).map(([, accent]) => accent),
]);

describe('D301 D334 xterm in the theme’s colours, as Monaco is', () => {
  it('light: the code view’s surface and ink, the #ef6b3f cursor, the light syntax palette', () => {
    expect(terminalTheme('light')).toMatchObject({
      background: '#ffffff',
      foreground: '#1f1d1b',
      cursor: '#ef6b3f',
      selectionBackground: '#ece7e2',
      red: '#c94c27',
      green: PAL_L.str,
      yellow: PAL_L.type,
      magenta: PAL_L.kw,
      cyan: PAL_L.fn,
      brightBlack: '#6f6a65',
    });
  });

  it('dark: the dark surface and ink, the dark syntax palette', () => {
    expect(terminalTheme('dark')).toMatchObject({
      background: '#181615',
      foreground: '#f2eee9',
      cursor: '#ef6b3f',
      selectionBackground: '#24211f',
      green: PAL_D.str,
      yellow: PAL_D.type,
      magenta: PAL_D.kw,
      cyan: PAL_D.fn,
      brightBlack: '#a39d97',
    });
  });

  it('invents no colour: every value, light and dark, is one the theme already has', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [slot, colour] of Object.entries(terminalTheme(theme))) {
        expect(THEME_COLOURS.has(String(colour)), `${theme} ${slot} ${String(colour)}`).toBe(true);
      }
    }
  });
});
