import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

let engine: RunningEngine;
let dataDir: string;
let folder: string;
let projectId: string;

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${engine.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as T };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-forge-int-'));
  folder = join(dataDir, 'Forge Project');
  mkdirSync(folder);
  writeFileSync(join(folder, 'hello.txt'), 'hi\r\n');
  engine = await startEngine({ dataDir, port: 0, env: {} });
  const created = await api<{ id: string }>('POST', '/projects', {
    name: 'Forge',
    folderPath: folder,
  });
  projectId = created.json.id;
});

afterAll(async () => {
  await engine.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('D299 FR-GIT-003 FR-GIT-004 Forge’s files through the real engine', () => {
  it('lists, reads and saves a real file, keeping its CRLF', async () => {
    const tree = await api<{ items: { name: string }[] }>(
      'GET',
      `/projects/${projectId}/files/tree`,
    );
    expect(tree.status).toBe(200);
    expect(tree.json.items.map((entry) => entry.name)).toContain('hello.txt');

    const read = await api<{ kind: string; content: string; version: string; eol: string }>(
      'GET',
      `/projects/${projectId}/files/content?path=hello.txt`,
    );
    expect(read.json).toMatchObject({ kind: 'text', content: 'hi\r\n', eol: 'crlf' });

    const saved = await api<{ version: string }>('PUT', `/projects/${projectId}/files/content`, {
      path: 'hello.txt',
      content: 'hello\r\nworld\r\n',
      baseVersion: read.json.version,
      eol: 'crlf',
      bom: false,
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(folder, 'hello.txt'), 'utf8')).toBe('hello\r\nworld\r\n');

    const stale = await api<{ error: { code: string } }>(
      'PUT',
      `/projects/${projectId}/files/content`,
      {
        path: 'hello.txt',
        content: 'lost',
        baseVersion: read.json.version,
        eol: 'lf',
        bom: false,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('file_changed');
  });

  it('refuses a path outside the project and a write into .git (FR-GIT-008)', async () => {
    const outside = await api<{ error: { code: string } }>(
      'GET',
      `/projects/${projectId}/files/content?path=${encodeURIComponent('../secret.txt')}`,
    );
    expect(outside.status).toBe(403);
    expect(outside.json.error.code).toBe('outside_project');

    const git = await api<{ error: { code: string } }>(
      'POST',
      `/projects/${projectId}/files/entries`,
      {
        path: '.git/hooks/pre-commit',
        kind: 'file',
      },
    );
    expect(git.status).toBe(403);
    expect(git.json.error.code).toBe('protected_path');
  });

  it('never reads or lists .git by name, as it is never listed (review minor 6)', async () => {
    mkdirSync(join(folder, '.git'), { recursive: true });
    writeFileSync(join(folder, '.git', 'config'), '[remote "origin"]\n\turl = https://t@x/r.git\n');

    const content = await api<{ error: { code: string } }>(
      'GET',
      `/projects/${projectId}/files/content?path=${encodeURIComponent('.git/config')}`,
    );
    expect(content.status).toBe(403);
    expect(content.json.error.code).toBe('protected_path');

    const tree = await api<{ error: { code: string } }>(
      'GET',
      `/projects/${projectId}/files/tree?path=.git`,
    );
    expect(tree.status).toBe(403);
    expect(tree.json.error.code).toBe('protected_path');
  });

  it('streams files.changed to a project subscriber when a file changes on disk', async () => {
    const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
    const frames: { type: string; payload: { changes?: { path: string }[] } }[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      socket.send(
        JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id: projectId } }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The watcher starts asynchronously after the subscribe, so a write that lands too early is
      // never seen. Write again on every poll, with a changing body, until one is caught.
      let writes = 0;
      await vi.waitFor(
        () => {
          writes += 1;
          writeFileSync(
            join(folder, 'agent-wrote.ts'),
            `export const x = ${writes};
`,
          );
          expect(
            frames.some(
              (frame) =>
                frame.type === 'files.changed' &&
                (frame.payload.changes ?? []).some((change) => change.path === 'agent-wrote.ts'),
            ),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 250 },
      );
      expect(frames.find((frame) => frame.type === 'files.changed')).not.toHaveProperty('seq');
    } finally {
      socket.close();
    }
  }, 20_000);
});

describe('D299 Phase 4 Search through the real engine', () => {
  it('finds text in the project with a POST body, and refuses a runaway regex as 400', async () => {
    mkdirSync(join(folder, 'src'), { recursive: true });
    writeFileSync(join(folder, 'src', 'needle.ts'), 'export const needle = 1;\n');
    mkdirSync(join(folder, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', 'pkg', 'index.js'), 'needle');

    const found = await api<{ files: { path: string }[]; truncated: boolean }>(
      'POST',
      `/projects/${projectId}/files/search`,
      { query: 'need(le)', regex: true },
    );
    expect(found.status).toBe(200);
    expect(found.json.files.map((file) => file.path)).toEqual(['src/needle.ts']);
    expect(found.json.truncated).toBe(false);

    const refused = await api<{ error: { code: string } }>(
      'POST',
      `/projects/${projectId}/files/search`,
      { query: '(a+)+$', regex: true },
    );
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('validation_failed');
  });
});

describe('D299 Phase 4 project sources through the real engine', () => {
  it('reads the TS/JS sources, never node_modules, with the root tsconfig', async () => {
    mkdirSync(join(folder, 'lib'), { recursive: true });
    writeFileSync(join(folder, 'lib', 'util.ts'), 'export const util = 1;\n');
    writeFileSync(join(folder, 'tsconfig.json'), '{ "compilerOptions": {} }');
    const sources = await api<{ files: { path: string }[]; tsconfig?: string; truncated: boolean }>(
      'GET',
      `/projects/${projectId}/files/sources`,
    );
    expect(sources.status).toBe(200);
    const paths = sources.json.files.map((file) => file.path);
    expect(paths).toContain('lib/util.ts');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
    expect(sources.json.tsconfig).toBe('{ "compilerOptions": {} }');
    expect(sources.json.truncated).toBe(false);
  });
});

describe('D299 Phase 4 fix C1: a runaway regex never freezes the real engine', () => {
  it('answers timedOut within about 5 s, and the engine serves other requests meanwhile', async () => {
    mkdirSync(join(folder, 'slow'), { recursive: true });
    writeFileSync(join(folder, 'slow', 'line.txt'), `${'a'.repeat(40)}!`);
    const started = Date.now();
    const search = api<{ timedOut?: boolean; truncated: boolean }>(
      'POST',
      `/projects/${projectId}/files/search`,
      { query: '(.*a){12}$', regex: true, include: 'slow' },
    );
    // while the worker spins, the engine still answers at once
    await new Promise((settle) => setTimeout(settle, 500));
    const pinged = Date.now();
    expect((await api('GET', `/projects/${projectId}`)).status).toBe(200);
    expect(Date.now() - pinged).toBeLessThan(1_000);

    const result = await search;
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ timedOut: true, truncated: true });
    expect(Date.now() - started).toBeLessThan(7_000);
  }, 20_000);
});
