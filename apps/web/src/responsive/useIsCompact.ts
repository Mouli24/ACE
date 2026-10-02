import { useSyncExternalStore } from 'react';

/**
 * The phone breakpoint (FR-MOB-001, Arch §10.3). At or under 640 px the app is a monitoring app:
 * runs, run detail, outputs, approvals and chat, with a read-only Canvas (FR-MOB-003).
 */
export const COMPACT_QUERY = '(max-width: 640px)';

function media(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(COMPACT_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (list === undefined) return () => undefined;
  // Safari < 14 has only the deprecated pair.
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

const read = (): boolean => media()?.matches ?? false;

/**
 * True at phone width. Where there is no `matchMedia` (jsdom, a server render) it is false, so the
 * desktop layout is the default and every existing screen renders exactly as before.
 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
