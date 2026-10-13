import type { FileContent, SourcesResult } from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asMonaco, createFakeMonaco, type FakeMonaco } from '../../test/fake-monaco';
import { disposeModel, ensureModel, fileUri, resetModels, setMonaco } from './models';
import { loadProjectTypes, parseJsonc, type SourcesClient } from './project-types';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const OTHER = '01J9ZZZZZZZZZZZZZZZZZZZZZY';
let fake: FakeMonaco;
/** The project's files on "disk", as the client reads them. */
let disk: Record<string, string>;
let tsconfig: string | undefined;

const text = (path: string, content: string): FileContent => ({
  kind: 'text',
  path,
  content,
  version: 'v',
  eol: 'lf',
  bom: false,
  size: content.length,
});

function client(): SourcesClient & { sources: ReturnType<typeof vi.fn> } {
  const sources = vi.fn(async (): Promise<SourcesResult> => ({
    files: Object.entries(disk)
      .filter(([path]) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path))
      .map(([path, content]) => ({ path, content })),
    truncated: false,
    ...(tsconfig === undefined ? {} : { tsconfig }),
  }));
  return {
    sources,
    projectSources: sources,
    readFile: async (_projectId: string, path: string) => {
      const content = disk[path];
      if (content === undefined) throw new Error(`${path} was not found.`);
      return text(path, content);
    },
  };
}

const uri = (path: string, projectId = P): string => fileUri(projectId, path).toString();
const tsLibs = () => fake.typescript.typescriptDefaults.getExtraLibs();
const jsLibs = () => fake.typescript.javascriptDefaults.getExtraLibs();
const tsOptions = () => fake.typescript.typescriptDefaults.getCompilerOptions();

beforeEach(() => {
  resetModels();
  fake = createFakeMonaco();
  setMonaco(asMonaco(fake));
  disk = {
    'src/a.ts': 'export const a = 1;',
    'src/b.tsx': 'export const B = () => null;',
    'lib/c.js': 'export const c = 3;',
    'README.md': '# not a source',
  };
  tsconfig = undefined;
});

describe('D299 Phase 4 cross-file types: the project’s sources as extra libs', () => {
  it('registers every source not open as a model; TS with the TS service, JS with both', async () => {
    ensureModel(P, 'src/b.tsx', disk['src/b.tsx'] ?? '', 'typescript', () => undefined);
    const types = loadProjectTypes(asMonaco(fake), P, client());
    await types.ready;

    expect(Object.keys(tsLibs()).sort()).toEqual([uri('lib/c.js'), uri('src/a.ts')]);
    expect(tsLibs()[uri('src/a.ts')]?.content).toBe('export const a = 1;');
    expect(Object.keys(jsLibs())).toEqual([uri('lib/c.js')]);
    types.dispose();
  });

  it('drops a file’s extra lib while it is open as a model, and adds it back from disk on close', async () => {
    const types = loadProjectTypes(asMonaco(fake), P, client());
    await types.ready;

    ensureModel(P, 'src/a.ts', 'export const a = 1;', 'typescript', () => undefined);
    expect(tsLibs()[uri('src/a.ts')]).toBeUndefined();

    disk['src/a.ts'] = 'export const a = 2;';
    disposeModel(P, 'src/a.ts');
    await vi.waitFor(() => expect(tsLibs()[uri('src/a.ts')]?.content).toBe('export const a = 2;'));
    // another project's model is none of this project's business
    ensureModel(OTHER, 'src/a.ts', 'x', 'typescript', () => undefined);
    expect(tsLibs()[uri('src/a.ts')]).toBeDefined();
    types.dispose();
  });

  it('refreshes the changed paths, drops the deleted ones, adds the created ones, and skips the rest', async () => {
    const types = loadProjectTypes(asMonaco(fake), P, client());
    await types.ready;

    disk['src/a.ts'] = 'export const a = "changed";';
    disk['src/new.ts'] = 'export const n = 1;';
    disk['notes.txt'] = 'not a source';
    delete disk['lib/c.js'];
    await types.changed([
      { path: 'src/a.ts', kind: 'changed' },
      { path: 'src/new.ts', kind: 'created' },
      { path: 'lib/c.js', kind: 'deleted' },
      { path: 'notes.txt', kind: 'created' },
    ]);

    expect(tsLibs()[uri('src/a.ts')]?.content).toBe('export const a = "changed";');
    expect(tsLibs()[uri('src/new.ts')]?.content).toBe('export const n = 1;');
    expect(tsLibs()[uri('lib/c.js')]).toBeUndefined();
    expect(jsLibs()[uri('lib/c.js')]).toBeUndefined();
    expect(tsLibs()[uri('notes.txt')]).toBeUndefined();
    types.dispose();
  });

  it('a change to an open file waits for its close; a resync reloads everything', async () => {
    const sources = client();
    const types = loadProjectTypes(asMonaco(fake), P, sources);
    await types.ready;
    ensureModel(P, 'src/a.ts', 'export const a = 1;', 'typescript', () => undefined);
    await types.changed([{ path: 'src/a.ts', kind: 'changed' }]);
    expect(tsLibs()[uri('src/a.ts')]).toBeUndefined();

    disk['src/b.tsx'] = 'export const B = 2;';
    await types.reload();
    expect(sources.sources).toHaveBeenCalledTimes(2);
    expect(tsLibs()[uri('src/b.tsx')]?.content).toBe('export const B = 2;');
    expect(tsLibs()[uri('src/a.ts')]).toBeUndefined();
    types.dispose();
  });

  it('disposes everything, and restores the compiler options, when the project goes', async () => {
    const before = { ...tsOptions() };
    tsconfig = '{ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["*"] } } }';
    const types = loadProjectTypes(asMonaco(fake), P, client());
    await types.ready;
    expect(Object.keys(tsLibs())).not.toHaveLength(0);

    types.dispose();
    expect(tsLibs()).toEqual({});
    expect(jsLibs()).toEqual({});
    expect(tsOptions()).toEqual(before);
    // a model closing after the project went adds nothing back
    ensureModel(P, 'src/a.ts', 'x', 'typescript', () => undefined);
    disposeModel(P, 'src/a.ts');
    await new Promise((settle) => setTimeout(settle, 0));
    expect(tsLibs()).toEqual({});
  });
});

