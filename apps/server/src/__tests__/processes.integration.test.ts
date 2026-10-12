import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE } from '@ace/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { startEngine, type RunningEngine } from '../server.js';

interface Frame {
  type: string;
  payload: { processId?: string; data?: string; [key: string]: unknown };
  seq?: number;
}

let engine: RunningEngine;
let dataDir: string;
let projectId: string;

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

// FORCE_COLOR=1 colours node's console.log of numbers and objects: strip it before matching.
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/[[0-9;]*m/g, '');

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function newProject(target: RunningEngine, folder: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  return (
    await api<{ id: string }>('POST', '/projects', { name: 'Terminal', folderPath: folder }, target)
  ).json.id;
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
  // The only fixed wait here: the protocol has no acknowledgement for a subscribe, so there is
  // nothing to poll for. The hub applies it on receipt; this covers the loopback hop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { socket, frames };
}

const statusOf = async (id: string, processId: string): Promise<string> =>
  (await api<{ status: string }>('GET', `/projects/${id}/processes/${processId}`)).json.status;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-terminal-int-'));
  engine = await startEngine({ dataDir, port: 0, env: {} });
  projectId = await newProject(engine, join(dataDir, 'Terminal Project'));
});

afterAll(async () => {
  // stop() ends every process first (this task's shutdown), so no process holds the folder.
  await engine.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // Windows can hold a folder a moment after a process in it ends; the OS reclaims temp itself.
  }
});

describe('D301 the terminal through the real engine', () => {
  it('answers 401 to a process route without the token (the routes sit behind the auth)', async () => {
    const response = await fetch(`${engine.url}/api/v1/projects/${projectId}/processes`);
    expect(response.status).toBe(401);
  });

  it('streams a real process’s output as process.output frames without a seq, then process.exited 0', async () => {
    const { socket, frames } = await watch(projectId);
    try {
      const before = await engine.ports.repository.events.currentSeq(LOCAL_SCOPE);
      const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
        command: node("console.log('one'); console.log('two'); console.log('three')"),
      });
      expect(started.status).toBe(201);
      const { processId } = started.json;

      await vi.waitFor(
        () =>
          expect(
            frames.some((f) => f.type === 'process.exited' && f.payload.processId === processId),
          ).toBe(true),
        { timeout: 10_000 },
      );
      const mine = frames.filter((frame) => frame.payload.processId === processId);
      const output = mine
        .filter((frame) => frame.type === 'process.output')
        .map((frame) => frame.payload.data)
        .join('')
        .replace(/\r/g, '');
      expect(output).toBe('one\ntwo\nthree\n');
      for (const frame of mine) expect(frame).not.toHaveProperty('seq');
      expect(mine.at(-1)).toEqual({
        type: 'process.exited',
        payload: { projectId, processId, exitCode: 0, signal: null, status: 'exited' },
      });

      const detail = await api<{ status: string; output: string }>(
        'GET',
        `/projects/${projectId}/processes/${processId}`,
      );
      expect(detail.json.status).toBe('exited');
      expect(detail.json.output.replace(/\r/g, '')).toBe('one\ntwo\nthree\n');
      // design §7: terminal output never reaches the event log.
      expect(await engine.ports.repository.events.currentSeq(LOCAL_SCOPE)).toBe(before);
    } finally {
      socket.close();
    }
  }, 30_000);

  it('a long-running process stops through /stop in under 3 s, and reads as SIGKILL', async () => {
    const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
      command: node("console.log('up'); setInterval(() => {}, 1000)"),
    });
    const { processId } = started.json;
    const detail = () =>
      api<{ status: string; output: string; exitCode: number | null; signal: string | null }>(
        'GET',
        `/projects/${projectId}/processes/${processId}`,
      );
    expect(await until(async () => (await detail()).json.output.includes('up'), 10_000)).toBe(true);

    // The /stop answer comes once the kill has started; the 3 s count from there.
    expect((await api('POST', `/projects/${projectId}/processes/${processId}/stop`)).status).toBe(
      204,
    );
    expect(
      await until(async () => (await statusOf(projectId, processId)) !== 'running', 3_000),
    ).toBe(true);
    // On every platform: taskkill's exit code 1 never reads as a failure (D301).
    expect((await detail()).json).toMatchObject({
      status: 'exited',
      exitCode: null,
      signal: 'SIGKILL',
    });
  }, 30_000);

  it('turning the terminal off stops what runs, and refuses a new start', async () => {
    const started = await api<{ processId: string }>('POST', `/projects/${projectId}/processes`, {
      command: node('setInterval(() => {}, 1000)'),
    });
    const { processId } = started.json;
    try {
      expect((await api('PATCH', `/projects/${projectId}`, { terminal: 'off' })).status).toBe(200);
      expect(await statusOf(projectId, processId)).not.toBe('running');
      const refused = await api<{ error: { code: string } }>(
        'POST',
        `/projects/${projectId}/processes`,
        { command: node('1') },
      );
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe('terminal_disabled');
    } finally {
      await api('PATCH', `/projects/${projectId}`, { terminal: 'on' });
    }
  }, 30_000);

  it('refuses a working folder outside the project, as a file read would (FR-GIT-008)', async () => {
    const refused = await api<{ error: { code: string } }>(
      'POST',
      `/projects/${projectId}/processes`,
      {
        command: node('1'),
        cwd: '..',
      },
    );
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('outside_project');
  });

  it('stopping the engine stops every process it started, grandchildren included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-terminal-stop-'));
    const second = await startEngine({ dataDir: dir, port: 0, env: {} });
    try {
      const id = await newProject(second, join(dir, 'p'));
      const started = await api<{ processId: string }>(
        'POST',
        `/projects/${id}/processes`,
        {
          command: node(
            "require('child_process').spawn(process.execPath, ['-e', 'console.log([process.pid]); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log('parent ' + process.pid); setInterval(() => {}, 1000)",
          ),
        },
        second,
      );
      let output = '';
      expect(
        await until(async () => {
          output = plain(
            (
              await api<{ output: string }>(
                'GET',
                `/projects/${id}/processes/${started.json.processId}`,
                undefined,
                second,
              )
            ).json.output,
          );
          return /parent \d+/.test(output) && /\[ \d+ \]/.test(output);
        }, 10_000),
      ).toBe(true);
      const parent = Number(/parent (\d+)/.exec(output)?.[1]);
      const grandchild = Number(/\[ (\d+) \]/.exec(output)?.[1]);

      await second.stop();

      expect(await until(() => !isAlive(parent) && !isAlive(grandchild), 3_000)).toBe(true);
    } finally {
      await second.stop();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } catch {
        // Windows can hold a folder a moment after a process in it ends; the OS reclaims temp itself.
      }
    }
  }, 30_000);

  it('deleting a project stops its processes first', async () => {
    const id = await newProject(engine, join(dataDir, 'Doomed Project'));
    const started = await api<{ processId: string }>('POST', `/projects/${id}/processes`, {
      command: node("console.log('pid ' + process.pid); setInterval(() => {}, 1000)"),
    });
    let output = '';
    expect(
      await until(async () => {
        output = (
          await api<{ output: string }>(
            'GET',
            `/projects/${id}/processes/${started.json.processId}`,
          )
        ).json.output;
        return /pid \d+/.test(output);
      }, 10_000),
    ).toBe(true);
    const pid = Number(/pid (\d+)/.exec(output)?.[1]);

    expect((await api('DELETE', `/projects/${id}`)).status).toBe(204);

    expect(await until(() => !isAlive(pid), 3_000)).toBe(true);
  }, 30_000);
});
