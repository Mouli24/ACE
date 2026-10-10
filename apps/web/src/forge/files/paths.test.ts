import { describe, expect, it } from 'vitest';

import { extensionOf, isImagePath, isWithin, joinPath, movedPath, nameOf, parentOf } from './paths';

describe('D299 wire paths in the web app', () => {
  it('splits and joins forward-slash paths, the root being empty', () => {
    expect(parentOf('src/a/b.ts')).toBe('src/a');
    expect(parentOf('b.ts')).toBe('');
    expect(nameOf('src/a/b.ts')).toBe('b.ts');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
  });

  it('knows what lies within a folder, and where it lands after a move', () => {
    expect(isWithin('src/a.ts', 'src')).toBe(true);
    expect(isWithin('src', 'src')).toBe(true);
    expect(isWithin('srcx/a.ts', 'src')).toBe(false);
    expect(movedPath('src/a/b.ts', 'src/a', 'lib/a')).toBe('lib/a/b.ts');
    expect(movedPath('src/a', 'src/a', 'lib/a')).toBe('lib/a');
  });

  it('reads extensions, including dot files, and recognises images', () => {
    expect(extensionOf('a/b.TS')).toBe('ts');
    expect(extensionOf('.env')).toBe('');
    expect(isImagePath('logo.SVG')).toBe(true);
    expect(isImagePath('a.ts')).toBe(false);
  });
});
