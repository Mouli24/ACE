/**
 * `pnpm desktop:stage` — lay out what the packaged app ships beside its asar (D298):
 *
 *   apps/desktop/stage/
 *     node/node.exe   the Node running this script — the one that installed the native modules
 *     engine/         `pnpm deploy --prod` of apps/server: dist/main.js + a flat node_modules
 *     web/            apps/web/dist
 *
 * then prove it runs: the three native modules load under that node.exe, and the staged engine,
 * started the way the app starts it (the same supervisor, IPC and all), serves the SPA and the API
 * with sqlite-vec loaded, and stops cleanly on `shutdown`. Anything missing fails loudly.
 *
 * Run with tsx (no bundler). `--skip-build` reuses the last build, for iterating on this script.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startEngineProcess } from '../src/engine-process.js';
import { pickFreePort } from '../src/ports.js';

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(DESKTOP, '..', '..');
const STAGE = join(DESKTOP, 'stage');

/** The engine-side workspace packages the deployed engine must carry, each with its dist. */
export const ENGINE_PACKAGES = [
  'contracts',
  'engine',
  'storage-local',
  'providers',
  'guardrails',
  'context',
  'tools',
];

/** The native modules' win32-x64 binaries (relative to the engine's node_modules). */
export const NATIVE_BINARIES = [
  'better-sqlite3/build/Release/better_sqlite3.node',
  'sqlite-vec-windows-x64/vec0.dll',
  '@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node',
];

/** What a deployed engine tree is missing; empty when it is complete. */
export function engineTreeProblems(engineDir: string): string[] {
  const problems: string[] = [];
  const need = (path: string, what: string): void => {
    if (!existsSync(join(engineDir, path))) problems.push(`${what}: ${path} is missing`);
  };
  need(join('dist', 'main.js'), 'the engine entry');
  for (const name of ENGINE_PACKAGES) {
    need(join('node_modules', '@ace', name, 'dist', 'index.js'), `@ace/${name}`);
  }
  need(
    join('node_modules', '@ace', 'providers', 'dist', 'catalog', 'manifest.json'),
    'the model catalog',
  );
  for (const binary of NATIVE_BINARIES) need(join('node_modules', binary), 'a native module');
  return problems;
}

/** Why this Node may not be shipped, or `undefined` when its major matches `.nvmrc` (D293). */
export function nodeVersionProblem(version: string, nvmrc: string): string | undefined {
  const want = nvmrc.trim().replace(/^v/, '').split('.')[0];
  const have = version.replace(/^v/, '').split('.')[0];
  return want === have
    ? undefined
    : `Node ${version} is running this script, but .nvmrc says ${want}.`;
}

export class StageError extends Error {}

/**
 * pnpm 9's `deploy` with a relative target also writes the target's `node_modules/.bin` shims under
 * the *deployed package* (`apps/server/<target>/node_modules/.bin`) — and the next deploy copies that
 * folder along. Remove such a folder, but only when everything in it is under a `node_modules`.
 */
