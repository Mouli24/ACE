import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIgnoreRules } from './ignore-rules.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-ignore-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('D299 FR-GIT-003 which entries the Explorer dims', () => {
  it('hides .git and nothing else', () => {
    const rules = createIgnoreRules(root);
    expect(rules.isHidden('.git')).toBe(true);
    expect(rules.isHidden('.git/HEAD')).toBe(true);
    expect(rules.isHidden('.github')).toBe(false);
    expect(rules.isHidden('.gitignore')).toBe(false);
  });

  it('ignores the default folders and everything under them, but not a file of that name', () => {
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('node_modules', true)).toBe(true);
    expect(rules.isIgnored('pkg/node_modules/x/index.js', false)).toBe(true);
    expect(rules.isIgnored('dist', true)).toBe(true);
    expect(rules.isIgnored('dist', false), 'a file named dist').toBe(false);
    expect(rules.isIgnored('src/index.ts', false)).toBe(false);
  });

  it('honours the root .gitignore, folder-only patterns and nested .gitignore files', () => {
    put('.gitignore', '*.log\nout/\n!keep.log\n');
    put('web/.gitignore', 'generated/\n');
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('debug.log', false)).toBe(true);
    expect(rules.isIgnored('keep.log', false)).toBe(false);
    expect(rules.isIgnored('out', true)).toBe(true);
    expect(rules.isIgnored('out', false), 'out/ matches folders only').toBe(false);
    expect(rules.isIgnored('out/a.txt', false)).toBe(true);
    expect(rules.isIgnored('web/generated/a.ts', false)).toBe(true);
    expect(
      rules.isIgnored('generated/a.ts', false),
      'the nested file applies below web/ only',
    ).toBe(false);
  });

  it('reads a changed .gitignore again after clear()', () => {
    put('.gitignore', '');
    const rules = createIgnoreRules(root);
    expect(rules.isIgnored('a.tmp', false)).toBe(false);
    put('.gitignore', '*.tmp\n');
    expect(rules.isIgnored('a.tmp', false), 'cached').toBe(false);
    rules.clear();
    expect(rules.isIgnored('a.tmp', false)).toBe(true);
  });
});
