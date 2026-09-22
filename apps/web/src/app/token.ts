import { SESSION_TOKEN_STORAGE_KEY } from '@ace/contracts';

/**
 * Round 1 §2.10: the engine prints `http://localhost:5173/?token=<token>`. The web app reads
 * `?token=`, keeps it in `sessionStorage['ace.token']`, strips it from the URL so it is never
 * bookmarked or shared, and sends it as `Authorization: Bearer` (REST) and `?token=` (WS).
 */
export function readSessionToken(): string | undefined {
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
