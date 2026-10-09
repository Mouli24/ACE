import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';
import { ASSET_CACHE_CONTROL, PAGE_CACHE_CONTROL, resolveInside } from '../web.js';

/*
 * D297 against a real engine: `webDir` set, real HTTP. The folder beside `web/` holds a file no
 * request may ever read, so every traversal attempt below has something to find if it worked.
 */

const INDEX = '<!doctype html><html><head><title>ACE</title></head><body>spa</body></html>';
const SCRIPT = 'console.info("asset");';
const SECRET = 'TOP SECRET — outside the web dir';

let root: string;
let engine: RunningEngine;
let bare: RunningEngine | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ace-web-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), INDEX);
  writeFileSync(join(web, 'assets', 'index-abc123.js'), SCRIPT);
  writeFileSync(join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'secret.txt'), SECRET);
  engine = await startEngine({ dataDir: join(root, 'data'), port: 0, webDir: web });
}, 60_000);

afterAll(async () => {
  await engine?.stop();
  await bare?.stop();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows may still hold the SQLite handle; temp is reclaimed by the OS.
  }
});

const get = (path: string, init?: RequestInit) => fetch(`${engine.url}${path}`, init);
const auth = () => ({ authorization: `Bearer ${engine.token}` });

/** A request sent byte for byte — no URL parser folding `..` first. */
function raw(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: engine.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('FR-DSK-002 the engine serves the SPA when ACE_WEB_DIR is set (D297)', () => {
  it('GET / answers index.html with no token, never cached', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe(PAGE_CACHE_CONTROL);
    expect(await res.text()).toBe(INDEX);
  });

  it('a client-side route answers index.html', async () => {
    for (const path of ['/projects/abc', '/projects/p1/workflows/w1', '/help/getting-started']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('a hashed asset is served as itself, cached for a year', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
    expect(await res.text()).toBe(SCRIPT);
  });

  it('another file at the root is served as itself, not cached', async () => {
    const res = await get('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/svg/);
    expect(res.headers.get('cache-control')).toBe(PAGE_CACHE_CONTROL);
  });

  it('a missing asset is a 404, not a page posing as a script', async () => {
    const res = await get('/assets/gone-123.js');
    expect(res.status).toBe(404);
    ApiErrorSchema.parse(await res.json());
  });

  it('HEAD answers the headers without a body', async () => {
    const res = await get('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('GET /api/v1/health without a token is still 401, with it 200', async () => {
    expect((await get('/api/v1/health')).status).toBe(401);
    expect((await get('/api/v1/health', { headers: auth() })).status).toBe(200);
  });

  it('an unknown /api/v1 route is still the JSON 404 envelope', async () => {
    const res = await get('/api/v1/x', { headers: auth() });
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('a foreign Origin still gets 403, page or not', async () => {
    const res = await get('/', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it.each([
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/..%2fsecret.txt',
    '/..%2Fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/..\\secret.txt',
    '/%252e%252e/secret.txt',
    '/secret.txt%00.html',
  ])('cannot read outside webDir: %s', async (path) => {
    const res = await raw(path);
    expect(res.body).not.toContain('TOP SECRET');
    expect([200, 400, 404]).toContain(res.status);
  });
});

describe('FR-DSK-002 resolveInside', () => {
  it('keeps paths inside the root and refuses the rest', () => {
    const base = join(tmpdir(), 'w');
    expect(resolveInside(base, '/')).toBe(base);
    expect(resolveInside(base, '/a/b.js')).toBe(join(base, 'a', 'b.js'));
    expect(resolveInside(base, '/../x')).toBeUndefined();
    expect(resolveInside(base, '/..%2fx')).toBeUndefined();
    expect(resolveInside(base, '/a%5cb')).toBeUndefined();
    expect(resolveInside(base, '/a%00b')).toBeUndefined();
    expect(resolveInside(base, '/%E0%A4%A')).toBeUndefined();
    expect(resolveInside(base, 'relative')).toBe(join(base, 'relative'));
  });
});

describe('FR-DSK-002 without ACE_WEB_DIR nothing changes (D297)', () => {
  it('a page path needs the token like everything else', async () => {
    bare = await startEngine({ dataDir: join(root, 'bare'), port: 0 });
    expect((await fetch(`${bare.url}/`)).status).toBe(401);
    const unknown = await fetch(`${bare.url}/projects/abc`, {
      headers: { authorization: `Bearer ${bare.token}` },
    });
    expect(unknown.status).toBe(404);
  }, 60_000);

  it('a webDir with no index.html refuses to start, saying what to do', async () => {
    const empty = join(root, 'empty-web');
    mkdirSync(empty, { recursive: true });
    await expect(
      startEngine({ dataDir: join(root, 'refused'), port: 0, webDir: empty }),
    ).rejects.toThrow(/Refusing to start: ACE_WEB_DIR .* has no index\.html/);
  });
});
