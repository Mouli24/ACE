import { describe, expect, it } from 'vitest';

import { fuzzyScore, rankPaths } from './fuzzy';

describe('D299 quick open’s matching, VS Code in miniature', () => {
  it('matches the letters in order, ignoring case and spaces', () => {
    expect(fuzzyScore('idx', 'src/index.ts')).toBeDefined();
    expect(fuzzyScore('I DX', 'src/index.ts')).toBeDefined();
    expect(fuzzyScore('xdi', 'src/index.ts')).toBeUndefined();
  });

  it('ranks a match in the file name, in a row, at a word start first', () => {
    expect(
      rankPaths('math', ['src/mathematics/readme.md', 'docs/m-a-t-h.md', 'src/util/math.ts']),
    ).toEqual(['src/util/math.ts', 'src/mathematics/readme.md', 'docs/m-a-t-h.md']);
  });

  it('prefers the shorter path on a tie, and caps the list', () => {
    expect(rankPaths('a', ['deep/folder/a.ts', 'a.ts'])[0]).toBe('a.ts');
    expect(
      rankPaths(
        '',
        Array.from({ length: 80 }, (_, i) => `f${i}.ts`),
      ),
    ).toHaveLength(50);
  });
});
