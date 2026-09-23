/**
 * A standalone engine process for the §8 manual-pass checks: one that can be killed with SIGKILL
 * and restarted on the same data directory. `startTestEngine` runs the engine in-process, which is
 * right for the suite and useless for a crash test — there is no pid to kill.
 *
 * argv: <dataDir> <port> <handleFile> [extraAllowedOrigins,comma,separated]
 */
import { writeFileSync } from 'node:fs';

import { startEngine } from '@ace/server';

const [dataDir, portArg, handleFile, originsArg] = process.argv.slice(2);
if (!dataDir || !portArg || !handleFile) {
  throw new Error('usage: standalone-engine.ts <dataDir> <port> <handleFile> [origins]');
}

const engine = await startEngine({ dataDir, port: Number(portArg), env: {} });

// The preview origin is in neither `settings.allowedOrigins` nor the engine's own origins (D27),
// so a page served from it is a 403 until it is added the way a user would — through the API.
const extraOrigins = (originsArg ?? '').split(',').filter((origin) => origin.length > 0);
if (extraOrigins.length > 0) {
  const headers = {
    Authorization: `Bearer ${engine.token}`,
    'content-type': 'application/json',
  };
  const current = await fetch(`${engine.url}/api/v1/settings`, { headers });
  if (!current.ok) throw new Error(`could not read settings: ${current.status}`);
  const settings = (await current.json()) as { allowedOrigins: string[] };
  const patched = await fetch(`${engine.url}/api/v1/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      allowedOrigins: [...new Set([...settings.allowedOrigins, ...extraOrigins])],
    }),
  });
  if (!patched.ok) throw new Error(`could not allow origins: ${patched.status}`);
}

writeFileSync(
  handleFile,
  JSON.stringify({
    url: engine.url,
    wsUrl: engine.wsUrl,
    token: engine.token,
    pid: process.pid,
    dataDir,
  }),
);

// Deliberately no signal handlers: the point of these checks is an unclean death.
