import css from '../theme.css?raw';
import { THEME_COLORS } from '../tokens.js';

const block = (selector: RegExp): string => {
  const start = css.search(selector);
  return css.slice(start, css.indexOf('}', start));
};

describe('FR-SYS-005 theme.css mirrors tokens.ts', () => {
  const dark = block(/@theme \{/);
  const light = block(/:root\[data-theme='light'\] \{/);
  const slots: Array<[string, keyof typeof THEME_COLORS.dark]> = [
    ['canvas', 'canvas'], ['canvas-dot', 'canvasDot'], ['panel', 'panel'], ['card', 'card'],
    ['sunken', 'sunken'], ['border', 'border'], ['border-strong', 'borderStrong'], ['fg', 'fg'],
    ['fg-soft', 'fgSoft'], ['fg-muted', 'fgMuted'], ['fg-faint', 'fgFaint'], ['accent', 'accent'],
    ['accent-fg', 'accentFg'], ['danger', 'danger'], ['selection', 'selection'],
  ];
  it.each(slots)('--color-%s matches in both themes', (css_, key) => {
    expect(dark).toContain(`--color-${css_}: ${THEME_COLORS.dark[key] as string};`);
    expect(light).toContain(`--color-${css_}: ${THEME_COLORS.light[key] as string};`);
  });
  it('defines the glow and reduced-motion rules', () => {
    expect(css).toMatch(/\.ace-node\[data-state='RUNNING'\]\s*\{\s*--g: 1;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.ace-spin[\s\S]*animation: none/);
  });
});
