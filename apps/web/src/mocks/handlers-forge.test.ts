import type { ServerFrame } from '@ace/contracts';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { mockVersion } from './files';
import { createForgeHandlers } from './handlers-forge';

const db = new MockDb({ persist: false });
const server = setupServer(...createForgeHandlers(db));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let projectId: string;
beforeEach(() => {
  db.reset();
  projectId = db.createProject({ name: 'P' }).id;
  db.seedFiles(projectId, {
    'src/app.ts': 'export {};\n',
    'README.md': '# hi',
    'node_modules/x/i.js': '',
  });
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://mock.local/api/v1/projects/${projectId}/files${path}`, {
    method,
    headers: {
      authorization: 'Bearer t',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
  };
};

describe('D299 the mock engine’s project files', () => {
  it('lists folders first, dims ignored folders, and never lists .git', async () => {
    db.seedFiles(projectId, { '.git/HEAD': 'x' });
    const { json } = await call('GET', '/tree');
    expect(
      (json?.items as { name: string; ignored: boolean }[]).map((e) => [e.name, e.ignored]),
    ).toEqual([
      ['node_modules', true],
      ['src', false],
      ['README.md', false],
    ]);
  });

  it('reads text with a version, saves against it, and refuses a stale base with the disk’s version', async () => {
    const read = await call('GET', '/content?path=src%2Fapp.ts');
    expect(read.json).toMatchObject({
      kind: 'text',
      content: 'export {};\n',
      version: mockVersion('export {};\n'),
    });

    const saved = await call('PUT', '/content', {
      path: 'src/app.ts',
      content: 'export const a = 1;\n',
      baseVersion: read.json?.version,
      eol: 'lf',
      bom: false,
    });
    expect(saved.status).toBe(200);
    expect(db.filesOf(projectId)['src/app.ts']?.content).toBe('export const a = 1;\n');

    const stale = await call('PUT', '/content', {
      path: 'src/app.ts',
      content: 'lost',
      baseVersion: read.json?.version,
      eol: 'lf',
      bom: false,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      error: {
        code: 'file_changed',
        details: { currentVersion: mockVersion('export const a = 1;\n') },
      },
    });
  });

  it('creates, moves a folder with its files, deletes, and lists every non-ignored file', async () => {
    expect((await call('POST', '/entries', { path: 'docs/a.md', kind: 'file' })).status).toBe(201);
    expect((await call('POST', '/move', { from: 'src', to: 'lib' })).status).toBe(200);
    expect(db.filesOf(projectId)['lib/app.ts']).toBeDefined();
    expect((await call('DELETE', '/entries?path=README.md')).status).toBe(204);
    expect((await call('GET', '/list')).json).toEqual({
      files: ['docs/a.md', 'lib/app.ts'],
      truncated: false,
    });
  });

  it('refuses paths outside the project and writes into .git, as the engine does', async () => {
    expect((await call('GET', '/content?path=..%2Fx')).json).toMatchObject({
      error: { code: 'outside_project' },
    });
    const git = await call('POST', '/entries', { path: 'sub/.git/hooks/x', kind: 'file' });
    expect(git.status).toBe(403);
    expect(git.json).toMatchObject({ error: { code: 'protected_path' } });
    expect((await call('POST', '/entries', { path: 'README.md', kind: 'file' })).status).toBe(409);
  });

  it('answers the repository status it was given, repo: false by default', async () => {
    expect((await call('GET', '/status')).json).toEqual({ repo: false });
    db.setRepoStatus(projectId, {
      repo: true,
      branch: 'main',
      files: [{ path: 'README.md', status: 'modified' }],
      truncated: false,
    });
    expect((await call('GET', '/status')).json).toMatchObject({ repo: true, branch: 'main' });
  });

  it('announces every change on the project scope only', async () => {
    const Socket = createFakeWebSocket(db);
    const watching = new Socket('ws://mock/ws?token=t');
    const elsewhere = new Socket('ws://mock/ws?token=t');
    const frames: ServerFrame[] = [];
    const leaked: ServerFrame[] = [];
    watching.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame);
    elsewhere.onmessage = (event) => leaked.push(JSON.parse(String(event.data)) as ServerFrame);
    await new Promise((resolve) => setTimeout(resolve, 5));
    watching.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }),
    );
    elsewhere.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'engine' } }));

    db.writeFileExternally(projectId, 'README.md', '# changed');

    expect(frames.filter((f) => f.type === 'files.changed')).toEqual([
      {
        type: 'files.changed',
        payload: { projectId, changes: [{ path: 'README.md', kind: 'changed' }], resync: false },
      },
    ]);
    expect(leaked.some((f) => f.type === 'files.changed')).toBe(false);
  });
});

describe('D299 Phase 4 the mock engine’s search', () => {
  it('searches the files that are not ignored, with case, whole word, regex and globs', async () => {
    db.seedFiles(projectId, {
      'src/app.ts': 'export const Needle = 1;\nneedles();\n',
      'src/deep/b.tsx': 'needle',
      'node_modules/x/i.js': 'needle',
      'logo.png': 'needle\u0000',
    });
    const paths = (json: Record<string, unknown> | undefined) =>
      (json?.files as { path: string; matches: { line: number; column: number }[] }[]).flatMap(
        (file) => file.matches.map((match) => `${file.path}:${match.line}:${match.column}`),
      );

    const all = await call('POST', '/search', { query: 'needle' });
    expect(all.status).toBe(200);
    expect(paths(all.json)).toEqual(['src/app.ts:1:14', 'src/app.ts:2:1', 'src/deep/b.tsx:1:1']);
    expect(all.json).toMatchObject({ truncated: false });
    expect(
      paths((await call('POST', '/search', { query: 'Needle', matchCase: true })).json),
    ).toEqual(['src/app.ts:1:14']);
    expect(
      paths((await call('POST', '/search', { query: 'needle', wholeWord: true })).json),
    ).toEqual(['src/app.ts:1:14', 'src/deep/b.tsx:1:1']);
    expect(
      paths((await call('POST', '/search', { query: 'need(le)s\\(', regex: true })).json),
    ).toEqual(['src/app.ts:2:1']);
    expect(
      paths((await call('POST', '/search', { query: 'needle', include: '*.tsx' })).json),
    ).toEqual(['src/deep/b.tsx:1:1']);
    expect(
      paths((await call('POST', '/search', { query: 'needle', exclude: 'deep, README.md' })).json),
    ).toEqual(['src/app.ts:1:14', 'src/app.ts:2:1']);
  });

  it('caps at maxResults and refuses a regex the contract refuses', async () => {
    db.seedFiles(projectId, { 'a.ts': 'x x x' });
    const cut = await call('POST', '/search', { query: 'x', maxResults: 2 });
    expect(cut.json).toMatchObject({ truncated: true });
    const refused = await call('POST', '/search', { query: '(a+)+', regex: true });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: { code: 'validation_failed' } });
  });
});
