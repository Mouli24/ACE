import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isDirectory } from './is-directory.js';
import { mergeEnv, unsetEnv } from './merge-env.js';

describe('mergeEnv', () => {
  it('lays overrides over the base and removes a key set to undefined', () => {
    const env = mergeEnv({ A: '1', B: '2' }, { B: '3', A: undefined, C: '4' }, 'linux');
    expect(env).toEqual({ B: '3', C: '4' });
  });

  it('is case-sensitive on POSIX', () => {
    expect(mergeEnv({ Path: '/a' }, { PATH: '/b' }, 'linux')).toEqual({ Path: '/a', PATH: '/b' });
  });

  it('replaces every casing of a name on Windows', () => {
    expect(mergeEnv({ Path: 'C:\\a', path: 'C:\\c' }, { PATH: 'C:\\b' }, 'win32')).toEqual({
      PATH: 'C:\\b',
    });
  });

  it('copies the base when there is nothing to lay over it', () => {
    const base = { A: '1' };
    const env = mergeEnv(base, undefined);
    expect(env).toEqual(base);
    expect(env).not.toBe(base);
  });
});

describe('unsetEnv', () => {
  it('removes one exact name on POSIX', () => {
    const env: NodeJS.ProcessEnv = { GIT_DIR: '/a', git_dir: '/b' };
    unsetEnv(env, 'GIT_DIR', 'linux');
    expect(env).toEqual({ git_dir: '/b' });
  });

  it('removes every casing on Windows', () => {
    const env: NodeJS.ProcessEnv = { GIT_DIR: 'C:\\a', Git_Dir: 'C:\\b', OTHER: 'x' };
    unsetEnv(env, 'git_dir', 'win32');
    expect(env).toEqual({ OTHER: 'x' });
  });
});

describe('isDirectory', () => {
  it('is true for a folder and false for a file or nothing', async () => {
    expect(await isDirectory(tmpdir())).toBe(true);
    expect(await isDirectory(process.execPath)).toBe(false);
    expect(await isDirectory(join(tmpdir(), 'ace-no-such-folder-xyz', 'deeper'))).toBe(false);
  });
});
