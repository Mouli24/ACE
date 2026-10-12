import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProcessRunner } from './runner.js';
import { LOCKFILES, readProjectScripts } from './scripts.js';

/** A file symlink needs a privilege on Windows; without it the link test is skipped. */
const canFileSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-link-probe-'));
  try {
    writeFileSync(join(dir, 't'), '');
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-scripts-'));
  project = join(root, 'demo project');
  mkdirSync(project);
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // Windows can hold a folder a moment longer; the OS reclaims temp itself.
  }
});

const put = (name: string, text: string) => writeFileSync(join(project, name), text);
const manifest = (body: Record<string, unknown>) => put('package.json', JSON.stringify(body));
const managerOf = async () => (await readProjectScripts(project)).packageManager;

describe('D301 the project’s own scripts (design §6.3)', () => {
  it('lists the root package.json scripts in file order, skipping anything that is not a command', async () => {
    manifest({ scripts: { dev: 'vite', build: 'tsc && vite build', odd: 3 } });
    expect(await readProjectScripts(project)).toEqual({
      packageManager: 'npm',
      scripts: [
        { name: 'dev', command: 'vite' },
        { name: 'build', command: 'tsc && vite build' },
      ],
    });
  });

  it('reads the lockfiles in D301’s order', () => {
    expect(LOCKFILES.map(([file, manager]) => `${file}:${manager}`)).toEqual([
      'pnpm-lock.yaml:pnpm',
      'yarn.lock:yarn',
      'bun.lock:bun',
      'bun.lockb:bun',
      'package-lock.json:npm',
    ]);
  });

  it.each(LOCKFILES.map(([file, manager]) => [file, manager] as const))(
    'reads %s as %s',
    async (lockfile, manager) => {
      manifest({ scripts: {} });
      put(lockfile, '');
      expect(await managerOf()).toBe(manager);
    },
  );

  it('prefers pnpm, then yarn, then bun, then npm, when several lockfiles are there', async () => {
    manifest({});
    put('package-lock.json', '{}');
    put('bun.lockb', '');
    expect(await managerOf()).toBe('bun');
    put('yarn.lock', '');
    expect(await managerOf()).toBe('yarn');
    put('pnpm-lock.yaml', '');
    expect(await managerOf()).toBe('pnpm');
  });

  it('takes the packageManager field first, ignoring its version and hash', async () => {
    manifest({ packageManager: 'pnpm@9.15.9+sha512.abc' });
    put('yarn.lock', '');
    expect(await managerOf()).toBe('pnpm');
  });

  it('falls through to the lockfiles for a manager D301 does not name', async () => {
    manifest({ packageManager: 'deno@2.0.0' });
    put('yarn.lock', '');
    expect(await managerOf()).toBe('yarn');
  });

  it('is npm with neither a field nor a lockfile', async () => {
    manifest({ scripts: { test: 'vitest' } });
    expect(await managerOf()).toBe('npm');
  });

  it('answers an empty list, never an error, with no package.json, a broken one, or a folder of that name', async () => {
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    put('package.json', '{ "scripts": ');
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    rmSync(join(project, 'package.json'));
    mkdirSync(join(project, 'package.json'));
    expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
  });

  it('reads a package.json that starts with a byte-order mark', async () => {
    put('package.json', '\uFEFF{"scripts":{"test":"vitest"}}');
    expect((await readProjectScripts(project)).scripts).toEqual([
      { name: 'test', command: 'vitest' },
    ]);
  });

  it('reads only the root package.json, never a nested one', async () => {
    mkdirSync(join(project, 'web'));
    writeFileSync(
      join(project, 'web', 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    expect((await readProjectScripts(project)).scripts).toEqual([]);
  });

  it.skipIf(!canFileSymlink)(
    'never reads a package.json linked from outside the project (FR-GIT-008)',
    async () => {
      const outside = join(root, 'outside.json');
      writeFileSync(outside, JSON.stringify({ scripts: { leak: 'cat ~/.ssh/id_rsa' } }));
      symlinkSync(outside, join(project, 'package.json'), 'file');
      expect(await readProjectScripts(project)).toEqual({ packageManager: 'npm', scripts: [] });
    },
  );

  it('is what the runner answers for scripts(root)', async () => {
    manifest({ scripts: { dev: 'vite' } });
    put('pnpm-lock.yaml', '');
    expect(await createProcessRunner().scripts(project)).toEqual({
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    });
  });
});
