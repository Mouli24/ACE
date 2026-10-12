import type * as Monaco from 'monaco-editor';

import { BAND_D, BAND_L, PAL_D, PAL_L } from '../../theme/constants';

/*
 * Monaco in the Ace UI theme's code view (D334): `ace-light` and `ace-dark`, from the theme's
 * syntax palettes (`PAL_L` / `PAL_D`), its surface, line-number inks, active-line band and the
 * `#ef6b3f` cursor. Monaco themes are global, so Forge and the node settings modal's JSON editor
 * share them.
 */

type Palette = typeof PAL_L;

interface Look {
  pal: Palette;
  /** `--surface`: the code area's background. */
  surface: string;
  /** `--canvas`: inputs inside Monaco's widgets. */
  canvas: string;
  ink: string;
  muted: string;
  line: string;
  /** `--hover`: the quiet selection, as the theme's hovered rows. */
  hover: string;
  iconLine: string;
  band: string;
}

const LIGHT: Look = {
  pal: PAL_L,
  surface: '#ffffff',
  canvas: '#f4f0ec',
  ink: '#1f1d1b',
  muted: '#6f6a65',
  line: '#e6e0da',
  hover: '#ece7e2',
  iconLine: '#cfc9c3',
  band: BAND_L,
};

const DARK: Look = {
  pal: PAL_D,
  surface: '#181615',
  canvas: '#0d0c0b',
  ink: '#f2eee9',
  muted: '#a39d97',
  line: '#2a2725',
  hover: '#24211f',
  iconLine: '#4a4541',
  band: BAND_D,
};

/** The theme's orange: the cursor, the focus ring and find matches. */
const ACCENT = '#ef6b3f';
const DANGER = '#c94c27';
const DONE = '#2f9e63';

