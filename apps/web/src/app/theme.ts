import type { ResolvedTheme } from '@ace/ui';
import { useEffect, useSyncExternalStore } from 'react';

import { initThemeMode } from '../theme/mode';

/**
 * FR-SYS-005, D329: the theme on screen is the `ace-theme` choice in localStorage (default light),
 * which the header toggles and the Settings page write. `main.tsx` applies it before the first
 * render; this re-applies it when the shell mounts, so a route rendered without that boot step
 * (tests, a host without `main.tsx`) is still themed.
 */
export function useApplyTheme(): void {
  useEffect(() => initThemeMode(), []);
}

function readResolved(): ResolvedTheme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * The theme on screen right now — `system` already resolved — for widgets that take a theme name
 * rather than reading CSS variables (Monaco).
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolved, () => 'light');
}
