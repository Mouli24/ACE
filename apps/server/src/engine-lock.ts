import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D409: one engine per data folder. The desktop app and Start ACE both open `~/.ace` (D408); two
 * engines on one database would each drive their own runs and chat turns against the same rows.
 * The engine that starts first writes `<dataDir>/engine.lock`; another finds it, sees that engine
 * still alive and answering, and stops before it opens anything. A lock whose engine is gone — it
 * crashed, or a restart killed it — is stale and simply taken over.
 */
export const ENGINE_LOCK_FILE = 'engine.lock';

export interface EngineLockRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export function readEngineLock(dataDir: string): EngineLockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, ENGINE_LOCK_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const { pid, port, startedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof port !== 'number') return undefined;
    return { pid, port, startedAt: typeof startedAt === 'string' ? startedAt : '' };
  } catch {
    return undefined;
  }
}

/** Whether a process with this id exists; `EPERM` means it does, run by someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether an engine answers on this loopback port — any HTTP answer, a 401 included. */
async function engineAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export class EngineAlreadyRunningError extends Error {
  override readonly name = 'EngineAlreadyRunningError';
}

/**
 * Refuse to start while another engine holds this data folder. Both checks are needed: a process id
 * on its own can be reused by an unrelated program after a crash, and a port on its own can be.
 */
export async function refuseSecondEngine(
  dataDir: string,
  checks: {
    alive?: (pid: number) => boolean;
    answers?: (port: number) => Promise<boolean>;
  } = {},
): Promise<void> {
  const held = readEngineLock(dataDir);
  if (held === undefined || held.pid === process.pid) return;
  const alive = checks.alive ?? processAlive;
  const answers = checks.answers ?? engineAnswers;
  if (!alive(held.pid) || !(await answers(held.port))) return;
  throw new EngineAlreadyRunningError(
    `ACE is already open on this data (${dataDir}), as process ${held.pid} on port ` +
      `${held.port}. Only one ACE can use it at a time: close the other one (the desktop app, ` +
      'or the Start ACE window) and try again.',
  );
}

/** Write this engine's lock; the function returned removes it again, if it is still this one's. */
export function holdEngineLock(dataDir: string, port: number): () => void {
  const file = join(dataDir, ENGINE_LOCK_FILE);
  const record: EngineLockRecord = { pid: process.pid, port, startedAt: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  return () => {
    try {
      if (readEngineLock(dataDir)?.pid === process.pid) unlinkSync(file);
    } catch {
      // Already gone: nothing to release.
    }
  };
}
