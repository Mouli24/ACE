import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Checkpoint } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const THREAD = '01JBXQ8Z9KQ4R7N2VWXYZ0THRD';
const CONFLICT = "a.txt changed after the agent's edit; review it before reverting";

let engine: RunningEngine;
let dataDir: string;
let folder: string;
let projectId: string;

interface Frame {
  type: string;
  payload: { projectId?: string; checkpoint?: Checkpoint; removed?: boolean };
  seq?: number;
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  target: RunningEngine = engine,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as T };
}

async function watch(id: string): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
  const frames: Frame[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'project', id } }));
  // the protocol has no acknowledgement for a subscribe: this covers the loopback hop
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { socket, frames };
}

const write = (path: string, content: string): void => {
  mkdirSync(join(folder, path, '..'), { recursive: true });
  writeFileSync(join(folder, path), content);
};
const read = (path: string): string => readFileSync(join(folder, path), 'utf8');
const base = () => `/projects/${projectId}/checkpoints`;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-checkpoints-int-'));
  folder = mkdtempSync(join(tmpdir(), 'ace-checkpoints-project-'));
  engine = await startEngine({ dataDir, port: 0, env: {} });
  projectId = (
    await api<{ id: string }>('POST', '/projects', { name: 'Checkpoints', folderPath: folder })
  ).json.id;
});

afterAll(async () => {
  await engine.stop();
  for (const dir of [dataDir, folder]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
      // Windows can hold a folder a moment longer; the OS reclaims temp itself.
    }
  }
});

describe.skipIf(!hasGit)('D300 checkpoints through the real engine and a real git store', () => {
  it('answers 401 without the token: the routes sit behind the auth', async () => {
    const response = await fetch(`${engine.url}/api/v1${base()}`);
    expect(response.status).toBe(401);
  });

  it('records a turn, diffs it, reverts files, and refuses to revert one changed since', async () => {
    write('a.txt', 'one\ntwo\n');
    write('gone.txt', 'bye\n');
    write('node_modules/dep/index.js', 'ignored\n');
    const { socket, frames } = await watch(projectId);

    try {
      // begin, the agent edits, finish
      const recording = await engine.services.checkpoints.begin(projectId, {
        kind: 'chat',
        threadId: THREAD,
      });
      write('a.txt', 'one\nTWO\nthree\n');
      write('src/new.txt', 'fresh\n');
      rmSync(join(folder, 'gone.txt'));
      write('node_modules/dep/index.js', 'still ignored\n');
      const finished = await recording.finish();
      expect(finished?.status).toBe('pending');
      expect(existsSync(join(dataDir, 'checkpoints', `${projectId}.git`))).toBe(true);
      expect(existsSync(join(folder, '.git'))).toBe(false);

      const listed = await api<Checkpoint[]>('GET', base());
      expect(listed.status).toBe(200);
      expect(listed.json).toHaveLength(1);
      expect(listed.json[0]?.files).toEqual([
        {
          path: 'a.txt',
          change: 'modified',
          additions: 2,
          deletions: 1,
          binary: false,
          state: 'pending',
        },
        {
          path: 'gone.txt',
          change: 'deleted',
          additions: 0,
          deletions: 1,
          binary: false,
          state: 'pending',
        },
        {
          path: 'src/new.txt',
          change: 'added',
          additions: 1,
          deletions: 0,
          binary: false,
          state: 'pending',
        },
      ]);
      expect(JSON.stringify(listed.json)).not.toMatch(/beforeRef|afterRef|fresh|bye/);

      const diff = await api<unknown>('GET', `${base()}/${recording.id}/diff?path=a.txt`);
      expect(diff.json).toEqual({
        before: 'one\ntwo\n',
        after: 'one\nTWO\nthree\n',
        binary: false,
      });

      // revert an added file and a deleted one
      const reverted = await api<Checkpoint>('POST', `${base()}/${recording.id}/actions`, {
        action: 'revert',
        paths: ['src/new.txt', 'gone.txt'],
      });
      expect(reverted.status).toBe(200);
      expect(existsSync(join(folder, 'src/new.txt'))).toBe(false);
      expect(read('gone.txt')).toBe('bye\n');

      // the person edits a.txt after the agent: a revert is refused and changes nothing
      write('a.txt', 'mine now\n');
      const refused = await api<{ error: { code: string; message: string; details: unknown } }>(
        'POST',
        `${base()}/${recording.id}/actions`,
        { action: 'revert', paths: ['a.txt'] },
      );
      expect(refused.status).toBe(409);
      expect(refused.json.error).toMatchObject({
        code: 'checkpoint_conflict',
        message: CONFLICT,
        details: { conflicts: [{ path: 'a.txt', message: CONFLICT }] },
      });
      expect(read('a.txt')).toBe('mine now\n');

      const kept = await api<Checkpoint>('POST', `${base()}/${recording.id}/actions`, {
        action: 'keep',
      });
      expect(kept.json.status).toBe('partial');

      // every step went out as a transient checkpoint.updated on the project scope
      const statuses = frames
        .filter((frame) => frame.type === 'checkpoint.updated')
        .map((frame) => frame.payload.checkpoint?.status);
      expect(statuses).toEqual(['recording', 'pending', 'pending', 'partial']);
      expect(
        frames.every((frame) => frame.type !== 'checkpoint.updated' || frame.seq === undefined),
      ).toBe(true);
    } finally {
      socket.close();
    }
  });

  it('drops a turn that changed nothing', async () => {
    const recording = await engine.services.checkpoints.begin(projectId, {
      kind: 'chat',
      threadId: THREAD,
    });
    expect(await recording.finish()).toBeUndefined();
    const found = await api<{ error: { code: string } }>('GET', `${base()}/${recording.id}`);
    expect(found.status).toBe(404);
  });

  it('finishes a recording the last engine left, when the engine starts again', async () => {
    const recording = await engine.services.checkpoints.begin(projectId, {
      kind: 'chat',
      threadId: THREAD,
    });
    write('later.txt', 'written while the engine went down\n');
    await engine.stop();
    engine = await startEngine({ dataDir, port: 0, env: {} });

    const after = await api<Checkpoint>('GET', `${base()}/${recording.id}`);
    expect(after.json.status).toBe('pending');
    expect(after.json.files.map((file) => file.path)).toEqual(['later.txt']);
  });
});
