import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * Configuration resolution (FR-SYS-010, Arch §29).
 *
 * Precedence is node → project → user → engine → defaults, and every layer is validated by Zod at
 * startup. An invalid engine config is fatal: the engine refuses to start and says which file and
 * which field are wrong, rather than booting with a surprising value (TC-SYS-011).
 */

export const CONFIG_PRECEDENCE = ['node', 'project', 'user', 'engine', 'defaults'] as const;
export type ConfigLayer = (typeof CONFIG_PRECEDENCE)[number];

export type ConfigLayers<T> = Partial<Record<ConfigLayer, Partial<T> | undefined>>;

/**
 * Merge the layers by precedence: the highest layer that actually sets a key wins.
 *
 * A key present but `undefined` counts as unset, so a caller can pass a patch straight through
 * without having to strip its empty fields. A key set to `0`, `''` or `false` is a real value and
 * is kept.
 *
 * D25: the `project` layer is part of the contract of this function today even though §2.4's
 * `Project` has no settings field yet — the resolver is complete, and the production project source
 * resolves to `{}` until a later round adds one.
 */
export function resolveConfig<T extends object>(layers: ConfigLayers<T>): Partial<T> {
  const resolved: Partial<T> = {};

  for (const layer of CONFIG_PRECEDENCE) {
    const values = layers[layer];
    if (values === undefined) continue;

    for (const [key, value] of Object.entries(values) as [keyof T, T[keyof T]][]) {
      if (value === undefined) continue;
      if (key in resolved) continue;
      resolved[key] = value;
    }
  }

  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Engine layer: ace.config.json + env                                         */
/* -------------------------------------------------------------------------- */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * `host` is deliberately absent: FR-SYS-001 says the engine listens on 127.0.0.1 and nothing else,
 * so there is no configuration key that could widen it.
 */
export const EngineConfigFileSchema = z.object({
  port: z.number().int().min(1).max(65_535).optional(),
  dataDir: z.string().optional(),
  logLevel: z.enum(LOG_LEVELS).optional(),
  logRetentionDays: z.number().int().min(1).max(365).optional(),
});
export type EngineConfigFile = z.infer<typeof EngineConfigFileSchema>;

export interface EngineConfig {
  /** Always 127.0.0.1 (FR-SYS-001, NFR-SEC-01). */
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  logLevel: (typeof LOG_LEVELS)[number];
  logRetentionDays: number;
  /**
   * `ACE_WEB_DIR` (D297): a built web app (`apps/web/dist`) the engine serves on its own origin, as
   * the packaged desktop app needs. Unset — `pnpm dev`, the browser, the tests — and the engine
   * serves the API only, as before.
   */
  webDir?: string;
}

export const DEFAULT_ENGINE_CONFIG = {
  host: '127.0.0.1',
  port: 4747,
  logLevel: 'info',
  /** FR-SYS-011: local logs are kept for 14 days. */
  logRetentionDays: 14,
} as const;

export const ENGINE_CONFIG_FILENAME = 'ace.config.json';

/** Fatal configuration problem — the engine refuses to start (FR-SYS-010, TC-SYS-011). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(message: string) {
    super(`Refusing to start: ${message}`);
  }
}

export interface LoadEngineConfigOptions {
  dataDir: string;
  env: Record<string, string | undefined>;
}

function readConfigFile(path: string): EngineConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No config file is the normal case — defaults apply.
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON (${(error as Error).message}). Fix the file or delete it to use the defaults.`,
    );
  }

  const result = EngineConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`${path} is invalid — ${problems}.`);
  }

  return result.data;
}

function readPortFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env['ACE_PORT'];
  if (raw === undefined || raw === '') return undefined;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`ACE_PORT must be a port number between 1 and 65535, got "${raw}".`);
  }
  return port;
}

/**
 * Build the engine layer from `<dataDir>/ace.config.json` and the environment, then fold in the
 * defaults. Env beats the file, which beats the defaults.
 */
export function loadEngineConfig({ dataDir, env }: LoadEngineConfigOptions): EngineConfig {
  const file = readConfigFile(join(dataDir, ENGINE_CONFIG_FILENAME));
  const envPort = readPortFromEnv(env);
  const webDir = env['ACE_WEB_DIR'];

  return {
    host: DEFAULT_ENGINE_CONFIG.host,
    port: envPort ?? file.port ?? DEFAULT_ENGINE_CONFIG.port,
    dataDir: env['ACE_DATA_DIR'] ?? file.dataDir ?? dataDir,
    logLevel: file.logLevel ?? DEFAULT_ENGINE_CONFIG.logLevel,
    logRetentionDays: file.logRetentionDays ?? DEFAULT_ENGINE_CONFIG.logRetentionDays,
    ...(webDir === undefined || webDir === '' ? {} : { webDir }),
  };
}
