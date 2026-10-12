import type { ITheme } from '@xterm/xterm';

import { AGENT_COLORS, T } from '../../theme/constants';
import { ACCENT, DANGER, DONE, FORGE_LOOKS } from '../editor/forge-theme';

/**
 * xterm in the theme's code view (D301, D334), coloured the way `forge-theme.ts` colours Monaco:
 * the surface, ink, muted and hover of the light or dark look, the `#ef6b3f` cursor, and the ANSI
 * colours from the theme's syntax palette (`PAL_L` / `PAL_D`), its accents and its tints. No colour
 * here is new: `xterm-theme.test.ts` checks every value against the theme's own.
 */
export function terminalTheme(theme: 'light' | 'dark'): ITheme {
  const look = FORGE_LOOKS[theme];
  const { pal } = look;
  const dark = theme === 'dark';
  return {
    background: look.surface,
    foreground: look.ink,
    cursor: ACCENT,
    cursorAccent: look.surface,
    // Monaco's selection; xterm blends an opaque selection colour over the text itself.
    selectionBackground: look.hover,
    // Black must stay readable on the dark surface; white on the light one.
    black: dark ? look.iconLine : look.ink,
    brightBlack: look.muted,
    red: DANGER,
    brightRed: ACCENT,
    green: pal.str,
    brightGreen: DONE,
    yellow: pal.type,
    brightYellow: T.amber[1],
    blue: T.blue[1],
    brightBlue: T.blue[1],
    magenta: pal.kw,
    brightMagenta: AGENT_COLORS[1],
    cyan: pal.fn,
    brightCyan: AGENT_COLORS[2],
    white: dark ? look.ink : look.muted,
    brightWhite: look.ink,
  };
}
