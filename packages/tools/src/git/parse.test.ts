import { describe, expect, it } from 'vitest';

import { countStatusEntries, parseRawNumstat, splitNul, toChangeStatus } from './parse.js';

const Z = '\0';

describe('FR-GIT-005 parsing git diff --raw --numstat -z', () => {
  it('maps every raw status letter', () => {
    expect(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X'].map(toChangeStatus)).toEqual([
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'type_changed',
      'modified',
      'modified',
    ]);
  });

  it('joins raw records to their line counts, renames and copies included', () => {
    const output = [
      ':100644 100644 aaaaaaa 0000000 M',
      'a.txt',
      ':100644 100644 bbbbbbb bbbbbbb R100',
      'old name.txt',
      'new name.txt',
      ':100644 100644 ccccccc ddddddd C75',
      'src.txt',
      'copy.txt',
      ':100644 120000 eeeeeee fffffff T',
      'link',
      ':000000 100644 0000000 1111111 A',
      'bin.dat',
      '2\t1\ta.txt',
      '0\t0\t',
      'old name.txt',
      'new name.txt',
      '3\t0\t',
      'src.txt',
      'copy.txt',
      '1\t1\tlink',
      '-\t-\tbin.dat',
      '',
    ].join(Z);

    expect(parseRawNumstat(output)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'bin.dat', status: 'added', additions: null, deletions: null, binary: true },
      {
        path: 'copy.txt',
        oldPath: 'src.txt',
        status: 'copied',
        additions: 3,
        deletions: 0,
        binary: false,
      },
      { path: 'link', status: 'type_changed', additions: 1, deletions: 1, binary: false },
      {
        path: 'new name.txt',
        oldPath: 'old name.txt',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
  });

  it('keeps a path with a tab, a quote or non-ASCII characters verbatim', () => {
    const path = 'dir/ta\tb "q" é ü 文件.txt';
    const output = [':100644 100644 a b M', path, `4\t5\t${path}`, ''].join(Z);
    expect(parseRawNumstat(output)).toEqual([
      { path, status: 'modified', additions: 4, deletions: 5, binary: false },
    ]);
  });

  it('is empty for no output', () => {
    expect(parseRawNumstat('')).toEqual([]);
  });

  it('counts a file with no numstat line as zero lines', () => {
    expect(parseRawNumstat([':100644 100644 a b M', 'x', ''].join(Z))).toEqual([
      { path: 'x', status: 'modified', additions: 0, deletions: 0, binary: false },
    ]);
  });
});

describe('parsing git status --porcelain=v1 -z', () => {
  it("counts entries, a rename's original path not counted twice", () => {
    const output = [
      ' M a.txt',
      'R  new.txt',
      'old.txt',
      'A  b.txt',
      ' C c.txt',
      'src.txt',
      '',
    ].join(Z);
    expect(countStatusEntries(output)).toBe(4);
  });

  it('is zero for a clean tree', () => {
    expect(countStatusEntries('')).toBe(0);
  });
});

describe('splitNul', () => {
  it('drops the trailing empty token', () => {
    expect(splitNul(['a.txt', 'b c.txt', ''].join(Z))).toEqual(['a.txt', 'b c.txt']);
    expect(splitNul('')).toEqual([]);
  });
});
