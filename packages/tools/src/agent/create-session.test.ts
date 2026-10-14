import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSession } from './create-session.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
});

describe('agentic nodes: one session per run', () => {
  it('shares one ledger, one set of locks and one process table across its nodes', async () => {
    const session = createAgentSession();
    session.ledger.record('A', 'C:/p/x.ts', 'h1');
    expect(session.ledger.seen('A', 'C:/p/x.ts')).toBe('h1');
    expect(session.ledger.seen('B', 'C:/p/x.ts')).toBeUndefined();
    await expect(session.locks.withLock('C:/p/x.ts', async () => 7)).resolves.toBe(7);
    expect(session.processes.list()).toEqual([]);
  });

  it('killAll ends the background commands its nodes started', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ace-session-'));
    folders.push(cwd);
    const session = createAgentSession();
    const { processId } = session.processes.start({
      nodeId: 'A',
      command: 'node -e "setInterval(() => {}, 1000)"',
      cwd,
    });
    expect(session.processes.output(processId)?.running).toBe(true);
    await session.processes.killAll();
    expect(session.processes.list().every((info) => !info.running)).toBe(true);
  }, 20_000);
});
