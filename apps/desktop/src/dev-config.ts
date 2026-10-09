import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `DEFAULT_ENGINE_PORT` in `@ace/contracts`; pinned by `dev-config.test.ts`. */
export const DEFAULT_ENGINE_PORT = 4747;
/** `DEFAULT_WEB_ORIGIN` in `@ace/contracts`: where `pnpm dev` serves the web app. */
export const DEV_WEB_URL = 'http://localhost:5173';
/** The engine binds loopback only (FR-SYS-001). */
export const ENGINE_HOST = '127.0.0.1';
export const SESSION_TOKEN_FILE = 'session-token';
const CONFIG_FILE = 'ace.config.json';

/** Where the dev window finds the engine and the web app that `pnpm dev` started (D295). */
export interface DevConfig {
  dataDir: string;
  /** `<dataDir>/session-token`, rewritten by the engine on every start. */
  tokenFile: string;
  port: number;
  engineUrl: string;
  webUrl: string;
}

export interface ResolveDevConfigOptions {
  env: Record<string, string | undefined>;
  home?: string;
  /** Text of a file, or `undefined` when it cannot be read. */
  readFile?: (path: string) => string | undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function validPort(value: unknown): number | undefined {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

/**
 * Resolve the data dir and the port the way the engine does, so the dev window looks where
 * `pnpm dev`'s engine actually is (D295).
 *
 * The engine's rules (`resolveDataDir` in `apps/server/src/cli.ts`, `loadEngineConfig` in
 * `packages/engine`): the data dir is `ACE_DATA_DIR`, else `~/.ace` — and inside that,
 * `ace.config.json` may name another one; the port is `ACE_PORT`, else the file's `port`, else 4747.
 * Where the engine would refuse to start (an invalid `ACE_PORT`, a file that is not JSON) this
 * falls through to the next source instead: the window keeps waiting either way, and the engine's
 * own console says what is wrong.
 */
export function resolveDevConfig({
  env,
  home = homedir(),
  readFile = readText,
}: ResolveDevConfigOptions): DevConfig {
  const fromEnv = env['ACE_DATA_DIR'] === '' ? undefined : env['ACE_DATA_DIR'];
  const base = fromEnv ?? join(home, '.ace');

  let file: { port?: unknown; dataDir?: unknown } = {};
  const raw = readFile(join(base, CONFIG_FILE));
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') file = parsed;
    } catch {
      // Not JSON: the engine refuses to start and says so; nothing here to resolve from.
    }
  }

  const dataDir =
    fromEnv ?? (typeof file.dataDir === 'string' && file.dataDir !== '' ? file.dataDir : base);
  const port = validPort(env['ACE_PORT']) ?? validPort(file.port) ?? DEFAULT_ENGINE_PORT;

  return {
    dataDir,
    tokenFile: join(dataDir, SESSION_TOKEN_FILE),
    port,
    engineUrl: `http://${ENGINE_HOST}:${port}`,
    webUrl: DEV_WEB_URL,
  };
}