export function removeDeployLeftover(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stray = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() && !join(entry.parentPath, entry.name).split(/[\\/]/).includes('node_modules'),
  );
  if (stray.length > 0) {
    throw new StageError(`${dir} holds files outside node_modules; not removing it.`);
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** A log line saying sqlite-vec fell back to the exact scan (`apps/server/src/server.ts`). */
export const SCAN_FALLBACK = 'sqlite-vec could not be loaded';

/* ------------------------------------------------------------------------ */

const say = (line: string): void => console.info(`\x1b[36m[stage]\x1b[0m ${line}`);

function run(command: string): void {
  say(`> ${command}`);
  const result = spawnSync(command, { cwd: REPO, shell: true, stdio: 'inherit' });
  if (result.status !== 0) throw new StageError(`"${command}" failed (exit ${result.status}).`);
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/** Load the three native modules under the staged Node, from the engine's own node_modules. */
function checkNativesLoad(nodeExe: string, engineDir: string): string {
  const script = [
    "const Database = require('better-sqlite3');",
    "const vec = require('sqlite-vec');",
    "const keyring = require('@napi-rs/keyring');",
    "const db = new Database(':memory:');",
    'vec.load(db);',
    "const version = db.prepare('select vec_version() as v').get().v;",
    "if (typeof keyring.Entry !== 'function') throw new Error('keyring has no Entry');",
    "process.stdout.write('vec ' + version);",
  ].join(' ');
  const result = spawnSync(nodeExe, ['-e', script], { cwd: engineDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new StageError(`The native modules do not load under the staged Node:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function smokeTest(nodeExe: string, engineDir: string, webDir: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'ace-stage-smoke-'));
  const dataDir = join(scratch, 'data');
  const port = await pickFreePort();
  const engine = startEngineProcess({
    nodePath: nodeExe,
    mainPath: join(engineDir, 'dist', 'main.js'),
    cwd: scratch,
    env: { ...process.env, ACE_DATA_DIR: dataDir, ACE_PORT: String(port), ACE_WEB_DIR: webDir },
  });
  try {
    const ready = await engine.ready;
    say(`engine ready at ${ready.url}`);

    const page = await fetch(`${ready.url}/`);
    const html = await page.text();
    if (page.status !== 200 || !html.includes('<div id="root">')) {
      throw new StageError(`GET / answered ${page.status}, not the SPA's index.html.`);
    }
    const route = await fetch(`${ready.url}/projects/p1`);
    if (route.status !== 200) throw new StageError(`GET /projects/p1 answered ${route.status}.`);

    const health = await fetch(`${ready.url}/api/v1/health`, {
      headers: { authorization: `Bearer ${ready.token}` },
    });
    if (health.status !== 200) throw new StageError(`/api/v1/health answered ${health.status}.`);
    const denied = await fetch(`${ready.url}/api/v1/health`);
    if (denied.status !== 401)
      throw new StageError(`/api/v1/health without the token: ${denied.status}.`);

    const result = await engine.shutdown(15_000);
    const exit = await engine.exited;
    if (result !== 'clean' || exit.code !== 0) {
      throw new StageError(`shutdown ended ${result} with exit code ${exit.code}.`);
    }
    say('shutdown: exit 0');

    const logs = join(dataDir, 'logs');
    const text = readdirSync(logs)
      .map((name) => readFileSync(join(logs, name), 'utf8'))
      .join('\n');
    if (text.includes(SCAN_FALLBACK)) {
      throw new StageError(`The staged engine fell back to the exact scan: "${SCAN_FALLBACK}".`);
    }
    if (!text.includes('engine ready')) throw new StageError('The engine log was not written.');
    say('sqlite-vec loaded (no scan fallback in the log)');
  } finally {
    await engine.shutdown(5_000); // 'already-exited' after a clean run; stops it after a failure
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes('--skip-build');

  say('1/5 build: packages, server, web, desktop');
  if (skipBuild) say('(skipped: --skip-build)');
  else
    run(
      'pnpm --filter "./packages/**" --filter @ace/server --filter @ace/web --filter @ace/desktop build',
    );

  say(`2/5 deploy the engine into ${relative(REPO, STAGE)}`);
  rmSync(STAGE, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(STAGE, { recursive: true });
  // A relative target: pnpm 9 joins an absolute one onto the workspace root on Windows.
  const engineDir = join(STAGE, 'engine');
  const target = relative(REPO, engineDir).replace(/\\/g, '/');
  const top = target.split('/')[0] ?? 'apps';
  removeDeployLeftover(join(REPO, 'apps', 'server', top));
  run(`pnpm --filter @ace/server deploy --prod "${target}"`);
  removeDeployLeftover(join(REPO, 'apps', 'server', top));
  removeDeployLeftover(join(engineDir, top));
  rmSync(join(engineDir, 'test-results'), { recursive: true, force: true });
  const problems = engineTreeProblems(engineDir);
  if (problems.length > 0) {
    throw new StageError(`The deployed engine is incomplete:\n- ${problems.join('\n- ')}`);
  }
  say(
    `engine complete: dist, ${ENGINE_PACKAGES.length} @ace packages, ${NATIVE_BINARIES.length} native binaries`,
  );

  say('3/5 node.exe');
  const nvmrc = readFileSync(join(REPO, '.nvmrc'), 'utf8');
  const versionProblem = nodeVersionProblem(process.version, nvmrc);
  if (versionProblem !== undefined) throw new StageError(versionProblem);
  const nodeExe = join(STAGE, 'node', 'node.exe');
  mkdirSync(join(STAGE, 'node'), { recursive: true });
  cpSync(process.execPath, nodeExe);
  say(`copied ${process.execPath} (${process.version})`);

  say('4/5 web');
  const webBuild = join(REPO, 'apps', 'web', 'dist');
  if (!existsSync(join(webBuild, 'index.html'))) {
    throw new StageError(`${webBuild} has no index.html; build the web app first.`);
  }
  const webDir = join(STAGE, 'web');
  cpSync(webBuild, webDir, { recursive: true });

  say('5/5 smoke test');
  say(`natives load: ${checkNativesLoad(nodeExe, engineDir)}`);
  await smokeTest(nodeExe, engineDir, webDir);

  const mb = (dir: string): string => `${(sizeOf(dir) / 1024 / 1024).toFixed(0)} MB`;
  say(`staged: node ${mb(join(STAGE, 'node'))}, engine ${mb(engineDir)}, web ${mb(webDir)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      `\x1b[31m[stage]\x1b[0m ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
