import type { NodeState, ProviderState, ProviderType } from '@ace/contracts';

/**
 * ACE design tokens (Arch §10.1 design system, CLAUDE.md §2): the Night (dark) and Paper (light) themes over a dotted Canvas, one accent
 * colour per provider, one status-ring colour per NodeState, serif for human text and monospace
 * for machine text. Night and Paper are the POC Theme V2 palettes (D241 added the light theme; theme-v2
 * restyled both). `theme.css` mirrors these values as Tailwind `@theme` variables; the contrast
 * test in `__tests__/tokens.test.ts` keeps every pair at WCAG AA (NFR-USE-02).
 */

export const PROVIDER_ACCENT: Readonly<Record<ProviderType, string>> = {
  anthropic: '#e8734a',
  google: '#ec4899',
  openai: '#2dd4bf',
  openai_compatible: '#a78bfa',
  ollama: '#e8e8ea',
  mock: '#9a99a3',
};

export const STATUS_RING: Readonly<Record<NodeState, string>> = {
  IDLE: '#7c7c84',
  READY: '#93a8ff',
  RUNNING: '#5cc8ff',
  WAITING: '#f5c542',
  COMPLETED: '#34d399',
  PAUSED: '#c8b56a',
  STOPPED: '#b8b5ae',
  BLOCKED: '#f59e0b',
  FAILED: '#f0563f',
};

/**
 * One colour per `ProviderState` (round 2 §5 step 2). A provider's state is about reachability, so
 * the scale is deliberately not the node-state scale: CONNECTED is green, the three fault states
 * are warm, and UNKNOWN/CHECKING stay neutral so an unchecked provider never reads as broken.
 */
export const PROVIDER_STATUS: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: '#8f8c95',
  CHECKING: '#93a8ff',
  CONNECTED: '#34d399',
  AUTH_FAILED: '#f0563f',
  UNREACHABLE: '#f59e0b',
  RATE_LIMITED: '#f5c542',
};

/*
 * The light theme (D241, FR-SYS-005). The same semantic slots as the dark set below, stepped for a
 * light surface (Paper): text ≥ 4.5:1, and every provider, status and provider-status colour is
 * ≥ 4.5:1 on the card, panel and canvas in BOTH themes, because they double as text (JsonTree's
 * string/number colours, badges, StatusChip labels; NFR-USE-02). The Paper values are the design's
 * hues stepped darker until they pass; Night keeps the design's values except IDLE, which is
 * nudged lighter. `theme.css` applies these under `:root[data-theme="light"]`.
 */
export const LIGHT_PROVIDER_ACCENT: Readonly<Record<ProviderType, string>> = {
  anthropic: '#b04c27',
  google: '#c22d74',
  openai: '#0b786a',
  openai_compatible: '#7446d8',
  ollama: '#3a3a40',
  mock: '#6b6972',
};

export const LIGHT_STATUS_RING: Readonly<Record<NodeState, string>> = {
  IDLE: '#6b6970',
  READY: '#3b5bdb',
  RUNNING: '#0970a8',
  WAITING: '#886509',
  COMPLETED: '#117954',
  PAUSED: '#7b6924',
  STOPPED: '#6b6972',
  BLOCKED: '#a15800',
  FAILED: '#c13a27',
};

export const LIGHT_PROVIDER_STATUS: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: '#6b6972',
  CHECKING: '#3b5bdb',
  CONNECTED: '#117954',
  AUTH_FAILED: '#c13a27',
  UNREACHABLE: '#a15800',
  RATE_LIMITED: '#886509',
};

/**
 * Categorical series colours for charts (FR-OBS-004), in fixed order — a series keeps its slot,
 * never its rank. Each theme has its own step of the same eight hues, every one ≥ 3:1 against that
 * theme's panel (WCAG 1.4.11). `theme.css` exposes them as `--color-chart-1..8`; components use
 * {@link chartSeriesColor} so the swap happens in CSS.
 */
export const CHART_SERIES_COLORS = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#2f9e2f', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#d4531f', '#0f8a5f', '#b07800', '#c2457a', '#008300', '#4a3aa7', '#d63b3a'],
} as const satisfies Record<'dark' | 'light', readonly string[]>;

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

const lightColor: Readonly<ThemeColors> = {
  canvas: '#f3f1ec',
  canvasDot: '#d6d2c9',
  panel: '#eeebe5',
  card: '#fbfaf7',
  sunken: '#e9e5de',
  border: '#dcd8d0',
  borderStrong: '#c4c0b8',
  fg: '#1b1a1e',
  fgSoft: '#46444c',
  fgMuted: '#66646d',
  fgFaint: '#6b696f',
  accent: '#1b1a1e',
  accentFg: '#fbfaf7',
  danger: '#c13a27',
  selection: '#7446d8',
  provider: LIGHT_PROVIDER_ACCENT,
  status: LIGHT_STATUS_RING,
  providerStatus: LIGHT_PROVIDER_STATUS,
};

export const tokens = {
  color: {
    canvas: '#0a0a0b',
    canvasDot: '#1f1f23',
    panel: '#0e0e10',
    card: '#111113',
    sunken: '#08080a',
    border: '#232327',
    borderStrong: '#34343a',
    fg: '#f6f5f2',
    fgSoft: '#b8b5ae',
    fgMuted: '#8f8c95',
    fgFaint: '#7d7c82',
    accent: '#f6f5f2',
    accentFg: '#0a0a0b',
    danger: '#f0563f',
    selection: '#c4b5fd',
    provider: PROVIDER_ACCENT,
    status: STATUS_RING,
    providerStatus: PROVIDER_STATUS,
    /** The light theme's values for the same slots (D241). */
    light: lightColor,
  },
  font: {
    human: '"Newsreader Variable", "Newsreader", "Iowan Old Style", Georgia, serif',
    machine: '"JetBrains Mono Variable", "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  },
  radius: { card: '14px', field: '10px', chip: '999px' },
  canvas: { dotGap: 20, dotSize: 1.1 },
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
