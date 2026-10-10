import { useEffect, useRef } from 'react';

/**
 * A keyboard shortcut, matched on `event.code` (the key's place, so Shift+1 is `Digit1` on every
 * layout). `mod` is Ctrl on Windows and Linux and ⌘ on macOS; the other modifiers must match
 * exactly, so Ctrl+S and Ctrl+Alt+S are different shortcuts.
 */
export interface Shortcut {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    event.code === shortcut.code &&
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
  toggleChat: { code: 'KeyB', mod: true, alt: true },
  save: { code: 'KeyS', mod: true },
  saveAll: { code: 'KeyS', mod: true, alt: true },
  quickOpen: { code: 'KeyP', mod: true },
  toggleSidebar: { code: 'KeyB', mod: true },
  togglePanel: { code: 'KeyJ', mod: true },
  closeTab: { code: 'KeyW', alt: true },
} as const satisfies Record<string, Shortcut>;

const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Ctrl+Shift+2" on Windows, "⌘⇧2" on a Mac — for titles and the empty editor's hints. */
export function shortcutLabel(shortcut: Shortcut): string {
  const key = shortcut.code.replace(/^Key|^Digit/, '');
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
