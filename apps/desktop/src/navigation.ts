/**
 * Where a link may take the window (D294): Electron-free, so every rule is unit-tested.
 *
 * One policy serves both doors a page can leave by — a navigation (`will-navigate`) and a new
 * window (`setWindowOpenHandler`):
 *
 * - `allow` — the app's own origin (Vite in dev, the engine when packaged). For a new window this
 *   means "load it in this one": a second window would have no bridge history and is never needed.
 * - `download` — an artifact's content on the engine (`/api/v1/artifacts/:id/content?token=…`). In
 *   dev the page and the engine are different origins, so Chromium ignores `<a download>` and
 *   navigates instead; the shell turns that into a download, and the token stays inside the app.
 * - `external` — any other http(s) or mailto URL goes to the default browser or mail client …
 * - `deny` — … unless it holds the session token, which never leaves the app. Everything else
 *   (file:, data:, javascript:, the engine's other routes) is refused.
 */

export type LinkAction = 'allow' | 'download' | 'external' | 'deny';

export interface ShellOrigins {
  /** The origin the SPA is served from. */
  app: string;
  /** The engine's origins: `http://127.0.0.1:<port>` and `http://localhost:<port>`. */
  engine: readonly string[];
  /** The live session token. */
  token?: string;
}

/** `API_BASE_PATH` (`@ace/contracts`) + the one route a link may point at (FR-MM-009). */
const ARTIFACT_CONTENT = /^\/api\/v1\/artifacts\/[^/]+\/content$/;

/** Both spellings of the engine's loopback origin. */
export function engineOrigins(engineUrl: string): string[] {
  const url = new URL(engineUrl);
  return [`${url.protocol}//127.0.0.1:${url.port}`, `${url.protocol}//localhost:${url.port}`];
}

function holdsToken(url: URL, token: string | undefined): boolean {
  if (token === undefined || token === '') return false;
  if (url.href.includes(token)) return true;
  try {
    return decodeURIComponent(url.href).includes(token);
  } catch {
    return true; // undecodable: refuse rather than guess
  }
}

export function decideLink(raw: string, origins: ShellOrigins): LinkAction {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'deny';
  }

  if (origins.engine.includes(url.origin) && url.pathname.startsWith('/api/')) {
    return ARTIFACT_CONTENT.test(url.pathname) ? 'download' : 'deny';
  }
  if (url.origin === origins.app) return 'allow';
  if (origins.engine.includes(url.origin)) return 'deny';

  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
    return holdsToken(url, origins.token) ? 'deny' : 'external';
  }
  return 'deny';
}
