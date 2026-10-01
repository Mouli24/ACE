import type { Theme } from '@ace/contracts';

/**
 * FR-SYS-005, D241: apply `Settings.theme` to the document. Framework-free, so the web app's hook
 * and any non-React host (the desktop shell later) share it.
 *
 * `dark` and `light` set `data-theme` on <html>, which `theme.css` keys the token set on, and the
 * matching `color-scheme`. `system` follows `prefers-color-scheme` and keeps following it until the
 * returned cleanup runs. With no `matchMedia` available, `system` resolves to dark — the default.
 */

export type ResolvedTheme = 'dark' | 'light';

export type MatchMedia = (query: string) => MediaQueryList;

const LIGHT_QUERY = '(prefers-color-scheme: light)';

function defaultMatchMedia(): MatchMedia | undefined {
  return typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia.bind(globalThis)
    : undefined;
}

/** The concrete theme `theme` stands for right now. */
export function resolveTheme(theme: Theme, matchMedia?: MatchMedia): ResolvedTheme {
  if (theme !== 'system') return theme;
  const mm = matchMedia ?? defaultMatchMedia();
  return mm?.(LIGHT_QUERY).matches ? 'light' : 'dark';
}

function setTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.dataset['theme'] = resolved;
  root.style.colorScheme = resolved;
}

/**
 * Applies `theme` to `root` (default `document.documentElement`) and returns a cleanup that stops
 * listening for system changes. Calling it again with another theme replaces the first.
 */
export function applyTheme(
  theme: Theme,
  matchMedia?: MatchMedia,
  root: HTMLElement = document.documentElement,
): () => void {
  if (theme !== 'system') {
    setTheme(root, theme);
    return () => undefined;
  }
  const mm = matchMedia ?? defaultMatchMedia();
  if (!mm) {
    setTheme(root, 'dark');
    return () => undefined;
  }
  const query = mm(LIGHT_QUERY);
  const sync = (): void => setTheme(root, query.matches ? 'light' : 'dark');
  sync();
  query.addEventListener('change', sync);
  return () => query.removeEventListener('change', sync);
}
