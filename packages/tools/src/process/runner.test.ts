import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessStream } from '@ace/contracts';
import { isWorkspaceFsError, type ProcessHandlers, type ProcessRunner } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProcessRunner, resolveWorkingFolder, shellCommand } from './runner.js';

let root: string;
let project: string;
/** Every process a test started, so cleanup can end it before its folder is removed. */
const live: Array<{ stop(): void; ended: Promise<void> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-proc-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'src'), { recursive: true });
});
afterEach(async () => {
  // Windows cannot remove a folder a live process runs in: end each one first (stop is a no-op
  // for one that already ended), bounded by the runner's 1.5 s settle.
  for (const run of live.splice(0)) {
    run.stop();
    await run.ended;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // Windows can hold a folder a moment after a process in it ends; the OS reclaims temp itself.
  }
});

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

type Event =
  | [stream: ProcessStream, chunk: string]
  | [kind: 'exit', code: number | null, signal: string | null]
  | [kind: 'error', message: string];

/** Handlers that record every call, with a promise for the end and the text of each stream. */
function collect() {
  const events: Event[] = [];
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const handlers: ProcessHandlers = {
    onOutput: (stream, chunk) => events.push([stream, chunk]),
    onExit: (code, signal) => {
      events.push(['exit', code, signal]);
      end();
    },
    onError: (error) => {
      events.push(['error', error.message]);
      end();
    },
  };
  const text = (stream: ProcessStream = 'stdout'): string =>
    events
      .filter((event) => event[0] === stream)
      .map((event) => String(event[1]))
      .join('')
      .replace(/\r/g, '');
  return { events, handlers, ended, text };
}

const runner = createProcessRunner();

function start(command: string, cwd = '', using: ProcessRunner = runner) {
  const run = collect();
  const handle = using.start({ root: project, cwd, command }, run.handlers);
  live.push({ stop: () => handle.stop(), ended: run.ended });
  return { ...run, handle };
}

