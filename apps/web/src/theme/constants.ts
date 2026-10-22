import type { ProviderType, ReasoningEffort } from '@ace/contracts';

import claudeLogo from './logos/claude.svg';
import customLogo from './logos/custom.svg';
import geminiLogo from './logos/googlegemini.svg';
import ollamaLogo from './logos/ollama.svg';
import openaiLogo from './logos/openai.svg';

/*
 * The Ace UI theme's constants, ported from the `<script>` blocks of `Ace Canvas.dc.html` and
 * `Ace Home.dc.html` (D328). Every value is the theme's own; only types are added. The theme's
 * sample data (agents, stages, files, model lists, budgets, prices) is not here and never ships.
 */

/** The theme's four provider looks. */
export type ThemeProvider = 'Codex' | 'Claude Code' | 'Gemini CLI' | 'Custom';
/** A Custom provider's connection type. */
export type ConnectionType = 'OpenAI compatible' | 'Ollama';

interface ProviderLook {
  c: string;
  ink: string;
  glow: string;
  logo?: string;
  orb: string;
  white?: boolean;
}

const CL: ProviderLook = {
  c: '#d97757',
  ink: '#c2603f',
  glow: '217,119,87',
  logo: claudeLogo,
  orb: 'radial-gradient(circle at 38% 32%,#ffe2d6,#ec9b7c 55%,#d97757 100%)',
};
const CU: ProviderLook = {
  c: '#ffffff',
  ink: '#1f1d1b',
  glow: '150,140,130',
  white: true,
  orb: 'radial-gradient(circle at 38% 32%,#ffffff,#f6f4f1 60%,#e2ddd7 100%)',
};
export const PT: Record<ThemeProvider, { d: ProviderLook; l: ProviderLook }> = {
  Codex: {
    d: {
      c: '#22e07f',
      ink: '#2fe08a',
      glow: '34,224,127',
      logo: openaiLogo,
      orb: 'radial-gradient(circle at 38% 32%,#d8ffea,#5ef5a8 55%,#14c96c 100%)',
    },
    l: {
      c: '#0fb565',
      ink: '#0a8048',
      glow: '12,170,96',
      logo: openaiLogo,
      orb: 'radial-gradient(circle at 36% 30%,#a9f5cb,#19c878 48%,#047a45 100%)',
    },
  },
  'Claude Code': { d: CL, l: CL },
  'Gemini CLI': {
    d: {
      c: '#5b8cff',
      ink: '#8fb0ff',
      glow: '91,140,255',
      logo: geminiLogo,
      orb: 'radial-gradient(circle at 36% 30%,#dfe8ff,#6f9dff 48%,#6b5cff 100%)',
    },
    l: {
      c: '#2563ff',
      ink: '#1d4fe0',
      glow: '37,99,255',
      logo: geminiLogo,
      orb: 'radial-gradient(circle at 36% 30%,#c9dbff,#3b7bff 46%,#5b3dff 100%)',
    },
  },
  Custom: { d: CU, l: CU },
};

export interface ProviderTheme extends ProviderLook {
  w: boolean;
  logo: string;
  logoFilter: string;
  ring: string;
  iconRing: string;
  badge: string;
  chipBg: string;
  chipInk: string;
}

/** The theme's `th()`: a provider's orb, logo, ring and chip colours, light or dark. */
export const th = (
  st: { provider: ThemeProvider; ctype?: ConnectionType | undefined },
  D: boolean,
): ProviderTheme => {
  const p = (PT[st.provider] || PT.Codex)[D ? 'd' : 'l'],
    w = !!p.white;
  return {
    ...p,
    w,
    logo: w ? (st.ctype === 'Ollama' ? ollamaLogo : customLogo) : (p.logo ?? customLogo),
    logoFilter: w ? 'none' : 'brightness(0) invert(1)',
    ring: w
      ? '0 0 0 1px #d9d3cc,0 0 0 6px rgba(255,255,255,0.4),0 8px 22px -8px rgba(0,0,0,0.3)'
      : '0 0 0 6px rgba(' + p.glow + ',0.14),0 8px 24px -6px rgba(' + p.glow + ',0.6)',
    iconRing: w ? '0 0 0 1px #d9d3cc' : 'none',
    badge: w ? '#1f1d1b' : p.ink,
    chipBg: w ? 'var(--hover)' : 'rgba(' + p.glow + ',0.14)',
    chipInk: w ? 'var(--ink)' : p.ink,
  };
};

/**
 * ACE's provider types on the theme's four looks. Mock has no logo of its own, so it takes the
 * Custom look; a node with no provider chosen yet does too (the theme's `th()` would fall back to
 * Codex green, which would claim a provider the node does not have).
 */