describe('D299 Phase 4 cross-file types: tsconfig.json', () => {
  it('merges baseUrl and paths, rebased under the project, into both services', async () => {
    tsconfig = [
      '{',
      '  // the project root, as the editor names it',
      '  "compilerOptions": {',
      '    "baseUrl": "./src/",',
      '    "paths": { "@/*": ["./*"], "~lib/*": ["../lib/*"], },',
      '    /* ignored here */ "strict": false,',
      '  },',
      '}',
    ].join('\n');
    const types = loadProjectTypes(asMonaco(fake), P, client());
    await types.ready;
    for (const defaults of [
      fake.typescript.typescriptDefaults,
      fake.typescript.javascriptDefaults,
    ]) {
      expect(defaults.getCompilerOptions()).toMatchObject({
        baseUrl: `file:///${P}/src`,
        paths: { '@/*': ['./*'], '~lib/*': ['../lib/*'] },
      });
      // only baseUrl and paths: the rest of tsconfig is not Monaco's business
      expect(defaults.getCompilerOptions()).not.toHaveProperty('strict', false);
    }
    types.dispose();
  });

  it('takes the project root as the base for paths with no baseUrl, and ignores a tsconfig it cannot read', async () => {
    tsconfig = '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }';
    const first = loadProjectTypes(asMonaco(fake), P, client());
    await first.ready;
    expect(tsOptions()).toMatchObject({ baseUrl: `file:///${P}`, paths: { '@/*': ['src/*'] } });
    first.dispose();

    tsconfig = '{ not json';
    const second = loadProjectTypes(asMonaco(fake), P, client());
    await second.ready;
    expect(tsOptions()).not.toHaveProperty('baseUrl');
    expect(Object.keys(tsLibs())).not.toHaveLength(0);
    second.dispose();
  });

  it('parses JSON with comments and trailing commas, leaving strings alone', () => {
    expect(
      parseJsonc('{ "a": "// not a comment", /* c */ "b": [1, 2,], // end\n "c": "x,]" }'),
    ).toEqual({ a: '// not a comment', b: [1, 2], c: 'x,]' });
  });
});
