import type * as DnsPromises from 'node:dns/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeContext, startHttpServer } from '../__tests__/helpers.js';
import {
  MAX_REDIRECTS,
  NETWORK_REFUSED_MESSAGE,
  guardedFetch,
  isPrivateAddress,
} from './guarded-fetch.js';

/*
 * `*.internal.test` resolves to a private address and nothing else does differently: a name that
 * only DNS turns into 10.0.0.7 — the case the allow-list alone cannot see [audit S-2].
 */
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof DnsPromises>();
  return {
    ...actual,
    lookup: (host: string, options: unknown) =>
      host.endsWith('.internal.test')
        ? Promise.resolve([{ address: '10.0.0.7', family: 4 }])
        : (actual.lookup as (h: string, o: unknown) => Promise<unknown>)(host, options),
  };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function ctx(allowedDomains?: readonly string[]): ReturnType<typeof makeContext> {
  const context = makeContext(allowedDomains === undefined ? {} : { allowedDomains });
  cleanups.push(context.cleanup);
  return context;
}

async function server(
  handler: Parameters<typeof startHttpServer>[0],
): Promise<Awaited<ReturnType<typeof startHttpServer>>> {
  const started = await startHttpServer(handler);
  cleanups.push(started.close);
  return started;
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ kind: string; message: string; details: Record<string, unknown> }> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) =>
      error as { kind: string; message: string; details: Record<string, unknown> },
  );
  expect(outcome, 'expected the fetch to be refused').toBeDefined();
  return outcome!;
}

describe('[audit S-2] isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.0.9', true],
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['100.64.0.1', true],
    ['169.254.169.254', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['::1', true],
    ['::', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['100.128.0.1', false],
    ['2606:4700::1111', false],
    ['not-an-ip', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('[audit S-2] guardedFetch: every hop is judged again', () => {
  it('follows a redirect that stays on the allow-list', async () => {
    const target = await server((_req, res) => res.end('landed'));
    const start = await server((_req, res) => {
      res.writeHead(302, { location: `${target.url}/next` });
      res.end();
    });

    const response = await guardedFetch('web_fetch', start.url, {}, ctx(['127.0.0.1']));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('landed');
  });

  it('does not follow a redirect to a host off the allow-list, and never contacts it', async () => {
    let reached = false;
    const target = await server((_req, res) => {
      reached = true;
      res.end('should not be read');
    });
    const port = new URL(target.url).port;
    const start = await server((_req, res) => {
      res.writeHead(302, { location: `http://elsewhere.example:${port}/` });
      res.end();
    });
    const context = ctx(['127.0.0.1']);

    const error = await refusal(guardedFetch('http_request', start.url, {}, context));

    expect(error.kind).toBe('denied');
    expect(error.details).toMatchObject({
      host: 'elsewhere.example',
      reason: 'redirect_off_allowlist',
    });
    expect(error.message).toContain('not on the allow-list');
    expect(reached).toBe(false);
    const lines = context.logger.matching(NETWORK_REFUSED_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.payload).toMatchObject({
      tool: 'http_request',
      host: 'elsewhere.example',
      runId: 'run-test',
    });
  });

  it('refuses a redirect from an allow-listed host to a loopback address it does not name', async () => {
    const start = await server((_req, res) => {
      res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    // 169.254.169.254 is on the list only as part of an unrelated name — never as itself.
    const error = await refusal(
      guardedFetch('web_fetch', start.url, {}, ctx(['127.0.0.1', 'metadata.example'])),
    );
    expect(error).toMatchObject({ kind: 'denied', details: { reason: 'redirect_off_allowlist' } });
  });

  it('refuses an allow-listed name that resolves to a private address, first hop or redirect', async () => {
    await expect(
      guardedFetch('web_fetch', 'http://pages.internal.test/', {}, ctx(['internal.test'])),
    ).rejects.toMatchObject({
      kind: 'denied',
      details: { host: 'pages.internal.test', reason: 'private_address' },
    });

    const start = await server((_req, res) => {
      res.writeHead(307, { location: 'http://pages.internal.test/' });
      res.end();
    });
    await expect(
      guardedFetch('web_fetch', start.url, {}, ctx(['127.0.0.1', 'internal.test'])),
    ).rejects.toMatchObject({ kind: 'denied', details: { reason: 'private_address' } });
  });

  it('reaches a loopback address only through an entry that is the address itself (or localhost)', async () => {
    const local = await server((_req, res) => res.end('local'));
    const port = new URL(local.url).port;

    // No list, or a list of names: a private target is refused.
    await expect(guardedFetch('web_fetch', local.url, {}, ctx())).rejects.toMatchObject({
      kind: 'denied',
      details: { reason: 'private_address' },
    });
    // An IP entry admits that IP, not a name that resolves to it.
    await expect(
      guardedFetch('web_fetch', `http://localhost:${port}/`, {}, ctx(['127.0.0.1'])),
    ).rejects.toMatchObject({
      kind: 'denied',
      details: { host: 'localhost', reason: 'private_address' },
    });
    // The address itself is admitted.
    const response = await guardedFetch('web_fetch', local.url, {}, ctx(['127.0.0.1']));
    expect(await response.text()).toBe('local');
  });

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    let hits = 0;
    const loop = await server((req, res) => {
      hits += 1;
      res.writeHead(302, { location: `/again-${hits}` });
      res.end();
    });

    await expect(
      guardedFetch('http_request', loop.url, {}, ctx(['127.0.0.1'])),
    ).rejects.toMatchObject({
      kind: 'failed',
    });
    expect(hits).toBe(MAX_REDIRECTS + 1);
  });

  it('turns a POST answered 303 into a body-less GET, and keeps a 307 a POST with its body', async () => {
    const seen: string[] = [];
    const echo = await server((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        if (req.url === '/see-other') {
          res.writeHead(303, { location: '/done' });
          res.end();
        } else if (req.url === '/temporary') {
          res.writeHead(307, { location: '/done' });
          res.end();
        } else {
          res.end('ok');
        }
      });
    });
    const context = ctx(['127.0.0.1']);

    await guardedFetch(
      'http_request',
      `${echo.url}/see-other`,
      { method: 'POST', body: 'payload' },
      context,
    );
    await guardedFetch(
      'http_request',
      `${echo.url}/temporary`,
      { method: 'POST', body: 'payload' },
      context,
    );

    expect(seen).toEqual([
      'POST /see-other payload',
      'GET /done ',
      'POST /temporary payload',
      'POST /done payload',
    ]);
  });

  it('drops credentials when a redirect leaves the origin they were sent to', async () => {
    let received: string | undefined = 'unset';
    const other = await server((req, res) => {
      received = req.headers.authorization;
      res.end('ok');
    });
    const start = await server((_req, res) => {
      res.writeHead(302, { location: other.url });
      res.end();
    });

    await guardedFetch(
      'http_request',
      start.url,
      { headers: { Authorization: 'Bearer secret-value' } },
      ctx(['127.0.0.1']),
    );
    expect(received).toBeUndefined();
  });

  it('will not follow a redirect to a scheme other than http(s)', async () => {
    const start = await server((_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    });
    await expect(
      guardedFetch('web_fetch', start.url, {}, ctx(['127.0.0.1'])),
    ).rejects.toMatchObject({
      kind: 'denied',
      details: { reason: 'redirect_scheme' },
    });
  });
});
