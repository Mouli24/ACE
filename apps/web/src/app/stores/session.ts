import { AceApiError } from '@ace/sdk';
import { create } from 'zustand';

/**
 * Audit U-2 (D-009): whether the engine stopped accepting this page's session token. Every engine
 * start prints a new token, but sessionStorage keeps the old one, so a page left open across a
 * restart gets 401 on every call — and its screens used to read "not found". A 401 from any query
 * or mutation, or the socket closing `unauthorized`, sets it; the shell then shows the session-lost
 * screen instead of the app. Nothing clears it: only the engine's new link does.
 */
interface SessionState {
  lost: boolean;
}

export const useSessionStore = create<SessionState>(() => ({ lost: false }));

export function markSessionLost(): void {
  if (!useSessionStore.getState().lost) useSessionStore.setState({ lost: true });
}

/** A REST answer that means the token is no longer accepted (FR-SYS-001). */
export function isUnauthorized(error: unknown): boolean {
  return AceApiError.is(error) && error.status === 401;
}
