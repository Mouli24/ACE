import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { ConfigError, type EngineDeps } from '@ace/engine';
import { serveStatic } from '@hono/node-server/serve-static';

/** Hashed build output (`/assets/index-3f9a.js`) never changes under its name. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** `index.html` and anything unhashed: always revalidate, so a new build is picked up at once. */
export const PAGE_CACHE_CONTROL = 'no-cache';

/**
 * The file a request path names inside `root`, or `undefined` when it would leave it.
 *
 * `serveStatic` already refuses `..` and backslashes after `decodeURI`, and the URL parser has
 * folded dot segments before a request gets here; this is the containment check that does not rely
 * on either — it decodes everything `decodeURI` leaves alone (`%2F`, `%5C`) and checks the result.
 */
export function resolveInside(root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const full = resolve(root, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  return full === root || full.startsWith(root + sep) ? full : undefined;
}

/**
 * D297: serve a built web app (`apps/web/dist`) — what `ACE_WEB_DIR` names — for the packaged
 * desktop app, whose window loads the SPA from the engine's own origin.
 *
 * The gateway calls it for GET/HEAD outside `/api/v1` and `/ws` only (`isWebRequest`). A file is
 * served as is; `/assets/*` with a year-long immutable cache, the rest `no-cache`. Any other path is
 * a client-side route and gets `index.html` (the router is the HTML5 history one). A missing file
 * under `/assets/` is a 404 rather than `index.html`: a script request answered with a page fails
 * with a MIME error that hides the real cause.
 */
export function createWebHandler(webDir: string): NonNullable<EngineDeps['web']> {
  const root = resolve(webDir);
  if (!existsSync(join(root, 'index.html'))) {
    throw new ConfigError(
      `ACE_WEB_DIR is ${root}, which has no index.html. Build the web app (pnpm --filter @ace/web build) or unset ACE_WEB_DIR.`,
    );
  }

  const files = serveStatic({ root });
  const index = serveStatic({ root, path: 'index.html' });
  const nothing = async (): Promise<void> => undefined;

  return async (c, next) => {
    if (resolveInside(root, c.req.path) === undefined) return c.notFound();
    const asset = c.req.path.startsWith('/assets/');

    const file = await files(c, nothing);
    if (file instanceof Response) {
      file.headers.set('Cache-Control', asset ? ASSET_CACHE_CONTROL : PAGE_CACHE_CONTROL);
      return file;
    }
    if (asset) return c.notFound();

    const page = await index(c, nothing);
    if (page instanceof Response) {
      page.headers.set('Cache-Control', PAGE_CACHE_CONTROL);
      return page;
    }
    return next();
  };
}
