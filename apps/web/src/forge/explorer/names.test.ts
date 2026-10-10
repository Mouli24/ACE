import { describe, expect, it } from 'vitest';

import { nameProblem } from './names';

describe('D299 a name the engine will accept, checked before asking', () => {
  it.each([
    ['', 'A name is required.'],
    ['CON', 'Windows reserves that name.'],
    ['a:b', 'A name cannot contain < > : " | ? *'],
    ['trailing.', 'A name cannot end with a dot or a space.'],
    ['..', 'That name is reserved.'],
  ])('%j → %s', (name, problem) => {
    expect(nameProblem(name, [], { allowSlash: false })).toBe(problem);
  });

  it('refuses a sibling’s name in any case, and a slash in a rename only', () => {
    expect(nameProblem('readme.md', ['README.md'], { allowSlash: false })).toBe(
      '“readme.md” already exists here.',
    );
    expect(nameProblem('a/b.ts', [], { allowSlash: false })).toBe('A name cannot contain a slash.');
    expect(nameProblem('a/b.ts', [], { allowSlash: true })).toBeUndefined();
  });
});
