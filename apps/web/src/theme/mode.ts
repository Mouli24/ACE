import type { Theme } from '@ace/contracts';
import { applyTheme, resolveTheme, type ResolvedTheme } from '@ace/ui';
import { useSyncExternalStore } from 'react';

/**
 * The light/dark choice (D329). Home and the workspace read and write one key, `ace-theme`, in
 * localStorage, default light — as the Ace UI theme does. `system` (the Settings page's third
 * option) is stored too and follows the OS. Storage can be missing or throw (private windows,
 * blocked site data); the page then keeps the default.
 */
export const THEME_KEY = 'ace-theme';

export type ThemeMode = Theme;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored mode, or `light`. */
export function readThemeMode(): ThemeMode {
  let value: string | null;
  try {
    value = storage()?.getItem(THEME_KEY) ?? null;
  } catch {
    value = null;
  }
  return value === 'dark' || value === 'system' ? value : 'light';
}

let mode: ThemeMode = readThemeMode();
let stopFollowing: () => void = () => undefined;
const listeners = new Set<() => void>();

/** Applies the stored mode to <html>. Call once at boot, before the first render. */
export function initThemeMode(): void {
  mode = readThemeMode();
  stopFollowing();
  stopFollowing = applyTheme(mode);
  listeners.forEach((listener) => listener());
}

/** Stores `next` under `ace-theme` and applies it. */
export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    storage()?.setItem(THEME_KEY, next);
  } catch {
    // the choice still applies for this page
  }
  stopFollowing();
  stopFollowing = applyTheme(next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored mode and what it resolves to right now, plus the header toggle. */
export function useThemeMode(): {
  mode: ThemeMode;
  dark: boolean;
  setMode: (next: ThemeMode) => void;
  toggle: () => void;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => mode,
    () => 'light' as ThemeMode,
  );
  const resolved: ResolvedTheme = resolveTheme(current);
  return {
    mode: current,
    dark: resolved === 'dark',
    setMode: setThemeMode,
    toggle: () => setThemeMode(resolved === 'dark' ? 'light' : 'dark'),
  };
}
