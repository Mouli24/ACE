import { useEffect, useRef } from 'react';

/**
 * A keyboard shortcut. Letter shortcuts (`Key*`) follow the letter the person types, so Ctrl+C stays
 * copy on Dvorak; only when `event.key` is not a single ASCII letter (a Cyrillic layout) do they
 * fall back to the key's place, `event.code`. Every other code (`Digit1`) matches `event.code`, so
 * Shift+1 works on any layout. `mod` is Ctrl on Windows and Linux and ⌘ on macOS; the other
 * modifiers must match exactly, so Ctrl+S and Ctrl+Alt+S are different shortcuts. AltGr (which
 * reports Ctrl+Alt) never matches, because it types characters.
 */
export interface Shortcut {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function keyMatches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (shortcut.code.startsWith('Key') && /^[a-zA-Z]$/.test(event.key)) {
    return event.key.toLowerCase() === shortcut.code.slice(3).toLowerCase();
  }
  return event.code === shortcut.code;
}

export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    event.getModifierState?.('AltGraph') !== true &&
    keyMatches(event, shortcut) &&
    (event.ctrlKey || event.metaKey) === (shortcut.mod ?? false) &&
    event.shiftKey === (shortcut.shift ?? false) &&
    event.altKey === (shortcut.alt ?? false)
  );
}

/**
 * Forge's shortcuts (D299, design §6.2). The browser keeps Ctrl/⌘+W, T, N, Ctrl+Tab and
 * Ctrl/⌘+1…9 for itself and a page cannot take them, so none is bound here.
 */
export const SHORTCUTS = {
  ideate: { code: 'Digit1', mod: true, shift: true },
  forge: { code: 'Digit2', mod: true, shift: true },
  /** D303: the third mode beside Ideate and Forge. */
  domain: { code: 'Digit3', mod: true, shift: true },
  toggleChat: { code: 'KeyB', mod: true, alt: true },
  save: { code: 'KeyS', mod: true },
  saveAll: { code: 'KeyS', mod: true, alt: true },
  quickOpen: { code: 'KeyP', mod: true },
  toggleSidebar: { code: 'KeyB', mod: true },
  /** Forge's bottom panel (Problems): D299, back with the panel after D334. */
  togglePanel: { code: 'KeyJ', mod: true },
  closeTab: { code: 'KeyW', alt: true },
  /** D301: shows or hides the Terminal. Not a browser key, so it is safe to bind. */
  toggleTerminal: { code: 'Backquote', mod: true },
  /** D302: the editor's selection (or file) as a chip in the chat composer. */
  askAgent: { code: 'KeyL', mod: true },
  /** D299 Phase 4: Search in Forge's left column, with the focus in its query. */
  searchFiles: { code: 'KeyF', mod: true, shift: true },
  /** D299 Phase 4: Run checks, into Problems. */
  runChecks: { code: 'KeyB', mod: true, shift: true },
} as const satisfies Record<string, Shortcut>;

const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Keys whose `code` is not what a person reads on the key. */
const KEY_LABELS: Readonly<Record<string, string>> = { Backquote: '`' };

/** "Ctrl+Shift+2" on Windows, "⌘⇧2" on a Mac — for titles and the empty editor's hints. */
export function shortcutLabel(shortcut: Shortcut): string {
  const key = KEY_LABELS[shortcut.code] ?? shortcut.code.replace(/^Key|^Digit/, '');
  if (isMac())
    return `${shortcut.mod ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`;
  return [shortcut.mod && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key]
    .filter(Boolean)
    .join('+');
}

/**
 * Binds shortcuts on `window` in the capture phase, so they run before Monaco, an input or the
 * terminal sees the key, and stop the browser's default (Ctrl+S would otherwise save the page).
 */
export function useShortcuts(
  bindings: ReadonlyArray<readonly [Shortcut, () => void]>,
  enabled = true,
): void {
  const current = useRef(bindings);
  current.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const [shortcut, run] of current.current) {
        if (!matches(event, shortcut)) continue;
        event.preventDefault();
        event.stopPropagation();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
