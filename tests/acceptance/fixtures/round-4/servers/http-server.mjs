import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * The local HTTP test server the round 4 `http_request` / `web_fetch` tests point at (round 4 §4
 * item 6, TC-TOOL-007, TC-GRD-007). It binds `127.0.0.1` on an ephemeral port, answers every request
 * with a small canned response, and needs no network — a test starts it, rewrites the fixture's
 * `__ACE_HTTP_URL__` placeholder to its `url`, runs the workflow, then stops it.
 *
 * Used as a module:
 *   import { startHttpFixtureServer } from '.../servers/http-server.mjs';
 *   const server = await startHttpFixtureServer();
 *   // server.url    -> "http://127.0.0.1:<port>/echo"  (drop into __ACE_HTTP_URL__)
 *   // server.origin -> "http://127.0.0.1:<port>"
 *   // server.host   -> "127.0.0.1"   (already the fixtures' allowed domain, matches URL hostname)
 *   // server.port   -> <number>
 *   await server.close();
 *
 * The response is HTML with a <title> and a paragraph, so `web_fetch`'s readability extraction has a
 * title and text; `http_request` reads its 200 status and body. The body echoes the method and path
 * so a test can tell the call actually arrived. A GET to `/status/<n>` answers with status <n>, for
 * a test that wants a non-200.
 */

/** The default path the fixtures' URL points at. */
export const HTTP_FIXTURE_PATH = '/echo';

export function startHttpFixtureServer({ host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${host}`);
    const statusMatch = requestUrl.pathname.match(/^\/status\/(\d{3})$/);
    const status = statusMatch ? Number(statusMatch[1]) : 200;

    const body =
      `<!doctype html><html><head><title>ACE HTTP fixture</title></head>` +
      `<body><h1>ACE HTTP fixture server</h1>` +
      `<p>This is a canned response. Method ${req.method ?? 'GET'}, path ${requestUrl.pathname}.</p>` +
      `</body></html>`;

    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 = the OS picks a free ephemeral port; bound to 127.0.0.1 only (never a LAN interface).
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const origin = `http://${host}:${port}`;
      resolve({
        server,
        host,
        port,
        origin,
        url: `${origin}${HTTP_FIXTURE_PATH}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/* Run directly to eyeball it: prints its URL, serves until Ctrl-C. */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const server = await startHttpFixtureServer();
  console.log(`HTTP fixture server listening at ${server.url}`);
  console.log('Press Ctrl-C to stop.');
  process.on('SIGINT', () => {
    void server.close().then(() => process.exit(0));
  });
}