export function themeProviderOf(type: ProviderType | null | undefined): {
  provider: ThemeProvider;
  ctype?: ConnectionType;
} {
  switch (type) {
    case 'anthropic':
    case 'claude_code':
      return { provider: 'Claude Code' };
    case 'openai':
    case 'codex_cli':
      return { provider: 'Codex' };
    case 'google':
    case 'gemini_cli':
      return { provider: 'Gemini CLI' };
    case 'ollama':
      return { provider: 'Custom', ctype: 'Ollama' };
    case 'openai_compatible':
      return { provider: 'Custom', ctype: 'OpenAI compatible' };
    default:
      return { provider: 'Custom' };
  }
}

export const EFFORT = ['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max'] as const;
/**
 * D389: the theme's effort levels on the contract's `REASONING_EFFORTS`, in the same order. Only the
 * theme's `XHigh` is spelled out, as "Extra high"; `EFFORT[0]` ("Default") is no setting at all.
 */
export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: EFFORT[1],
  medium: EFFORT[2],
  high: EFFORT[3],
  xhigh: 'Extra high',
  max: EFFORT[5],
};
export const SKILLS: ReadonlyArray<readonly [string, string, string]> = [
  ['web', 'Web search', 'Look up live sources and trends'],
  ['files', 'Edit files', 'Write drafts and notes to the workspace'],
  ['shell', 'Run commands', 'Execute scripts inside the sandbox'],
  ['cite', 'Citations', 'Attach a source to every claim'],
];

/** `1.23M`, `45.6k`, `812`. */
export const fmt = (n: number) =>
  n >= 1e6
    ? (n / 1e6).toFixed(2) + 'M'
    : n >= 1e3
      ? Math.round(n / 100) / 10 + 'k'
      : String(Math.round(n));

/** Syntax colours, light and dark. */
export const PAL_L = {
  kw: '#7a4fd0',
  str: '#2f8a57',
  num: '#d2542a',
  com: '#8a837c',
  fn: '#1a8792',
  type: '#a86f12',
  head: '#d2542a',
};
export const PAL_D = {
  kw: '#b49cf5',
  str: '#7cc99a',
  num: '#f39a72',
  com: '#7d7771',
  fn: '#5cc3cc',
  type: '#f2c14e',
  head: '#f39a72',
};
/** The editor's active-line band. */
export const BAND_L = '#f7f3ef';
export const BAND_D = '#201e1c';

/** A file's icon colour, by extension. */
export const fileIconColor = (path: string): string =>
  (({ ts: '#1f97a3', md: '#ef6b3f', json: '#f2c14e' }) as Record<string, string>)[
    path.split('.').pop() ?? ''
  ] ?? 'var(--iconLine)';

/** Agent colours, assigned by agent order. */
export const AGENT_COLORS = ['#ef6b3f', '#7a62d6', '#1f97a3'] as const;
export const agentColor = (index: number): string =>
  AGENT_COLORS[index % AGENT_COLORS.length] ?? '#ef6b3f';

/* Home */

export type Tint = 'blue' | 'red' | 'pink' | 'purple' | 'green' | 'teal' | 'amber';
/** Card tints: [light gradient, accent]. */
export const T: Record<Tint, readonly [string, string]> = {
  blue: ['linear-gradient(135deg,#e4e8f5,#eef0f6 60%,#f1eef1)', '#5b7fe0'],
  red: ['linear-gradient(135deg,#f6e9e7,#f9e1d9 50%,#f2eeee)', '#ef6b3f'],
  pink: ['linear-gradient(135deg,#f5e6ea,#f8dfe6 50%,#f3eef0)', '#d94a6b'],
  purple: ['linear-gradient(135deg,#ebe8f3,#e9e6f4 50%,#f1eff3)', '#6c55c8'],
  green: ['linear-gradient(135deg,#e5f1ea,#dff0e6 50%,#eff2ef)', '#2f9e63'],
  teal: ['linear-gradient(135deg,#e2f0f1,#dcedef 50%,#eef1f2)', '#1f97a3'],
  amber: ['linear-gradient(135deg,#f7efe0,#f8e9cf 50%,#f3f0ec)', '#d99417'],
};
/** Orbiting agent tile colours per tint. */
export const AG: Record<Tint, readonly [string, string, string]> = {
  blue: ['#3d5fd6', '#5b7fe0', '#7aa0ee'],
  red: ['#e8572e', '#f07a4f', '#f59570'],
  pink: ['#c23c5c', '#d94a6b', '#e3789a'],
  purple: ['#4a3aa8', '#6c55c8', '#8f7ce0'],
  green: ['#1f7a4a', '#2f9e63', '#5bbf87'],
  teal: ['#13737d', '#1f97a3', '#4fb8c2'],
  amber: ['#b27408', '#d99417', '#ebb34d'],
};
/** Orbit animation per tile: [keyframes, duration s, phase]. */
export const ORB: ReadonlyArray<readonly [string, number, number]> = [
  ['orbitB', 14, 0],
  ['orbitA', 9, 0.35],
  ['orbitC', 18, 0.6],
  ['orbitB', 14, 0.5],
];
