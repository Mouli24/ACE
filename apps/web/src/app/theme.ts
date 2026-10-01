import { DEFAULT_THEME } from '@ace/contracts';
import { applyTheme, type ResolvedTheme } from '@ace/ui';
import { useEffect, useSyncExternalStore } from 'react';

import { useSettings } from '../settings/hooks';

/**
 * FR-SYS-005, D241: the engine persists `Settings.theme`; this applies it. Until settings load (or
 * if they fail) the default theme stands, so the first paint is never unthemed.
 */
export function useApplyTheme(): void {
  const settings = useSettings();
  const theme = settings.data?.theme ?? DEFAULT_THEME;
  useEffect(() => applyTheme(theme), [theme]);
}

function readResolved(): ResolvedTheme {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
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
  return useSyncExternalStore(subscribe, readResolved, () => 'dark');
}
