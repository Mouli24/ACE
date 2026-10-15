import type { DataType, NodeState, ProviderState, ProviderType } from '@ace/contracts';

/**
 * ACE design tokens (Arch §10.1 design system, CLAUDE.md §2), in the Ace UI theme's palette (D328):
 * warm neutrals, ink and muted text, the orange accent `#ef6b3f`, Plus Jakarta Sans for human text
 * and JetBrains Mono for machine text. `theme.css` defines the theme's own variables (`--canvas`,
 * `--ink`, `--line`, …) with these values and points the kit's semantic slots (`--color-card`, …)
 * at them; the contrast test in `__tests__/tokens.test.ts` records what each pair measures.
 *
 * Light is the default theme; `tokens.color` keeps the dark set at the top level (its historical
 * place) with the light set under `tokens.color.light`.
 */

/** Provider colours: the theme's provider ink per look (`th().ink`), dark. Custom reads as ink. */
export const PROVIDER_ACCENT: Readonly<Record<ProviderType, string>> = {
  anthropic: '#c2603f',
  google: '#8fb0ff',
  openai: '#2fe08a',
  openai_compatible: '#f2eee9',
  ollama: '#f2eee9',
  mock: '#f2eee9',
  claude_code: '#c2603f',
  codex_cli: '#2fe08a',
  gemini_cli: '#8fb0ff',
};

/**
 * Node-state colours (PG-4.2, D360): one per state, no two alike — idle grey, ready teal, running
 * orange, waiting violet, done green, paused amber, stopped slate, blocked plum, failed red — each
 * ≥ 4.5:1 on its theme's card, panel, canvas and hover fill, so the state word reads in its colour.
 * D328's hues kept where they passed; the rest shifted to pass. Dark set here, light below.
 */
export const STATUS_RING: Readonly<Record<NodeState, string>> = {
  IDLE: '#a39d97',
  READY: '#4fc3cc',
  RUNNING: '#f08a5d',
  WAITING: '#a996f0',
  COMPLETED: '#4cc283',
  PAUSED: '#e0b040',
  STOPPED: '#8fa6c8',
  BLOCKED: '#e07ab0',
  FAILED: '#ff6b6b',
};

/**
 * One colour per `ProviderState` (round 2 §5 step 2). A provider's state is about reachability, so
 * the scale is deliberately not the node-state scale: CONNECTED is green, the fault states are
 * warm, and UNKNOWN stays neutral so an unchecked provider never reads as broken.
 */
export const PROVIDER_STATUS: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: '#a39d97',
  CHECKING: '#1f97a3',
  CONNECTED: '#2f9e63',
  AUTH_FAILED: '#c94c27',
  UNREACHABLE: '#e8572e',
  RATE_LIMITED: '#7a62d6',
};

/** The light theme's values for the same slots. */
export const LIGHT_PROVIDER_ACCENT: Readonly<Record<ProviderType, string>> = {
  anthropic: '#c2603f',
  google: '#1d4fe0',
  openai: '#0a8048',
  openai_compatible: '#1f1d1b',
  ollama: '#1f1d1b',
  mock: '#1f1d1b',
  claude_code: '#c2603f',
  codex_cli: '#0a8048',
  gemini_cli: '#1d4fe0',
};

export const LIGHT_STATUS_RING: Readonly<Record<NodeState, string>> = {
  IDLE: '#6b6661',
  READY: '#0b6e77',
  RUNNING: '#b4441b',
  WAITING: '#6d52cc',
  COMPLETED: '#1a6b3f',
  PAUSED: '#8a5a00',
  STOPPED: '#4a5d7a',
  BLOCKED: '#9b3a72',
  FAILED: '#c0262d',
};

export const LIGHT_PROVIDER_STATUS: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: '#6f6a65',
  CHECKING: '#1f97a3',
  CONNECTED: '#2f9e63',
  AUTH_FAILED: '#c94c27',
  UNREACHABLE: '#e8572e',
  RATE_LIMITED: '#7a62d6',
};

/**
 * Categorical series colours for charts (FR-OBS-004), in fixed order — a series keeps its slot,
 * never its rank. All eight are theme hues (the agent colours, then the Home tints) and each is
 * ≥ 3:1 against both themes' panel (WCAG 1.4.11). `theme.css` exposes them as
 * `--color-chart-1..8`; components use {@link chartSeriesColor}.
 */
export const CHART_SERIES_COLORS = {
  dark: ['#e8572e', '#7a62d6', '#1f97a3', '#2f9e63', '#5b7fe0', '#d94a6b', '#b27408', '#6c55c8'],
  light: ['#e8572e', '#7a62d6', '#1f97a3', '#2f9e63', '#5b7fe0', '#d94a6b', '#b27408', '#6c55c8'],
} as const satisfies Record<'dark' | 'light', readonly string[]>;

/**
 * PG-1.2 (D360): D328's accents where they carry meaning as text or under a white icon, shifted to
 * WCAG AA in both themes (`theme.css`: `--danger-ink`, `--accent-ink`, `--ok-ink`,
 * `--accent-strong`). The theme hues (#c94c27, #ef6b3f, #e8572e, #2f9e63) stay as decoration —
 * fills, dots, borders — where the floors in `tokens.test.ts` still apply.
 */
