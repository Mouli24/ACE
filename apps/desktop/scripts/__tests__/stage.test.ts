import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ENGINE_PACKAGES,
  NATIVE_BINARIES,
  StageError,
  engineTreeProblems,
  nodeVersionProblem,
  removeDeployLeftover,
} from '../stage.js';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function touch(root: string, path: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), '');
}

/** A deployed engine with everything staging checks for. */
function completeEngine(): string {
  const root = mkdtempSync(join(tmpdir(), 'ace-stage-'));
  touch(root, 'dist/main.js');
  for (const name of ENGINE_PACKAGES) touch(root, `node_modules/@ace/${name}/dist/index.js`);
  touch(root, 'node_modules/@ace/providers/dist/catalog/manifest.json');
  for (const binary of NATIVE_BINARIES) touch(root, `node_modules/${binary}`);
  return root;
}

describe('FR-DSK-001 staging checks the deployed engine (D298)', () => {
  it('a complete tree has no problems', () => {
    dir = completeEngine();
    expect(engineTreeProblems(dir)).toEqual([]);
  });

  it('names each missing dist, the catalog and each native binary', () => {
    dir = completeEngine();
    rmSync(join(dir, 'node_modules/@ace/tools/dist'), { recursive: true });
    rmSync(join(dir, 'node_modules/@ace/providers/dist/catalog/manifest.json'));
    rmSync(join(dir, 'node_modules/sqlite-vec-windows-x64'), { recursive: true });
    const problems = engineTreeProblems(dir);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/@ace\/tools/);
    expect(problems.join('\n')).toMatch(/model catalog/);
    expect(problems.join('\n')).toMatch(/vec0\.dll/);
  });

  it('checks all three native modules', () => {
    expect(NATIVE_BINARIES.map((path) => path.split('/')[0])).toEqual([
      'better-sqlite3',
      'sqlite-vec-windows-x64',
      '@napi-rs',
    ]);
  });
});

describe('FR-DSK-001 the shipped Node is the .nvmrc major (D293)', () => {
  it.each([
    ['v24.19.0', '24\n', undefined],
    ['v24.0.1', 'v24', undefined],
    ['v22.13.0', '24', 'Node v22.13.0 is running this script, but .nvmrc says 24.'],
  ])('%s against .nvmrc %j', (version, nvmrc, expected) => {
    expect(nodeVersionProblem(version, nvmrc)).toBe(expected);
  });
});

describe('the pnpm deploy leftover', () => {
  it('is removed when it holds only node_modules', () => {
    dir = mkdtempSync(join(tmpdir(), 'ace-stage-'));
    const leftover = join(dir, 'apps');
    touch(leftover, 'desktop/stage/engine/node_modules/.bin/pino.CMD');
    expect(removeDeployLeftover(leftover)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(removeDeployLeftover(leftover)).toBe(false);
  });

  it('is refused when anything else is in it', () => {
    dir = mkdtempSync(join(tmpdir(), 'ace-stage-'));
    const leftover = join(dir, 'apps');
    touch(leftover, 'desktop/stage/engine/node_modules/.bin/pino.CMD');
    touch(leftover, 'something/real.ts');
    expect(() => removeDeployLeftover(leftover)).toThrow(StageError);
    expect(existsSync(join(leftover, 'something/real.ts'))).toBe(true);
  });
});
