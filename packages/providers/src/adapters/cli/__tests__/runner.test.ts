import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-runner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(
  mode: string,
  options: { stdin?: string; cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
) {
  return runCli({
    command: process.execPath,
    args: [FAKE],
    cwd: options.cwd ?? dir,
    env: { ...process.env, FAKE_CLI_MODE: mode, ...options.env },
    stdin: options.stdin ?? '',
    signal: options.signal ?? new AbortController().signal,
  });
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('X1 running a CLI (review focus 2–4)', () => {
  it('delivers a 64 KB prompt with shell metacharacters intact', async () => {
    const prompt = `"quoted" %PATH% ^caret & amp | pipe < > \n`.repeat(1600);
    expect(prompt.length).toBeGreaterThan(64_000);
    const run = start('echo-stdin', { stdin: prompt });
    const [line] = await collect(run.lines);
    const echoed = JSON.parse(line!) as { length: number; sha: string };
    expect(echoed.length).toBe(prompt.length);
    expect(echoed.sha).toBe(createHash('sha256').update(prompt).digest('hex'));
    expect((await run.exit).code).toBe(0);
  });

  it('runs in a working directory whose name has a space', async () => {
    const spaced = join(dir, 'ACE offcl', 'demo project');
    mkdirSync(spaced, { recursive: true });
    const [line] = await collect(start('echo-stdin', { cwd: spaced }).lines);
    expect(realpathSync((JSON.parse(line!) as { cwd: string }).cwd)).toBe(realpathSync(spaced));
  });

  it('yields whole lines when the output arrives in pieces', async () => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"type":"a","text":"one"}\r\nnot json\n{"type":"b","text":"two"}\n');
    const lines = await collect(start('replay', { env: { FAKE_CLI_FILE: file } }).lines);
    expect(lines).toEqual(['{"type":"a","text":"one"}', 'not json', '{"type":"b","text":"two"}']);
  });

  it('keeps the tail of stderr and the exit code', async () => {
    const run = start('stderr-exit');
    await collect(run.lines);
    const exit = await run.exit;
    expect(exit.code).toBe(3);
    expect(exit.stderrTail.length).toBeLessThanOrEqual(8192);
    expect(exit.stderrTail.endsWith('END')).toBe(true);
  });

  it('abort kills the process tree, grandchild included, within 2 s', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const controller = new AbortController();
    const run = start('hang-with-child', { env: { FAKE_CLI_PIDFILE: pidFile }, signal: controller.signal });
    const iterator = run.lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('{"type":"ready"}');
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    const stoppedAt = Date.now();
    controller.abort();
    const exit = await run.exit;
    expect(exit.killed).toBe(true);
    for (let i = 0; i < 40 && alive(grandchild); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(grandchild)).toBe(false);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
  });

  it('reports a binary that does not exist instead of throwing', async () => {
    const run = runCli({
      command: join(dir, 'missing.exe'),
      args: [],
      cwd: dir,
      env: process.env,
      stdin: '',
      signal: new AbortController().signal,
    });
    expect(await collect(run.lines)).toEqual([]);
    expect((await run.exit).spawnError?.code).toBe('ENOENT');
  });
});