export const INK_COLORS = {
  light: { dangerInk: '#b23f1d', accentInk: '#b4441b', okInk: '#1a6b3f', accentStrong: '#c2410c' },
  dark: { dangerInk: '#ef7a5a', accentInk: '#f08a5d', okInk: '#4cc283', accentStrong: '#c2410c' },
} as const;

/**
 * PG-1.1 (D350): a port dot's colour comes from its data type. Each is ≥ 3:1 against the card,
 * the panel and the canvas of its theme (WCAG 1.4.11, non-text), so a dot reads on any surface it
 * sits on. `theme.css` exposes them as `--port-<type>`.
 */
export const PORT_COLORS = {
  light: {
    text: '#c2410c',
    image: '#6d52cc',
    audio: '#0e7c86',
    video: '#be3a74',
    code: '#2f7d4f',
    json: '#946200',
    file: '#5b6675',
  },
  dark: {
    text: '#f08a5d',
    image: '#a996f0',
    audio: '#4fc3cc',
    video: '#e27aa8',
    code: '#5fcf8c',
    json: '#e0b040',
    file: '#a3adba',
  },
} as const satisfies Record<'dark' | 'light', Readonly<Record<DataType, string>>>;

/** The CSS colour for series slot `index` (0-based), following the active theme. */
export function chartSeriesColor(index: number): string {
  const slot =
    (((index % CHART_SERIES_COLORS.dark.length) + CHART_SERIES_COLORS.dark.length) %
      CHART_SERIES_COLORS.dark.length) +
    1;
  return `var(--color-chart-${slot})`;
}

/** The semantic colour slots one theme defines. */
export interface ThemeColors {
  canvas: string;
  canvasDot: string;
  panel: string;
  card: string;
  sunken: string;
  border: string;
  borderStrong: string;
  fg: string;
  fgSoft: string;
  fgMuted: string;
  fgFaint: string;
  accent: string;
  accentFg: string;
  danger: string;
  selection: string;
  provider: Readonly<Record<ProviderType, string>>;
  status: Readonly<Record<NodeState, string>>;
  providerStatus: Readonly<Record<ProviderState, string>>;
}

/**
 * Light (the default): the workspace set of `Ace Canvas.dc.html`. `canvasDot` is `--dot`
 * (rgba(80,70,60,0.16)) composited over the canvas, so it can be measured.
 */
const lightColor: Readonly<ThemeColors> = {
  canvas: '#f4f0ec',
  canvasDot: '#dad5d0',
  panel: '#faf7f4',
  card: '#ffffff',
  sunken: '#f4f0ec',
  border: '#e6e0da',
  borderStrong: '#cfc9c3',
  fg: '#1f1d1b',
  fgSoft: '#6b6661',
  fgMuted: '#6b6661',
  fgFaint: '#6b6661',
  accent: '#1f1d1b',
  accentFg: '#f4f0ec',
  danger: '#c94c27',
  selection: '#ef6b3f',
  provider: LIGHT_PROVIDER_ACCENT,
  status: LIGHT_STATUS_RING,
  providerStatus: LIGHT_PROVIDER_STATUS,
};

export const tokens = {
  color: {
    canvas: '#0d0c0b',
    /** `--dot` (rgba(255,255,255,0.07)) composited over the dark canvas. */
    canvasDot: '#1e1d1c',
    panel: '#121110',
    card: '#181615',
    sunken: '#0d0c0b',
    border: '#2a2725',
    borderStrong: '#4a4541',
    fg: '#f2eee9',
    fgSoft: '#a39d97',
    fgMuted: '#a39d97',
    fgFaint: '#a39d97',
    accent: '#f2eee9',
    accentFg: '#0d0c0b',
    danger: '#c94c27',
    selection: '#ef6b3f',
    provider: PROVIDER_ACCENT,
    status: STATUS_RING,
    providerStatus: PROVIDER_STATUS,
    /** The light theme's values for the same slots (the default theme). */
    light: lightColor,
  },
  font: {
    human: "'Plus Jakarta Sans', system-ui, sans-serif",
    machine: "'JetBrains Mono', monospace",
  },
  radius: { card: '12px', field: '9px', chip: '999px' },
  canvas: { dotGap: 16, dotSize: 1 },
} as const;

export type Tokens = typeof tokens;

/** Both themes' colour sets, keyed by the theme `data-theme` names. */
export const THEME_COLORS: Readonly<Record<'dark' | 'light', ThemeColors>> = {
  dark: {
    canvas: tokens.color.canvas,
    canvasDot: tokens.color.canvasDot,
    panel: tokens.color.panel,
    card: tokens.color.card,
    sunken: tokens.color.sunken,
    border: tokens.color.border,
    borderStrong: tokens.color.borderStrong,
    fg: tokens.color.fg,
    fgSoft: tokens.color.fgSoft,
    fgMuted: tokens.color.fgMuted,
    fgFaint: tokens.color.fgFaint,
    accent: tokens.color.accent,
    accentFg: tokens.color.accentFg,
    danger: tokens.color.danger,
    selection: tokens.color.selection,
    provider: PROVIDER_ACCENT,
    status: STATUS_RING,
    providerStatus: PROVIDER_STATUS,
  },
  light: lightColor,
};

/* ---------------------------------------------------------------------------- */
/* WCAG contrast (used by the tokens test and available to consumers)            */
/* ---------------------------------------------------------------------------- */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}
