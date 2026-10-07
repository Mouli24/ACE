import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliDetection, CliPermission } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GenerateRequest, StreamChunk } from '../../../adapter.js';
import { capPermission } from '../adapter.js';
import { createClaudeCodeAdapter } from '../claude-code.js';

/*
 * ACE parity P1, through the shared CLI adapter against a fake CLI that reports what it was started
 * with: the run's secrets reach the process environment (D274), and the approval mode's ceiling
 * lowers — never raises — the provider's permission preset (D270).
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
/** Obviously fake: no real key is ever written in this repository. */
const VALUE = 'fake-cli-env-value-0001';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-cli-env-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const signedIn: CliDetection = {
  type: 'claude_code',
  installed: true,
  version: '2.1.282',
  login: 'logged_in',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  loginHint: 'claude auth login',
};

interface Seen {
  argv: string[];
  env: Record<string, string | null>;
}

/** One call against the fake CLI; answers what the CLI saw (the call itself fails: no result). */
async function seen(
  options: {
    permission?: CliPermission;
    ceiling?: CliPermission;
    request?: Partial<GenerateRequest>;
    baseEnv?: Record<string, string>;
  } = {},
): Promise<Seen> {
  const echo = join(dir, 'echo.json');
  const adapter = createClaudeCodeAdapter({
    permission: options.permission ?? 'edit_files',
    ...(options.ceiling === undefined ? {} : { permissionCeiling: async () => options.ceiling }),
    detect: async () => signedIn,
    resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
    env: {
      ...process.env,
      FAKE_CLI_MODE: 'echo-stdin',
      FAKE_CLI_ECHO_FILE: echo,
      FAKE_CLI_ECHO_ENV: 'DEPLOY_TOKEN,SHARED_NAME',
      ...options.baseEnv,
    },
  });
  const drain = async (stream: AsyncIterable<StreamChunk>) => {
    for await (const chunk of stream) void chunk;
  };
  await drain(
    adapter.generate(
      {
        modelId: 'sonnet',
        prompt: 'p',
        outputTypes: ['text'],
        workingDir: dir,
        ...options.request,
      },
      new AbortController().signal,
    ),
  ).catch(() => undefined);
  return JSON.parse(readFileSync(echo, 'utf8')) as Seen;
}

describe('D274 the CLI process gets the run’s secrets as its environment', () => {
  it('merges req.env over its own environment, a name in both taking the secret', async () => {
    const { env } = await seen({
      baseEnv: { SHARED_NAME: 'from-the-engine' },
      request: { env: { DEPLOY_TOKEN: VALUE, SHARED_NAME: 'from-the-secret' } },
    });
    expect(env['DEPLOY_TOKEN']).toBe(VALUE);
    expect(env['SHARED_NAME']).toBe('from-the-secret');
  });

  it('starts with only its own environment when the request carries none', async () => {
    const { env } = await seen({ baseEnv: { SHARED_NAME: 'from-the-engine' } });
    expect(env['DEPLOY_TOKEN']).toBeNull();
    expect(env['SHARED_NAME']).toBe('from-the-engine');
  });

  it('never puts a value on the command line', async () => {
    const { argv } = await seen({ request: { env: { DEPLOY_TOKEN: VALUE } } });
    expect(argv.join(' ')).not.toContain(VALUE);
  });
});

describe('D270 the approval mode’s ceiling over the permission preset', () => {
  it('runs a full_auto preset with the edit_files flags under an edit_files ceiling', async () => {
    const { argv } = await seen({ permission: 'full_auto', ceiling: 'edit_files' });
    expect(argv).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'acceptEdits',
        '--tools',
        'Read,Edit,Write,Grep,Glob',
      ]),
    );
    expect(argv).not.toContain('bypassPermissions');
  });

  it('keeps the preset when there is no ceiling, and never raises it', async () => {
    expect((await seen({ permission: 'full_auto' })).argv).toContain('bypassPermissions');
    const lifted = await seen({ permission: 'read_only', ceiling: 'full_auto' });
    expect(lifted.argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    expect(lifted.argv).not.toContain('bypassPermissions');
  });

  it('still runs read-only in a scratch folder, whatever the ceiling allows', async () => {
    const { argv } = await seen({
      permission: 'full_auto',
      ceiling: 'full_auto',
      request: { workingDir: undefined },
    });
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
  });

  it('fails the call, starting nothing, when the ceiling cannot be read', async () => {
    const adapter = createClaudeCodeAdapter({
      permission: 'full_auto',
      permissionCeiling: async () => {
        throw new Error('settings unreadable');
      },
      detect: async () => signedIn,
      resolve: () => {
        throw new Error('resolve must not be reached');
      },
    });
    const run = async () => {
      for await (const chunk of adapter.generate(
        { modelId: 'sonnet', prompt: 'p', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      )) {
        void chunk;
      }
    };
    await expect(run()).rejects.toThrow('settings unreadable');
  });

  it.each<[CliPermission, CliPermission | undefined, CliPermission]>([
    ['full_auto', undefined, 'full_auto'],
    ['full_auto', 'edit_files', 'edit_files'],
    ['full_auto', 'read_only', 'read_only'],
    ['edit_files', 'full_auto', 'edit_files'],
    ['edit_files', 'edit_files', 'edit_files'],
    ['read_only', 'edit_files', 'read_only'],
  ])('capPermission(%s, %s) is %s', (preset, ceiling, expected) => {
    expect(capPermission(preset, ceiling)).toBe(expected);
  });
});
