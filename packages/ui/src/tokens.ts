import type { NodeState, ProviderState, ProviderType } from '@ace/contracts';

/**
 * ACE design tokens (Arch §10.1 design system, CLAUDE.md §2): a dark dotted Canvas, one accent
 * colour per provider, one status-ring colour per NodeState, serif for human text and monospace
 * for machine text. `theme.css` mirrors these values as Tailwind `@theme` variables; the contrast
 * test in `__tests__/tokens.test.ts` keeps every pair at WCAG AA (NFR-USE-02).
 */

export const PROVIDER_ACCENT: Readonly<Record<ProviderType, string>> = {
  anthropic: '#e0955f',
  google: '#6ea8ff',
  openai: '#5ed3a5',
  openai_compatible: '#b59cff',
  ollama: '#e8e2d6',
  mock: '#9aa3ad',
};

export const STATUS_RING: Readonly<Record<NodeState, string>> = {
  IDLE: '#7d8590',
  READY: '#8fb3ff',
  RUNNING: '#5cc8ff',
  WAITING: '#f2c94c',
  COMPLETED: '#4ade80',
  PAUSED: '#c8b56a',
  STOPPED: '#b0b8c1',
  BLOCKED: '#f59e0b',
  FAILED: '#f87171',
};

/**
 * One colour per `ProviderState` (round 2 §5 step 2). A provider's state is about reachability, so
 * the scale is deliberately not the node-state scale: CONNECTED is green, the three fault states
 * are warm, and UNKNOWN/CHECKING stay neutral so an unchecked provider never reads as broken.
 */
export const PROVIDER_STATUS: Readonly<Record<ProviderState, string>> = {
  UNKNOWN: '#9da7b3',
  CHECKING: '#8fb3ff',
  CONNECTED: '#4ade80',
  AUTH_FAILED: '#ff8a8a',
  UNREACHABLE: '#f59e0b',
  RATE_LIMITED: '#f2c94c',
};

export const tokens = {
  color: {
    canvas: '#0d1117',
    canvasDot: '#2a3340',
    panel: '#161b22',
    card: '#1c2129',
    border: '#30363d',
    fg: '#e6edf3',
    fgMuted: '#9da7b3',
    accent: '#d8b4fe',
    accentFg: '#1a1033',
    danger: '#ff8a8a',
    selection: '#d8b4fe',
    provider: PROVIDER_ACCENT,
    status: STATUS_RING,
    providerStatus: PROVIDER_STATUS,
  },
  font: {
    human: '"Source Serif 4", "Iowan Old Style", Georgia, serif',
    machine: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  },
  radius: { card: '10px', chip: '999px' },
  canvas: { dotGap: 20, dotSize: 1 },
} as const;

export type Tokens = typeof tokens;

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
