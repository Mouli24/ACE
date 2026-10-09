import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliDetector, detectCli, probeCommand, type ProbeResult } from '../detect.js';
import type { ResolvedCommand } from '../resolve.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ace-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const found = (bin: string): ResolvedCommand => ({
  command: `/usr/bin/${bin}`,
  prefixArgs: [],
  path: `/usr/bin/${bin}`,
});

/** A probe that answers by the arguments it was given. */
function probes(answers: Record<string, ProbeResult>) {
  const asked: string[] = [];
  return {
    asked,
    probe: async (_command: ResolvedCommand, args: string[]): Promise<ProbeResult> => {
      const key = args.join(' ');
      asked.push(key);
      return answers[key] ?? { code: 1, stdout: '', stderr: 'unknown command' };
    },
  };
}

describe('FR-PRV-008 the terminal scan (X1)', () => {
  it('reports Claude Code installed and signed in, keeping no identity (D264)', async () => {
    const { probe } = probes({
      '--version': { code: 0, stdout: '2.1.282 (Claude Code)\n', stderr: '' },
      'auth status --json': {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'me@example.com',
          orgName: 'Me',
          subscriptionType: 'max',
        }),
        stderr: '',
      },
    });
    const result = await detectCli('claude_code', { resolve: found, probe, env: {}, homeDir: home });
    expect(result).toEqual({
      type: 'claude_code',
      installed: true,
      version: '2.1.282',
      path: '/usr/bin/claude',
      login: 'logged_in',
      loginDetail: 'claude.ai · max',
      installHint: 'npm install -g @anthropic-ai/claude-code',
      loginHint: 'claude auth login',
    });
    expect(JSON.stringify(result)).not.toContain('me@example.com');
  });

  it('reports Claude Code installed but signed out', async () => {
    const { probe } = probes({
      '--version': { code: 0, stdout: '2.1.282 (Claude Code)', stderr: '' },
      'auth status --json': {
        code: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        stderr: '',
      },
    });
    expect(
      (await detectCli('claude_code', { resolve: found, probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
  });

  it('reports a CLI that is not on PATH with only its hints, running nothing', async () => {
    const { probe, asked } = probes({});
    expect(
      await detectCli('codex_cli', { resolve: () => undefined, probe, env: {}, homeDir: home }),
    ).toEqual({
      type: 'codex_cli',
      installed: false,
      login: 'unknown',
      installHint: 'npm install -g @openai/codex',
      loginHint: 'codex login',
    });
    expect(asked).toEqual([]);
  });

  it('reads Codex sign-in from `codex login status` (stderr), or CODEX_API_KEY', async () => {
    const signedIn = probes({
      '--version': { code: 0, stdout: 'codex-cli 0.160.1', stderr: '' },
      'login status': { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' },
    });
    expect(
      await detectCli('codex_cli', { resolve: found, probe: signedIn.probe, env: {}, homeDir: home }),
    ).toMatchObject({ version: '0.160.1', login: 'logged_in', loginDetail: 'ChatGPT' });

    const signedOut = probes({
      '--version': { code: 0, stdout: 'codex-cli 0.160.1', stderr: '' },
      'login status': { code: 1, stdout: '', stderr: 'Not logged in' },
    });
    expect(
      (await detectCli('codex_cli', { resolve: found, probe: signedOut.probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
    expect(
      await detectCli('codex_cli', {
        resolve: found,
        probe: signedOut.probe,
        env: { CODEX_API_KEY: 'k' },
        homeDir: home,
      }),
    ).toMatchObject({ login: 'logged_in', loginDetail: 'CODEX_API_KEY' });
  });

  it('reads Gemini’s sign-in method from env or settings, never its tokens', async () => {
    const { probe } = probes({ '--version': { code: 0, stdout: '0.62.0', stderr: '' } });
    expect(
      await detectCli('gemini_cli', { resolve: found, probe, env: { GEMINI_API_KEY: 'k' }, homeDir: home }),
    ).toMatchObject({ version: '0.62.0', login: 'logged_in', loginDetail: 'GEMINI_API_KEY' });

    mkdirSync(join(home, '.gemini'));
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    expect(
      await detectCli('gemini_cli', { resolve: found, probe, env: {}, homeDir: home }),
    ).toMatchObject({ login: 'unknown', loginDetail: 'Google sign-in (oauth-personal)' });

    rmSync(join(home, '.gemini'), { recursive: true });
    expect(
      (await detectCli('gemini_cli', { resolve: found, probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
  });

  it('caches a scan for its TTL and refreshes when forced', async () => {
    let now = 0;
    const { probe, asked } = probes({
      '--version': { code: 0, stdout: '2.1.282', stderr: '' },
      'auth status --json': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
    });
    const detector = createCliDetector({
      resolve: found,
      probe,
      env: {},
      homeDir: home,
      ttlMs: 60_000,
      now: () => now,
    });
    await detector.detect('claude_code');
    await detector.detect('claude_code');
    expect(asked.filter((arg) => arg === '--version')).toHaveLength(1);
    now = 61_000;
    await detector.detect('claude_code');
    await detector.detect('claude_code', { force: true });
    expect(asked.filter((arg) => arg === '--version')).toHaveLength(3);
  });

  it('scans all three in CLI_PROVIDER_TYPES order', async () => {
    const { probe } = probes({});
    const detector = createCliDetector({ resolve: () => undefined, probe, env: {}, homeDir: home });
    expect((await detector.detectAll()).items.map((item) => item.type)).toEqual([
      'claude_code',
      'codex_cli',
      'gemini_cli',
    ]);
  });

  it('a probe answers once the CLI exits, even if something it started still holds stdout (review I5)', async () => {
    const orphanThenPrint =
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir(), windowsHide: true }).unref(); console.log('1.2.3')";
    const started = Date.now();
    const result = await probeCommand(
      { command: process.execPath, prefixArgs: ['-e', orphanThenPrint], path: process.execPath },
      [],
      10_000,
    );
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout.trim()).toBe('1.2.3');
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
