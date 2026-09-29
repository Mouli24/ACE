import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer, makeContext } from '../__tests__/helpers.js';
import { HTTP_BODY_CAP_BYTES, HTTP_REQUEST_DEFINITION, createHttpRequestTool } from './http-request.js';

const context = makeContext();
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