/** Monaco wants rule colours without the `#`. */
const hex = (colour: string): string => colour.replace(/^#/, '');

/**
 * The theme's tokenizers know keywords, strings, numbers, comments, functions, types and markdown
 * headings; Monaco's built-in tokenizers name the same things (`keyword`, `string.key.json`,
 * `type.identifier`, `keyword.md`, …). Everything else is mapped onto that palette or ink, so no
 * stock `vs` colour shows through.
 */
function rules({ pal, ink }: Look): Monaco.editor.ITokenThemeRule[] {
  const rule = (
    token: string,
    colour: string,
    fontStyle?: string,
  ): Monaco.editor.ITokenThemeRule =>
    fontStyle === undefined
      ? { token, foreground: hex(colour) }
      : { token, foreground: hex(colour), fontStyle };
  return [
    rule('', ink),
    rule('keyword', pal.kw),
    rule('keyword.flow', pal.kw),
    rule('string', pal.str),
    rule('string.html', pal.str),
    rule('string.sql', pal.str),
    rule('string.yaml', pal.str),
    rule('regexp', pal.str),
    rule('number', pal.num),
    rule('number.hex', pal.num),
    rule('constant', pal.num),
    rule('comment', pal.com, 'italic'),
    rule('type', pal.type),
    rule('type.identifier', pal.type),
    rule('annotation', pal.type),
    // markdown: headings bold in the heading colour, **strong** bold
    rule('keyword.md', pal.head, 'bold'),
    rule('markup.heading', pal.head, 'bold'),
    rule('strong', ink, 'bold'),
    // JSON: keys as the theme's `fn`, values as strings, true/false/null as numbers
    rule('string.key.json', pal.fn),
    rule('string.value.json', pal.str),
    rule('keyword.json', pal.num),
    // markup and other languages, onto the same palette
    rule('tag', pal.kw),
    rule('metatag', pal.kw),
    rule('attribute.name', pal.fn),
    rule('attribute.value', pal.str),
    rule('attribute.value.html', pal.str),
    rule('attribute.value.xml', pal.str),
    rule('attribute.value.number', pal.num),
    rule('attribute.value.unit', pal.num),
    rule('key', pal.fn),
    rule('predefined', pal.fn),
    rule('variable', ink),
    rule('variable.predefined', ink),
    rule('variable.parameter', ink),
    rule('delimiter', ink),
    rule('delimiter.html', ink),
    rule('delimiter.xml', ink),
    rule('operator', ink),
    rule('invalid', DANGER),
  ];
}

function colors(look: Look): Monaco.editor.IColors {
  return {
    'editor.background': look.surface,
    'editorGutter.background': look.surface,
    'editor.foreground': look.ink,
    'editorLineNumber.foreground': look.muted,
    'editorLineNumber.activeForeground': look.ink,
    'editor.lineHighlightBackground': look.band,
    'editor.lineHighlightBorder': look.band,
    'editorCursor.foreground': ACCENT,
    'editor.selectionBackground': look.hover,
    'editor.inactiveSelectionBackground': look.hover,
    'editor.selectionHighlightBackground': `${look.hover}99`,
    'editor.wordHighlightBackground': `${look.hover}99`,
    'editor.wordHighlightStrongBackground': `${look.hover}99`,
    'editor.findMatchBackground': `${ACCENT}33`,
    'editor.findMatchHighlightBackground': `${ACCENT}1f`,
    // Standalone models colour bracket pairs from their own options, whatever the editor option
    // says; the theme draws brackets in ink, so every pair colour is ink.
    'editorBracketHighlight.foreground1': look.ink,
    'editorBracketHighlight.foreground2': look.ink,
    'editorBracketHighlight.foreground3': look.ink,
    'editorBracketHighlight.foreground4': look.ink,
    'editorBracketHighlight.foreground5': look.ink,
    'editorBracketHighlight.foreground6': look.ink,
    'editorBracketHighlight.unexpectedBracket.foreground': DANGER,
    'editorBracketMatch.background': look.hover,
    'editorBracketMatch.border': look.iconLine,
    'editorIndentGuide.background1': look.line,
    'editorIndentGuide.activeBackground1': look.iconLine,
    'editorWidget.background': look.surface,
    'editorWidget.foreground': look.ink,
    'editorWidget.border': look.line,
    'editorSuggestWidget.background': look.surface,
    'editorSuggestWidget.border': look.line,
    'editorSuggestWidget.foreground': look.ink,
    'editorSuggestWidget.selectedBackground': look.hover,
    'editorSuggestWidget.highlightForeground': ACCENT,
    'editorHoverWidget.background': look.surface,
    'editorHoverWidget.border': look.line,
    'input.background': look.canvas,
    'input.border': look.line,
    'input.foreground': look.ink,
    focusBorder: ACCENT,
    'scrollbarSlider.background': `${look.iconLine}80`,
    'scrollbarSlider.hoverBackground': `${look.iconLine}b3`,
    'scrollbarSlider.activeBackground': look.iconLine,
    'scrollbar.shadow': '#00000000',
    'editorOverviewRuler.border': '#00000000',
    'editorError.foreground': DANGER,
    'diffEditor.insertedTextBackground': `${DONE}26`,
    'diffEditor.removedTextBackground': `${DANGER}26`,
    'diffEditor.insertedLineBackground': `${DONE}14`,
    'diffEditor.removedLineBackground': `${DANGER}14`,
    'diffEditor.border': look.line,
  };
}

/** Define `ace-light` and `ace-dark`, and show the one the app's theme resolves to. */
export function applyForgeTheme(monaco: typeof Monaco, resolved: 'light' | 'dark'): void {
  monaco.editor.defineTheme('ace-light', {
    base: 'vs',
    inherit: true,
    rules: rules(LIGHT),
    colors: colors(LIGHT),
  });
  monaco.editor.defineTheme('ace-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: rules(DARK),
    colors: colors(DARK),
  });
  monaco.editor.setTheme(resolved === 'dark' ? 'ace-dark' : 'ace-light');
}
