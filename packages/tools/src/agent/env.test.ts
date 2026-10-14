import { describe, expect, it } from 'vitest';

import { POSIX_ENV_ALLOWLIST, WINDOWS_ENV_ALLOWLIST, agentEnv } from './env.js';

const engineEnv = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SYSTEMROOT: 'C:\\Windows',
  windir: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\me',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  TEMP: 'C:\\Temp',
  HOME: '/home/me',
  USER: 'me',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-secret',
  ACE_SESSION_TOKEN: 'engine-token',
  ACE_AGENT_SHELL: '/bin/zsh',
  GITHUB_TOKEN: 'ghp_secret',
  NODE_OPTIONS: '--require ./evil.js',
  CI: 'false',
};

describe('FR-TOOL-008 agent command env (agentic nodes, BR-07)', () => {
  it('Windows: keeps the allowlist, matched case-insensitively, under its real spelling', () => {
    const env = agentEnv(engineEnv, 'win32');
    expect(env['Path']).toBe(engineEnv.Path);
    expect(env['PATH']).toBeUndefined();
    expect(env['SYSTEMROOT']).toBe('C:\\Windows');
    expect(env['windir']).toBe('C:\\Windows');
    expect(env['ProgramFiles(x86)']).toBe('C:\\Program Files (x86)');
    expect(env['TEMP']).toBe('C:\\Temp');
  });

  it('never passes provider keys, the engine token or anything else', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const env = agentEnv(engineEnv, platform);
      const values = Object.values(env);
      expect(values).not.toContain('sk-ant-secret');
      expect(values).not.toContain('sk-secret');
      expect(values).not.toContain('engine-token');
      expect(values).not.toContain('ghp_secret');
      expect(Object.keys(env).some((key) => key.toUpperCase().startsWith('ACE_'))).toBe(false);
      expect(env['NODE_OPTIONS']).toBeUndefined();
    }
  });

  it('Windows: only the allowlist plus CI and GIT_TERMINAL_PROMPT', () => {
    const env = agentEnv(engineEnv, 'win32');
    const allowed = new Set(
      [...WINDOWS_ENV_ALLOWLIST, 'CI', 'GIT_TERMINAL_PROMPT'].map((key) => key.toUpperCase()),
    );
    for (const key of Object.keys(env)) expect(allowed.has(key.toUpperCase())).toBe(true);
    expect(env['HOME']).toBeUndefined();
    expect(env['CI']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('POSIX: the POSIX allowlist, exact case', () => {
    const env = agentEnv({ ...engineEnv, PATH: '/usr/bin:/bin' }, 'linux');
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/me',
      USER: 'me',
      LANG: 'en_US.UTF-8',
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(POSIX_ENV_ALLOWLIST).toEqual(['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR']);
  });

  it('this machine: the real env keeps PATH and drops a planted key', () => {
    const env = agentEnv({ ...process.env, ANTHROPIC_API_KEY: 'planted' }, process.platform);
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
    expect(Object.values(env)).not.toContain('planted');
  });
});
