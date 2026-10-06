/**
 * Lays `overrides` over `base` for a child process. A key set to `undefined` removes it.
 *
 * On Windows environment names are case-insensitive, and a spread of `process.env` keeps the
 * system's own casing (`Path`, `ComSpec`): an override of `PATH` must replace `Path`, not sit next
 * to it and lose to it when the child's block is built.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (overrides === undefined) return env;
  for (const [key, value] of Object.entries(overrides)) {
    unsetEnv(env, key, platform);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Removes `key` from `env` — every casing of it on Windows. */
export function unsetEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    delete env[key];
    return;
  }
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper) delete env[existing];
  }
}