/** The refusal code `start` throws for a working folder, or undefined when it starts. */
function refusalFor(cwd: string): string | undefined {
  try {
    const run = collect();
    const handle = runner.start({ root: project, cwd, command: node('1') }, run.handlers);
    live.push({ stop: () => handle.stop(), ended: run.ended });
  } catch (error) {
    return isWorkspaceFsError(error) ? error.code : 'not a WorkspaceFsError';
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('D301 the platform shell, exactly as run_command spawns it', () => {
  it('wraps the line for cmd.exe /d /s /c on Windows and /bin/sh -c elsewhere', () => {
    expect(shellCommand('a && b', 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual([
      'C:\\Windows\\system32\\cmd.exe',
      ['/d', '/s', '/c', '"a && b"'],
    ]);
    expect(shellCommand('a && b', 'win32', {})).toEqual([
      'cmd.exe',
      ['/d', '/s', '/c', '"a && b"'],
    ]);
    expect(shellCommand('a && b', 'linux', {})).toEqual(['/bin/sh', ['-c', 'a && b']]);
    expect(shellCommand('a', 'linux', {}, '/opt/sh')).toEqual(['/opt/sh', ['-c', 'a']]);
  });
});

describe('D301 the terminal’s process runner', () => {
  it('streams output in order and reports the exit code after the last of it', async () => {
    const run = start(
      node(
        "let i = 0; const t = setInterval(() => { console.log('tick ' + i); i += 1; if (i === 3) clearInterval(t); }, 30)",
      ),
    );
    await run.ended;
    expect(run.text()).toBe('tick 0\ntick 1\ntick 2\n');
    expect(run.events.at(-1)).toEqual(['exit', 0, null]);
  });

  it('keeps stdout and stderr apart and reports a failing exit code', async () => {
    const run = start(node("console.error('bad'); process.exit(3)"));
    await run.ended;
    expect(run.text('stderr')).toBe('bad\n');
    expect(run.text('stdout')).toBe('');
    expect(run.events.at(-1)).toEqual(['exit', 3, null]);
  });

  it('writes what the person types to stdin, so a line prompt is answered', async () => {
    const run = start(
      node(
        "process.stdout.write('name? '); process.stdin.once('data', (d) => { console.log('hello ' + String(d).trim()); process.exit(0); })",
      ),
    );
    expect(await until(() => run.text().includes('name? '), 10_000)).toBe(true);
    run.handle.write('Ada\n');
    await run.ended;
    expect(run.text()).toBe('name? hello Ada\n');
  });

  it('Stop kills the shell, its child and its grandchild within 2.5 s', async () => {
    const run = start(
      node(
        "require('child_process').spawn(process.execPath, ['-e', 'console.log([process.pid]); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log('parent ' + process.pid); setInterval(() => {}, 1000)",
      ),
    );
    // FORCE_COLOR=1 (scrubSecrets) makes node colour the number inside `[ 123 ]`: read it plain.
    // eslint-disable-next-line no-control-regex
    const plain = (): string => run.text().replace(/\[[0-9;]*m/g, '');
    expect(await until(() => /parent \d+/.test(plain()) && /\[ \d+ \]/.test(plain()), 10_000)).toBe(
      true,
    );
    const parent = Number(/parent (\d+)/.exec(plain())?.[1]);
    const grandchild = Number(/\[ (\d+) \]/.exec(plain())?.[1]);
    expect(isAlive(parent)).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    // `stop()` starts the kill (taskkill, or the group kill) before it returns; the 2.5 s count
    // from there.
    run.handle.stop();
    expect(await until(() => !isAlive(parent) && !isAlive(grandchild), 2_500)).toBe(true);
    await run.ended;
    expect(run.events.at(-1)).toEqual(['exit', null, 'SIGKILL']);
  }, 20_000);

  it('a stopped process reads as SIGKILL on every platform, never as the exit code the kill left', async () => {
    const run = start(node("console.log('up'); setInterval(() => {}, 1000)"));
    expect(await until(() => run.text().includes('up'), 10_000)).toBe(true);
    run.handle.stop();
    await run.ended;
    // On Windows taskkill /F leaves cmd.exe's exit code 1; the person asked for a stop, not a failure.
    expect(run.events.at(-1)).toEqual(['exit', null, 'SIGKILL']);
  }, 20_000);

  it('a process that ends by itself keeps its own exit code', async () => {
    const run = start(node('process.exit(7)'));
    await run.ended;
    expect(run.events.at(-1)).toEqual(['exit', 7, null]);
  });

  it('never splits a character or an ANSI colour across chunks', async () => {
    // é, ✓ and 😀 are 2, 3 and 4 bytes of UTF-8; each write ends inside one of them, and the
    // fourth inside the colour escape.
    const run = start(
      node(
        "const b = Buffer.from('h\\u00e9 \\u2713 \\ud83d\\ude00 \\u001b[31mred\\u001b[0m\\n'); const cuts = [2, 6, 10, 14]; let at = 0; const next = () => { const end = cuts.shift() ?? b.length; process.stdout.write(b.subarray(at, end)); at = end; if (at < b.length) setTimeout(next, 40); }; next()",
      ),
    );
    await run.ended;
    expect(run.text()).toBe('h\u00e9 \u2713 \ud83d\ude00 \u001b[31mred\u001b[0m\n');
    expect(run.text()).not.toContain('\ufffd');
  });

  it('a process never sees a secret-shaped variable, but keeps SSH_AUTH_SOCK, PATH and HOME', async () => {
    const scrubbing = createProcessRunner({
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-ant-not-real',
        ACE_SESSION_TOKEN: 'not-real',
        ELECTRON_RUN_AS_NODE: '1',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        HOME: '/home/ada',
      },
    });
    const run = start(
      node(
        "console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY || null, token: process.env.ACE_SESSION_TOKEN || null, electron: process.env.ELECTRON_RUN_AS_NODE || null, sock: process.env.SSH_AUTH_SOCK || null, home: process.env.HOME || null, path: (process.env.PATH || '').length > 0, color: process.env.FORCE_COLOR || null, python: process.env.PYTHONUTF8 || null }))",
      ),
      '',
      scrubbing,
    );
    await run.ended;
    expect(JSON.parse(run.text())).toEqual({
      key: null,
      token: null,
      electron: null,
      sock: '/tmp/agent.sock',
      home: '/home/ada',
      path: true,
      color: '1',
      python: '1',
    });
  });

  it('runs a line as the shell would: quotes, &&, | and a variable', async () => {
    const variable = process.platform === 'win32' ? '%ACE_DEMO_VAR%' : '$ACE_DEMO_VAR';
    const withVariable = createProcessRunner({ env: { ...process.env, ACE_DEMO_VAR: 'from-env' } });
    const upper = node(
      "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))",
    );
    const line = `${node("console.log('a & b')")} && ${node("console.log('piped')")} | ${upper} && echo ${variable}`;
    const run = start(line, '', withVariable);
    await run.ended;
    expect(
      run
        .text()
        .split('\n')
        .map((each) => each.trim())
        .filter(Boolean),
    ).toEqual(['a & b', 'PIPED', 'from-env']);
    expect(run.events.at(-1)).toEqual(['exit', 0, null]);
  });

  it('runs in a folder whose name has spaces and unicode', async () => {
    mkdirSync(join(project, 'my dir ü'));
    const run = start(node('console.log(process.cwd())'), 'my dir ü');
    await run.ended;
    expect(realpathSync(run.text().trim())).toBe(realpathSync(join(project, 'my dir ü')));
  });

  it('runs in the project folder itself when the working folder is empty', async () => {
    const run = start(node('console.log(process.cwd())'));
    await run.ended;
    expect(realpathSync(run.text().trim())).toBe(realpathSync(project));
  });

  it('refuses a folder outside the project, .git and a link out, as a file read would (FR-GIT-008)', () => {
    mkdirSync(join(project, '.git'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    // a junction needs no privilege on Windows; elsewhere the type argument is ignored
    symlinkSync(outside, join(project, 'out'), 'junction');

    expect(refusalFor('..')).toBe('outside_project');
    expect(refusalFor('src/../..')).toBe('outside_project');
    expect(refusalFor('C:/Windows')).toBe('outside_project');
    expect(refusalFor('.git')).toBe('protected_path');
    expect(refusalFor('out')).toBe('outside_project');
    expect(refusalFor('src')).toBeUndefined();
  });

  it('refuses a folder that does not exist, and a file, as invalid_path', () => {
    writeFileSync(join(project, 'README.md'), '# hi');
    expect(refusalFor('missing')).toBe('invalid_path');
    expect(refusalFor('README.md')).toBe('invalid_path');
  });

  it('reports a shell that cannot start to onError, never onExit', async () => {
    const broken = createProcessRunner({ shell: join(root, 'no-such-shell') });
    const run = start(node('1'), '', broken);
    await run.ended;
    // A negative check: wait past the 300 ms exit drain, by when a stray onExit would have come.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(run.events).toHaveLength(1);
    expect(run.events[0]?.[0]).toBe('error');
    expect(String(run.events[0]?.[1])).toMatch(/ENOENT/);
    expect(run.handle.pid).toBeUndefined();
  });

  it('drops input once the process has ended, without throwing', async () => {
    const run = start(node('1'));
    await run.ended;
    expect(() => run.handle.write('late\n')).not.toThrow();
    expect(() => run.handle.stop()).not.toThrow();
  });
});

describe('D301 a network folder on Windows (cmd.exe would run in the Windows folder)', () => {
  const message =
    "the terminal can't run in a network folder on Windows — map it to a drive letter";

  it('refuses a UNC project folder with invalid_path, before anything is spawned', () => {
    for (const unc of [
      '\\\\server\\share\\proj',
      '\\\\wsl$\\Ubuntu\\home\\ada',
      '\\\\wsl.localhost\\Ubuntu\\x',
    ]) {
      let thrown: unknown;
      try {
        resolveWorkingFolder(unc, '', 'win32');
      } catch (error) {
        thrown = error;
      }
      expect(isWorkspaceFsError(thrown) && thrown.code).toBe('invalid_path');
      expect((thrown as Error).message).toBe(message);
    }
  });

  it('start() throws it for a faked UNC root and starts nothing', () => {
    const started: string[] = [];
    const win = createProcessRunner({ platform: 'win32', shell: join(root, 'never-spawned') });
    expect(() =>
      win.start(
        { root: '\\\\server\\share\\proj', cwd: '', command: 'dir' },
        {
          onOutput: () => started.push('o'),
          onExit: () => started.push('x'),
          onError: () => started.push('e'),
        },
      ),
    ).toThrow(message);
    expect(started).toEqual([]);
  });

  it('leaves POSIX and drive-letter paths alone', () => {
    expect(resolveWorkingFolder(project, '', 'win32')).toBeTruthy();
    expect(resolveWorkingFolder(project, '', 'linux')).toBeTruthy();
  });
});
