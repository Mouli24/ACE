import css from '../theme.css?raw';
import { DATA_TYPES } from '@ace/contracts';

import { INK_COLORS, PORT_COLORS, THEME_COLORS } from '../tokens.js';

const block = (selector: RegExp): string => {
  const start = css.search(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

/** `#fff` → `#ffffff`, lower-case. */
const hex = (value: string): string => {
  const v = value.toLowerCase();
  return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
};

const varValue = (scope: string, name: string): string => {
  const match = scope.match(new RegExp(`--${name}: ([^;]+);`));
  expect(match, `--${name} is defined`).not.toBeNull();
  return hex((match as RegExpMatchArray)[1] as string);
};

/*
 * D328: theme.css carries the Ace UI theme's own variables (workspace light on `:root`, dark under
 * `data-theme="dark"`), the kit's slots point at them, and their values mirror tokens.ts.
 */
describe('D328 theme.css mirrors tokens.ts through the theme variables', () => {
  const kit = block(/@theme static \{/);
  const light = block(/^:root \{/m);
  const dark = block(/^:root\[data-theme='dark'\] \{/m);

  const slots: Array<[string, keyof typeof THEME_COLORS.dark, string]> = [
    ['canvas', 'canvas', 'canvas'],
    ['panel', 'panel', 'panel'],
    ['card', 'card', 'surface'],
    ['sunken', 'sunken', 'canvas'],
    ['border', 'border', 'line'],
    ['border-strong', 'borderStrong', 'iconLine'],
    ['fg', 'fg', 'ink'],
    ['fg-soft', 'fgSoft', 'muted'],
    ['fg-muted', 'fgMuted', 'muted'],
    ['fg-faint', 'fgFaint', 'muted'],
    ['accent', 'accent', 'ink'],
    ['accent-fg', 'accentFg', 'canvas'],
  ];

  it.each(slots)(
    '--color-%s → the theme variable, matching tokens in both themes',
    (slot, key, themeVar) => {
      expect(kit).toContain(`--color-${slot}: var(--${themeVar});`);
      expect(varValue(light, themeVar)).toBe(hex(THEME_COLORS.light[key] as string));
      expect(varValue(dark, themeVar)).toBe(hex(THEME_COLORS.dark[key] as string));
    },
  );

  it('danger and selection are the theme hexes in both themes', () => {
    expect(kit).toContain(`--color-danger: ${THEME_COLORS.light.danger};`);
    expect(kit).toContain(`--color-selection: ${THEME_COLORS.light.selection};`);
    expect(THEME_COLORS.dark.danger).toBe(THEME_COLORS.light.danger);
    expect(THEME_COLORS.dark.selection).toBe(THEME_COLORS.light.selection);
  });

  it('emits every variable, including the ones only built at runtime', () => {
    // `var(--color-provider-${type})` and friends are invisible to Tailwind's class scanner.
    expect(css).toMatch(/@theme static \{/);
    expect(css).not.toMatch(/@theme \{/);
    expect(kit).toContain('--color-provider-mock:');
    expect(kit).toContain('--color-status-IDLE:');
    expect(kit).toContain('--color-provider-status-UNKNOWN:');
  });

  it('carries the workspace variables verbatim from the theme', () => {
    expect(light).toContain('--canvas: #f4f0ec;');
    expect(light).toContain('--glow: rgba(239, 107, 63, 0.07);');
    expect(light).toContain('--frame: rgba(255, 255, 255, 0.45);');
    expect(dark).toContain('--canvas: #0d0c0b;');
    expect(dark).toContain('--dot: rgba(255, 255, 255, 0.07);');
    expect(dark).toContain('color-scheme: dark;');
  });

  it('scopes the Home variables to [data-surface=home], light and dark', () => {
    const home = block(/^\[data-surface='home'\] \{/m);
    const homeDark = block(/^:root\[data-theme='dark'\] \[data-surface='home'\] \{/m);
    expect(home).toContain(
      '--page: linear-gradient(160deg, #fbf3ee 0%, #f5f2f0 40%, #eef0f2 100%);',
    );
    expect(home).toContain('--line: #e9e3dd;');
    expect(homeDark).toContain('--surface: #1d1b1a;');
    expect(homeDark).toContain('--ring6: rgba(255, 255, 255, 0.03);');
  });

  it.each(['flow', 'livePulse', 'orbitA', 'orbitB', 'orbitC', 'pulseRing'])(
    'defines the theme keyframes %s',
    (name) => {
      expect(css).toContain(`@keyframes ${name} {`);
    },
  );
});

/*
 * D332: the Canvas draws its own surface, grid, minimap and edges, so React Flow's are no longer
 * restyled here; what stays is the pane cursor, the port handles (visible since D350) and the
 * edge flow.
 */
describe('D332 the Canvas block', () => {
  it('no longer styles React Flow’s background, minimap or attribution (the Canvas hides it)', () => {
    expect(css).not.toContain('.react-flow__background-pattern');
    expect(css).not.toContain('.react-flow__minimap');
    expect(css).not.toContain('.react-flow__attribution');
  });

  /*
   * D350 (PG-1.1) supersedes D332's invisible 12px handle: the port is a 22px target holding an
   * 8px dot in its data type's colour, hidden at rest and shown on hover, selection, focus and while
   * a line is drawn; an incompatible port is dimmed, never hidden.
   */
  it('PG-1.1 a port is a ≥20px target with an 8px dot, shown on hover, selection and while connecting', () => {
    const port = block(/^\.react-flow__handle\.ace-port \{/m);
    expect(port).toContain('width: 22px;');
    expect(port).toContain('height: 22px;');
    expect(port).toContain('opacity: 0;');
    expect(port).toContain('cursor: crosshair;');
    const dot = block(/^\.react-flow__handle\.ace-port::after,/m);
    expect(dot).toContain('width: 8px;');
    expect(dot).toContain('height: 8px;');
    expect(dot).toContain('background: var(--port-color, #ef6b3f);');
    expect(css).toContain('.react-flow__node.selected .react-flow__handle.ace-port,');
    expect(css).toContain(".react-flow__handle.ace-port[data-connect='compatible'] {");
    expect(block(/^\.react-flow__node:hover \.react-flow__handle\.ace-port,/m)).toContain(
      'opacity: 1;',
    );
    const dimmed = block(
      /^\.react-flow__node \.react-flow__handle\.ace-port\[data-connect='incompatible'\] \{/m,
    );
    expect(dimmed).toContain('opacity: 0.35;');
    const focused = block(/^\.react-flow__handle\.ace-port:focus-visible,/m);
    expect(focused).toContain('opacity: 1;');
    expect(focused).toContain('box-shadow: 0 0 0 2px #ef6b3f;');
  });

  it.each([
    ['danger-ink', 'dangerInk'],
    ['accent-ink', 'accentInk'],
    ['ok-ink', 'okInk'],
    ['accent-strong', 'accentStrong'],
  ] as const)('PG-1.2 --%s mirrors INK_COLORS in both themes', (name, key) => {
    expect(varValue(block(/^:root \{/m), name)).toBe(INK_COLORS.light[key]);
    expect(varValue(block(/^:root\[data-theme='dark'\] \{/m), name)).toBe(INK_COLORS.dark[key]);
  });

  it('PG-1.2 links are drawn in the AA accent ink', () => {
    expect(css).toMatch(/ {2}a \{\n {4}color: var\(--accent-ink\);/);
  });

  it('audit U-18 the page behind the app is the theme’s canvas, light or dark', () => {
    expect(css).toMatch(/ {2}html,\n {2}body \{\n {4}background-color: var\(--canvas\);/);
    expect(css).toMatch(
      /:root\[data-theme='dark'\] body:has\(\[data-surface='home'\]\) \{\n {4}background-color: #151413;/,
    );
  });

  it.each(DATA_TYPES)('PG-1.1 --port-%s mirrors PORT_COLORS in both themes', (type) => {
    const light = block(/^:root \{/m);
    const dark = block(/^:root\[data-theme='dark'\] \{/m);
    expect(varValue(light, `port-${type}`)).toBe(PORT_COLORS.light[type]);
    expect(varValue(dark, `port-${type}`)).toBe(PORT_COLORS.dark[type]);
  });

  it('an edge line flows with the theme’s keyframes, and stands still for reduced motion', () => {
    expect(block(/^\.ace-edge-flow \{/m)).toContain('animation: flow 1.2s linear infinite;');
    const reduced = css.slice(css.search(/@media \(prefers-reduced-motion: reduce\)/));
    expect(reduced).toContain('.ace-edge-flow');
  });

  it('the loading placeholder is the canvas with the theme’s dot grid at zoom 1', () => {
    const dotted = block(/^\.ace-dotted-canvas \{/m);
    expect(dotted).toContain('background-color: var(--canvas);');
    expect(dotted).toContain('radial-gradient(var(--dot) 1px, transparent 1.3px)');
    expect(dotted).toContain('background-size: 16px 16px;');
  });
});
