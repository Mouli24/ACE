import type * as Monaco from 'monaco-editor';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

const token = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(value) ? value : fallback;
};

/** Night and Paper for Monaco, from `@ace/ui`'s own tokens, so the editor follows the app theme (§6.2). */
export function applyForgeTheme(monaco: typeof Monaco, theme: 'dark' | 'light'): void {
  const light = theme === 'light';
  const name = light ? 'ace-paper' : 'ace-night';
  const canvas = token('--color-canvas', light ? '#f3f1ec' : '#0a0a0b');
  const card = token('--color-card', light ? '#fbfaf7' : '#111113');
  const border = token('--color-border', light ? '#dcd8d0' : '#232327');
  const fg = token('--color-fg', light ? '#1b1a1e' : '#f6f5f2');
  const soft = token('--color-fg-soft', light ? '#46444c' : '#b8b5ae');
  const faint = token('--color-fg-faint', light ? '#8d8a93' : '#7d7c82');
  const selection = token('--color-selection', light ? '#7c6fd6' : '#c4b5fd');
  const danger = token('--color-danger', '#f0563f');
  monaco.editor.defineTheme(name, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': canvas,
      'editor.foreground': fg,
      'editorGutter.background': canvas,
      'minimap.background': canvas,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': soft,
      'editorCursor.foreground': fg,
      'editor.selectionBackground': `${selection.slice(0, 7)}55`,
      'editor.inactiveSelectionBackground': `${selection.slice(0, 7)}30`,
      'editor.lineHighlightBackground': card,
      'editor.lineHighlightBorder': card,
      'editorWidget.background': card,
      'editorWidget.border': border,
      'editorIndentGuide.background1': border,
      'editorError.foreground': danger,
      'scrollbarSlider.background': `${border.slice(0, 7)}aa`,
    },
  });
  monaco.editor.setTheme(name);
}
