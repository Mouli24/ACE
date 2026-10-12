import { describe, expect, it } from 'vitest';

import { parseBuiltin, resolveCd } from './builtins';

describe('D301 the terminal’s built-ins: cd, cls and clear', () => {
  it.each([
    ['cd', { kind: 'cd', arg: undefined }],
    ['  cd   src  ', { kind: 'cd', arg: 'src' }],
    ['cd..', { kind: 'cd', arg: '..' }],
    ['CD "My Dir"', { kind: 'cd', arg: 'My Dir' }],
    ["cd 'a b'", { kind: 'cd', arg: 'a b' }],
    ['cls', { kind: 'clear' }],
    ['CLEAR', { kind: 'clear' }],
  ] as const)('%j is a built-in', (line, builtin) => {
    expect(parseBuiltin(line)).toEqual(builtin);
  });

  it.each([
    'cdx',
    'echo cd',
    'cd src && npm test',
    'cd src | x',
    'cd a; ls',
    'cd > out',
    'clear all',
  ])('%j goes to the shell (a chained cd does not persist, design §14)', (line) => {
    expect(parseBuiltin(line)).toBeUndefined();
  });

  it.each([
    ['', 'src', 'src'],
    ['src', 'deep', 'src/deep'],
    ['src/deep', '..', 'src'],
    ['src', '../..', ''],
    ['', '..', ''],
    ['src', '/', ''],
    ['src', '~', ''],
    ['src', '~/web', 'web'],
    ['src', './a/./b/', 'src/a/b'],
    ['src', 'a\\b', 'src/a/b'],
  ])('from %j, cd %j leads to %j, never above the root', (cwd, arg, target) => {
    expect(resolveCd(cwd, arg)).toBe(target);
  });
});
