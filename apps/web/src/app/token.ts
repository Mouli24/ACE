import { SESSION_TOKEN_STORAGE_KEY, type DesktopBridge } from '@ace/contracts';

import { desktopBridge } from './desktop';

/**
 * Round 1 §2.10: the engine prints `http://localhost:5173/?token=<token>`. The web app reads
 * `?token=`, keeps it in `sessionStorage['ace.token']`, strips it from the URL so it is never
 * bookmarked or shared, and sends it as `Authorization: Bearer` (REST) and `?token=` (WS).
 *
 * In the desktop app the bridge's token comes first (D294). It is the engine's current one: when
 * `tsx watch` restarts the engine the shell reloads the page with the new token, while
 * sessionStorage would still hold the old. It is not stored — the bridge is there on every load.
 */
export function readSessionToken(
  bridge: DesktopBridge | undefined = desktopBridge(),
): string | undefined {
  if (bridge !== undefined) return bridge.token;

  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.toString());
    return fromUrl;
  }
  return sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? undefined;
}
