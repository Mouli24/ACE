import { createServer } from 'node:net';

/**
 * A port nothing is listening on, on loopback, for the packaged engine (D298). The OS picks it; the
 * socket is closed again before the engine binds it, which leaves a window too small to matter for
 * one engine started right after.
 */
export function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => (port === undefined ? reject(new Error('no port')) : resolve(port)));
    });
  });
}
