import { useEffect, useRef } from 'react';

/**
 * [audit F-10] Alt+W closes the editor's active tab (the browser keeps Ctrl/⌘+W, D299) — but only
 * when the key is not what the focused field means by it. Monaco's find widget takes Alt+W for
 * "match whole word", and a text field outside the editor (a dialog, Search, the terminal) types
 * with it. The letter typed decides, never the key's place: macOS's Option+W types "∑" and a
 * Cyrillic layout's W types "ц", so neither closes anything. Only a key that types nothing (a
 * dead key) falls back to `event.code`.
 */
export function isCloseTabKey(event: KeyboardEvent): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.getModifierState?.('AltGraph') === true) return false;
  const printable = [...event.key].length === 1;
  if (printable ? event.key.toLowerCase() !== 'w' : event.code !== 'KeyW') return false;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest('.find-widget') !== null) return false;
  const field = target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
  // Monaco's own text area is the editor itself: Alt+W there closes its tab
  return field === null || field.closest('.monaco-editor') !== null;
}

/**
 * Binds Alt+W on `window` in the capture phase, as `useShortcuts` binds the others, so it runs
 * before Monaco sees the key; any key {@link isCloseTabKey} declines goes on untouched.
 */
export function useCloseTabKey(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isCloseTabKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
