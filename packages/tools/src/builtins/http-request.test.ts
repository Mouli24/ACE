import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer, makeContext } from '../__tests__/helpers.js';
import { HTTP_BODY_CAP_BYTES, HTTP_REQUEST_DEFINITION, createHttpRequestTool } from './http-request.js';

// The test servers listen on 127.0.0.1, which only an IP entry on the allow-list reaches [audit S-2].
const context = makeContext({ allowedDomains: ['127.0.0.1'] });
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const tool = createHttpRequestTool();

describe('TC-TOOL-007 http_request', () => {
  it('is a network tool', () => {
    expect(HTTP_REQUEST_DEFINITION.permissions).toEqual({ network: true, fsPaths: [], destructive: false });
  });

  it('returns the status, headers and body of a GET', async () => {
    const server = await startHttpServer((_req, res) => {
      res.setHeader('x-demo', 'yes');
      res.end('the body');
    });
    close = server.close;

    const result = (await tool.implementation({ method: 'GET', url: server.url }, context)) as {
      status: number;
      headers: Record<string, string>;
      body: string;
    };
    expect(result.status).toBe(200);
    expect(result.body).toBe('the body');
    expect(result.headers['x-demo']).toBe('yes');
  });

  it('sends a body on a POST', async () => {
    const server = await startHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => res.end(`echo:${body}`));
    });
    close = server.close;

    const result = (await tool.implementation(
      { method: 'POST', url: server.url, body: 'ping' },
      context,
    )) as { body: string };
    expect(result.body).toBe('echo:ping');
  });

  it('caps the body it reads back at 1 MB', async () => {
    const server = await startHttpServer((_req, res) => {
      res.end('y'.repeat(HTTP_BODY_CAP_BYTES + 50_000));
    });
    close = server.close;

    const result = (await tool.implementation({ method: 'GET', url: server.url }, context)) as { body: string };
    expect(result.body.length).toBeLessThanOrEqual(HTTP_BODY_CAP_BYTES);
  });

  it('refuses a non-http scheme', async () => {
    await expect(
      tool.implementation({ method: 'GET', url: 'file:///etc/passwd' }, context),
    ).rejects.toMatchObject({ kind: 'invalid_args' });
  });

  it('reports a failure when the host refuses the connection', async () => {
    await expect(tool.implementation({ method: 'GET', url: 'http://127.0.0.1:1' }, context)).rejects.toMatchObject({
      kind: 'failed',
    });
  });

  it('does not follow a redirect off the allow-list: denied, and the target is never contacted [audit S-2]', async () => {
    let reached = false;
    const target = await startHttpServer((_req, res) => {
      reached = true;
      res.end('internal');
    });
    const start = await startHttpServer((_req, res) => {
      res.writeHead(302, { location: target.url.replace('127.0.0.1', 'localhost') });
      res.end();
    });
    close = async () => {
      await start.close();
      await target.close();
    };

    await expect(tool.implementation({ method: 'GET', url: start.url }, context)).rejects.toMatchObject({
      kind: 'denied',
    });
    expect(reached).toBe(false);
  });

  it('refuses a loopback URL unless the allow-list names the address itself [audit S-2]', async () => {
    const server = await startHttpServer((_req, res) => res.end('internal'));
    close = server.close;
    const unlisted = makeContext({ allowedDomains: ['example.com'] });
    try {
      await expect(tool.implementation({ method: 'GET', url: server.url }, unlisted)).rejects.toMatchObject({
        kind: 'denied',
      });
    } finally {
      unlisted.cleanup();
    }
  });

  it('reports a timeout when the server is too slow', async () => {
    const server = await startHttpServer(() => {
      // Never responds.
    });
    close = server.close;
    const fast = createHttpRequestTool({ timeoutMs: 200 });
    await expect(fast.implementation({ method: 'GET', url: server.url }, context)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
