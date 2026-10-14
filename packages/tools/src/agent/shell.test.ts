import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { agentEnv } from './env.js';
import { resolveAgentShell, shellInvocation, type AgentShell } from './shell.js';

const files = (...present: string[]) => {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe('FR-TOOL-008 agent shell detection (agentic nodes)', () => {
  it('Windows: Git Bash from git in <Git>\\cmd', () => {
    const shell = resolveAgentShell({
      platform: 'win32',
      env: { Path: 'C:\\Program Files\\Git\\cmd', SystemRoot: 'C:\\Windows' },
      which: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      exists: files('C:\\Program Files\\Git\\bin\\bash.exe'),
    });
    expect(shell.kind).toBe('bash');
    expect(shell.path).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(shell.label).toMatch(/Git Bash/);
  });

  it('Windows: Git Bash from git in <Git>\\mingw64\\bin', () => {
    const shell = resolveAgentShell({
      platform: 'win32',
      env: {},
      which: () => 'D:\\Tools\\Git\\mingw64\\bin\\git.exe',
      exists: files('D:\\Tools\\Git\\bin\\bash.exe'),
    });
    expect(shell.path).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });

  it('Windows: looks git up on a PATH spelled `Path`', () => {
    const seen: string[] = [];
    resolveAgentShell({
      platform: 'win32',
      env: { Path: 'C:\\A;C:\\Git\\cmd', PATHEXT: '.EXE' },
      exists: (p) => {
        seen.push(p);
        return (
          p.toLowerCase() === 'c:\\git\\cmd\\git.exe' ||
          p.toLowerCase() === 'c:\\git\\bin\\bash.exe'
        );
      },
    });
    expect(seen.map((p) => p.toLowerCase())).toContain('c:\\git\\cmd\\git.exe');
  });

  it('Windows: never the WSL launcher in System32, falls back to PowerShell', () => {
    const shell = resolveAgentShell({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ACE_AGENT_SHELL: 'C:\\Windows\\System32\\bash.exe' },
      which: (name) => (name === 'bash' ? 'C:\\Windows\\System32\\bash.exe' : undefined),
      exists: files(
        'C:\\Windows\\System32\\bash.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ),
    });
    expect(shell.kind).toBe('powershell');
    expect(shell.path).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const args = shell.argsFor('Get-Location');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3] ?? '', 'base64').toString('utf16le')).toBe('Get-Location');
  });

  it('POSIX: /bin/bash, else /bin/sh, with a non-login -c', () => {
    const bash = resolveAgentShell({
      platform: 'linux',
      env: {},
      exists: files('/bin/bash', '/bin/sh'),
    });
    expect(bash).toMatchObject({ kind: 'bash', path: '/bin/bash' });
    expect(bash.argsFor('ls -la')).toEqual(['-c', 'ls -la']);
    expect(bash.envFor('ls')).toEqual({});
    const sh = resolveAgentShell({ platform: 'darwin', env: {}, exists: files('/bin/sh') });
    expect(sh).toMatchObject({ kind: 'sh', path: '/bin/sh' });
  });

  it('ACE_AGENT_SHELL overrides detection', () => {
    expect(
      resolveAgentShell({
        platform: 'linux',
        env: { ACE_AGENT_SHELL: '/usr/local/bin/bash' },
        exists: () => true,
      }),
    ).toMatchObject({
      kind: 'bash',
      path: '/usr/local/bin/bash',
    });
    expect(
      resolveAgentShell({
        platform: 'win32',
        env: { ACE_AGENT_SHELL: 'C:\\pwsh\\pwsh.exe' },
        exists: () => true,
      }),
    ).toMatchObject({ kind: 'powershell', path: 'C:\\pwsh\\pwsh.exe' });
  });

  it('Windows bash carries the command in the environment, so backslashes survive', () => {
    const shell = resolveAgentShell({
      platform: 'win32',
      env: {},
      which: () => 'C:\\Git\\cmd\\git.exe',
      exists: files('C:\\Git\\bin\\bash.exe'),
    });
    const spec = shellInvocation(shell, "printf '%s' 'C:\\\\x'", { Path: 'p' });
    expect(spec.file).toBe('C:\\Git\\bin\\bash.exe');
    expect(spec.args[0]).toBe('-c');
    expect(spec.args[1]).not.toContain('printf');
    expect(spec.env).toMatchObject({ Path: 'p', ACE_AGENT_COMMAND: "printf '%s' 'C:\\\\x'" });
  });
});

describe('FR-TOOL-008 the shell on this machine', () => {
  const shell: AgentShell = resolveAgentShell({ platform: process.platform, env: process.env });
  const workspace = mkdtempSync(join(tmpdir(), 'ace shell-'));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));
  const env = agentEnv(process.env, process.platform);
  const run = (command: string) => {
    const spec = shellInvocation(shell, command, env);
    return spawnSync(spec.file, spec.args, {
      cwd: workspace,
      env: spec.env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  it.runIf(process.platform === 'win32')('Windows: resolves Git Bash, never WSL', () => {
    expect(shell.kind).toBe('bash');
    expect(shell.path.toLowerCase()).not.toContain('system32');
    expect(shell.path.toLowerCase().endsWith('\\bin\\bash.exe')).toBe(true);
  });

  it('pwd is the workspace', () => {
    const result = run(`node -e "console.log(process.cwd())"`);
    expect(result.status, result.stderr).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(workspace));
    if (shell.kind !== 'powershell') {
      const pwd = run('pwd -W 2>/dev/null || pwd');
      expect(realpathSync(pwd.stdout.trim())).toBe(realpathSync(workspace));
    }
  });

  it('node, git, ls and grep resolve through the shell', () => {
    for (const tool of ['node', 'git', ...(shell.kind === 'powershell' ? [] : ['ls', 'grep'])]) {
      const result = run(
        shell.kind === 'powershell' ? `Get-Command ${tool}` : `command -v ${tool}`,
      );
      expect(result.status, `${tool}: ${result.stderr}`).toBe(0);
    }
  });

  const pnpmOnPath =
    spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { encoding: 'utf8' })
      .status === 0;
  it.skipIf(!pnpmOnPath)(
    'pnpm resolves through the shell (skipped when pnpm is not on PATH)',
    () => {
      const result = run(shell.kind === 'powershell' ? 'Get-Command pnpm' : 'command -v pnpm');
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it('runs the command exactly as written: quotes, backslashes, &&', () => {
    if (shell.kind === 'powershell') return;
    const result = run(`printf '[%s]' 'C:\\\\x' "a\\"b" && printf '[%s]' "it's"`);
    expect(result.stdout).toBe(`[C:\\\\x][a"b][it's]`);
  });

  it('the child env has no API key, and PATH', () => {
    const result = run(`node -e "console.log(JSON.stringify(Object.keys(process.env)))"`);
    const keys = JSON.parse(result.stdout.trim()) as string[];
    expect(keys.some((key) => /API_KEY|ACE_SESSION|ACE_AGENT_COMMAND/i.test(key))).toBe(false);
    expect(keys.some((key) => key.toUpperCase() === 'PATH')).toBe(true);
  });
});
