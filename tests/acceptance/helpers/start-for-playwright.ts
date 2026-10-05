import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTestEngine, type TestEngine } from './engine.js';

/**
 * Playwright's `webServer` runs a command, not a function, so the engine needs a tiny entry of its
 * own. It writes the token where the spec files can read it, because Playwright cannot hand an
 * environment variable back from a started server.
 *
 * Round 5 adds a loopback control endpoint beside it — the harness's own lever, never a route of the
 * engine's API (as `test-control.ts` is for the Vitest half). Three round 5 rows need an engine the
 * shared one cannot be: TC-ONB-001 (onboarding on a clean data dir), TC-SYS-006 (a setting survives
 * an engine restart) and FR-SYS-012 (a backup restored into a clean data dir). The web build has the
 * engine's URL baked in (`VITE_ACE_URL`), so each swap keeps the same port:
 *
 *   POST /engine/restart   stop the engine and start it again on the same data dir
 *   POST /engine/fresh     stop it and start one on a brand-new, empty data dir
 *   POST /engine/original  go back to the data dir the suite started on (a no-op when already there)
 *
 * Each answers the new handle and rewrites the handle file, because the engine mints a new session
 * token at every start (`generateSessionToken`). Requests carry the control token from the handle
 * file; the server binds 127.0.0.1 only. Every data dir made here is removed when the process stops.
 */
const port = Number(process.argv[2] ?? 47_470);
const webPort = Number(process.argv[3] ?? 47_471);

// The preview origin the web app is served from; without it the browser gets a 403 (D27).
const allowedOrigins = [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`];

/** Next to the config, not in `process.cwd()`: Playwright starts this with its own directory. */
const handleFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.playwright-engine.json');

const dataDirs: string[] = [];
function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-acceptance-'));
  dataDirs.push(dir);
  return dir;
}

/**
 * Start on a data dir, on the fixed port — Playwright polls a URL it was given up front, and the web
 * build points at it. Right after a stop the port can still be held for a moment on Windows, so an
 * EADDRINUSE is retried for a few seconds before it is reported.
 */
async function boot(dataDir: string): Promise<TestEngine> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const engine = await startTestEngine({ port, allowedOrigins, dataDir });
      await settle(engine);
      return engine;
    } catch (error) {
      const busy = String((error as { code?: unknown }).code ?? error).includes('EADDRINUSE');
      if (!busy || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * An engine started a second time in this one process answers its first `GET /providers` with a 500
 * (`provider` / `internal`) when its data dir already holds providers; the second call answers 200,
 * and so does the first call after a restart in a new process (measured 2026-10-05 with
 * `standalone-engine.ts`). That is this harness's in-process restart, not what a user's restart does,
 * so the harness takes that first answer itself before handing the engine over — and says so.
 */
async function settle(engine: TestEngine): Promise<void> {
  const answers: number[] = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const status = await fetch(`${engine.url}/api/v1/providers`, {
      headers: { authorization: `Bearer ${engine.token}` },
    }).then(
      async (response) => {
        await response.arrayBuffer();
        return response.status;
      },
      () => 0,
    );
    answers.push(status);
    if (status === 200) {
      if (attempt > 1) {
        process.stdout.write(
          `acceptance engine settled: GET /providers answered ${answers.join(', ')}\n`,
        );
      }
      return;
    }
  }
  await engine.stop();
  throw new Error(`the engine never answered GET /providers with 200 (${answers.join(', ')})`);
}

const originalDataDir = newDataDir();
let current: { engine: TestEngine; dataDir: string } = {
  engine: await boot(originalDataDir),
  dataDir: originalDataDir,
};

const controlToken = randomBytes(24).toString('hex');
let controlUrl = '';

interface Handle {
  url: string;
  wsUrl: string;
  token: string;
  dataDir: string;
  controlUrl: string;
  controlToken: string;
}

function handle(): Handle {
  return {
    url: current.engine.url,
    wsUrl: current.engine.wsUrl,
    token: current.engine.token,
    dataDir: current.dataDir,
    controlUrl,
    controlToken,
  };
}

function writeHandle(): void {
  writeFileSync(handleFile, JSON.stringify(handle(), null, 2));
}

async function switchTo(dataDir: string): Promise<Handle> {
  const started = Date.now();
  await current.engine.stop();
  const stopped = Date.now();
  current = { engine: await boot(dataDir), dataDir };
  writeHandle();
  process.stdout.write(
    `acceptance engine swapped to ${dataDir}: stop ${stopped - started} ms, start ${Date.now() - stopped} ms
`,
  );
  return handle();
}

/** One swap at a time: a second request waits for the first to finish. */
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

const ACTIONS: Record<string, () => Promise<Handle>> = {
  '/engine/restart': () => switchTo(current.dataDir),
  '/engine/fresh': () => switchTo(newDataDir()),
  '/engine/original': () =>
    current.dataDir === originalDataDir ? Promise.resolve(handle()) : switchTo(originalDataDir),
};

function sameToken(given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(controlToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

const control: Server = createServer((request, response) => {
  const answer = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  if (!sameToken(bearer)) return answer(401, { error: 'unauthorized' });
  const action = request.method === 'POST' ? ACTIONS[request.url ?? ''] : undefined;
  if (action === undefined) return answer(404, { error: 'not found' });
  request.resume();
  serialised(action).then(
    (next) => answer(200, next),
    (error: unknown) => answer(500, { error: String(error) }),
  );
});

await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
controlUrl = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
writeHandle();

process.stdout.write(`acceptance engine ready at ${current.engine.url} (control ${controlUrl})\n`);

const stop = (): void => {
  control.close();
  void current.engine
    .stop()
    .catch(() => undefined)
    .then(() => {
      for (const dir of dataDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Windows can hold the SQLite WAL handle briefly after close; the OS reclaims temp itself.
        }
      }
      process.exit(0);
    });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
