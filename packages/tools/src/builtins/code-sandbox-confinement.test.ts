import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { SANDBOX_DENIED_MESSAGE } from '../logging.js';
import { nodePermissionFlags } from '../sandbox/languages.js';
import { ChildProcessSandbox } from '../sandbox/runner.js';
import { accessDenial, createCodeSandboxTool } from './code-sandbox.js';

/**
 * TC-TOOL-005, NFR-SEC-04, Arch §22.2 (found by the round 4 cross-test, D-068): JavaScript in the
 * child-process sandbox could read — and write — any file the engine's user can, because "hard
 * filesystem isolation" was left to Docker (D13) and every test runs without Docker. The runner now
 * starts `node` under its own permission model with read and write granted to the run's sandbox
 * folder only, so a read of `/etc/passwd`, of the real home folder or of any file outside is refused
 * by the runtime; and the tool turns that refusal into a `denied` ToolError and a
 * `sandbox escape attempt denied` warn line, because a denial nobody recorded reads exactly like an
 * attempt that never happened.
 */

const tool = createCodeSandboxTool({ sandbox: new ChildProcessSandbox() });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function ctx(): ReturnType<typeof makeContext> {
  const context = makeContext();
  cleanups.push(context.cleanup);
  return context;
}

/** A folder outside any sandbox, holding a file whose content must never come back. */
function outsideFile(): { dir: string; path: string; secret: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ace-outside-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const secret = `outside-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const path = join(dir, 'secret.txt');
  writeFileSync(path, secret);
  return { dir, path, secret };
}

async function expectDenied(code: string): Promise<{ message: string; logged: ReturnType<typeof ctx>['logger'] }> {
  const context = ctx();
  const outcome = await tool.implementation({ language: 'javascript', code }, context).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  expect('error' in outcome, `expected a denial, got ${JSON.stringify(outcome)}`).toBe(true);
  const error = (outcome as { error: { kind?: unknown; message?: unknown } }).error;
  expect(error.kind).toBe('denied');
  return { message: String(error.message), logged: context.logger };
}

describe('TC-TOOL-005 JavaScript in the sandbox cannot reach outside its folder', () => {
  it('a read of a file outside is denied, never returned, and logged with the run and the path', async () => {
    const outside = outsideFile();
    const { message, logged } = await expectDenied(
      `const fs = require('node:fs'); console.log(fs.readFileSync(${JSON.stringify(outside.path)}, 'utf8'));`,
    );

    expect(message).toMatch(/denied/i);
    expect(message).not.toContain(outside.secret);
    const lines = logged.matching(SANDBOX_DENIED_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.payload).toMatchObject({ tool: 'code_sandbox', runId: 'run-test', permission: 'FileSystemRead' });
    expect(String(lines[0]?.payload['resource'])).toContain('secret.txt');
  });

  it('an unhandled rejection from a dynamic import is caught the same way (the cross-test shape)', async () => {
    const outside = outsideFile();
    const { message } = await expectDenied(
      `import('node:fs').then((fs) => console.log(fs.readFileSync(${JSON.stringify(outside.path)}, 'utf8')))`,
    );

    expect(message).not.toContain(outside.secret);
  });

  it('a listing of the real home folder is denied (the env remap alone only moved `~`)', async () => {
    await expectDenied(`console.log(require('node:fs').readdirSync(${JSON.stringify(homedir())}).join('\\n'))`);
  });

  it('a write outside is denied and creates nothing', async () => {
    const outside = outsideFile();
    const target = join(outside.dir, 'planted.txt');

    await expectDenied(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'planted')`);

    expect(existsSync(target)).toBe(false);
  });

  it('a child process — the way around any in-process rule — is denied too', async () => {
    await expectDenied(`require('node:child_process').execSync('echo escaped')`);
  });

  it('a program that catches its own denial finishes normally, and still reads nothing', async () => {
    const outside = outsideFile();
    const result = (await tool.implementation(
      {
        language: 'javascript',
        code: `try { require('node:fs').readFileSync(${JSON.stringify(outside.path)}, 'utf8'); } catch (e) { process.stdout.write(e.code); }`,
      },
      ctx(),
    )) as { stdout: string; exitCode: number };

    expect(result.stdout).toBe('ERR_ACCESS_DENIED');
    expect(result.exitCode).toBe(0);
  });

  it('inside its own folder it still reads, writes and lists freely', async () => {
    const result = (await tool.implementation(
      {
        language: 'javascript',
        code: `const fs = require('node:fs'); fs.mkdirSync('out'); fs.writeFileSync('out/a.txt', 'x'); process.stdout.write(fs.readFileSync('out/a.txt', 'utf8') + fs.readdirSync('.').filter((n) => !n.startsWith('.')).join());`,
      },
      ctx(),
    )) as { stdout: string; exitCode: number };

    expect(result).toMatchObject({ stdout: 'xout', exitCode: 0 });
  });
});

describe('accessDenial reads the refusal Node printed', () => {
  it('takes the permission and the resource, unescaping a Windows path', () => {
    const stderr = [
      "Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.",
      "  code: 'ERR_ACCESS_DENIED',",
      "  permission: 'FileSystemRead',",
      "  resource: 'C:\\\\Users\\\\me\\\\secret.txt'",
    ].join('\n');

    expect(accessDenial(stderr)).toEqual({ permission: 'FileSystemRead', resource: 'C:\\Users\\me\\secret.txt' });
  });

  it('answers a denial with no details as `unknown`, and nothing at all for other failures', () => {
    expect(accessDenial("code: 'ERR_ACCESS_DENIED'")).toEqual({ permission: 'unknown' });
    expect(accessDenial('Error: ENOENT: no such file or directory')).toBeUndefined();
    expect(accessDenial('')).toBeUndefined();
  });
});

describe('the permission flags follow the Node version the sandbox runs (engines: >= 20.11)', () => {
  it.each([
    ['20.19.0', '--experimental-permission', true],
    ['22.12.0', '--experimental-permission', true],
    ['22.13.0', '--permission', false],
    ['23.4.0', '--experimental-permission', true],
    ['23.5.0', '--permission', false],
    ['24.19.0', '--permission', false],
  ])('node %s → %s', (version, flag, quietsWarning) => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-flags-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const flags = nodePermissionFlags(dir, version);

    expect(flags[0]).toBe(flag);
    expect(flags.includes('--disable-warning=ExperimentalWarning')).toBe(quietsWarning);
    expect(flags).toContain(`--allow-fs-read=${dir}`);
    expect(flags).toContain(`--allow-fs-write=${dir}`);
    // Nothing is granted but the sandbox folder (and its real path, when that differs).
    const granted = flags
      .filter((f) => f.startsWith('--allow-'))
      .map((f) => f.slice(f.indexOf('=') + 1));
    expect(new Set(granted)).toEqual(new Set([dir, realpathSync(dir)]));
  });

  it('grants a folder that has no real path yet exactly once for read and once for write', () => {
    const flags = nodePermissionFlags(join(tmpdir(), 'does-not-exist-yet'), '24.0.0');
    expect(flags.filter((f) => f.startsWith('--allow-fs-read='))).toHaveLength(1);
    expect(flags.filter((f) => f.startsWith('--allow-fs-write='))).toHaveLength(1);
  });
});
