import { describe, expect, it } from 'vitest';

import { buildDecorations } from './decorations';

describe('D299 the Explorer’s git decorations, as in VS Code', () => {
  const decorations = buildDecorations({
    repo: true,
    branch: 'main',
    truncated: false,
    files: [
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'scratch', status: 'untracked' },
    ],
  });

  it('letters each changed file', () => {
    expect(decorations.file('src/app.ts')).toMatchObject({ letter: 'M', tone: 'modified' });
    expect(decorations.file('src/new.ts')).toMatchObject({ letter: 'A', tone: 'added' });
    expect(decorations.file('src/other.ts')).toBeUndefined();
  });

  it('marks everything inside an untracked folder untracked', () => {
    expect(decorations.file('scratch/notes/a.md')).toMatchObject({ letter: 'U' });
    expect(decorations.folder('scratch')).toBe('added');
  });

  it('colours a folder by the most important change inside it', () => {
    expect(decorations.folder('src')).toBe('modified');
    expect(decorations.folder('docs')).toBeUndefined();
  });

  it('decorates nothing when the folder is not a repository', () => {
    const none = buildDecorations({ repo: false });
    expect(none.file('a.ts')).toBeUndefined();
    expect(none.folder('src')).toBeUndefined();
  });
});
