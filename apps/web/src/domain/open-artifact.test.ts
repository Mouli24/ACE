import { describe, expect, it } from 'vitest';

import { projectRelativePath } from './open-artifact';

/* D336: an output card opens its file in Forge when the path is the project's. */

describe('projectRelativePath', () => {
  it('a relative path is the project’s already', () => {
    expect(projectRelativePath('tagline.md', '/p')).toBe('tagline.md');
    expect(projectRelativePath('./src/app.ts', undefined)).toBe('src/app.ts');
    expect(projectRelativePath('src\\app.ts', undefined)).toBe('src/app.ts');
  });

  it('an absolute path under the project folder is made relative', () => {
    expect(projectRelativePath('/home/me/proj/src/app.ts', '/home/me/proj')).toBe('src/app.ts');
    expect(projectRelativePath('/home/me/proj/a.md', '/home/me/proj/')).toBe('a.md');
    expect(projectRelativePath('D:\\Work\\Proj\\src\\app.ts', 'd:\\work\\proj')).toBe('src/app.ts');
  });

  it('a path outside the project, or climbing out of it, is not the project’s', () => {
    expect(projectRelativePath('/home/me/other/a.md', '/home/me/proj')).toBeUndefined();
    expect(projectRelativePath('/home/me/project-two/a.md', '/home/me/proj')).toBeUndefined();
    expect(projectRelativePath('/home/me/proj/a.md', undefined)).toBeUndefined();
    expect(projectRelativePath('../a.md', '/p')).toBeUndefined();
    expect(projectRelativePath('src/../../a.md', '/p')).toBeUndefined();
    // Case only folds on a Windows drive.
    expect(projectRelativePath('/Home/me/proj/a.md', '/home/me/proj')).toBeUndefined();
    expect(projectRelativePath('/home/me/proj', '/home/me/proj')).toBeUndefined();
  });
});
