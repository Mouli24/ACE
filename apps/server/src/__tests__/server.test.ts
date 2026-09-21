import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, HealthResponseSchema, WsServerFrameSchema } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  BIND_HOST,
  generateSessionToken,
  readyLine,
  startEngine,
  type RunningEngine,
} from '../server.js';

let dir: string;
let engine: RunningEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-server-'));
  // Port 0 asks the OS for a free port, so tests never collide with a running engine.
  engine = await startEngine({ dataDir: dir, port: 0, env: {} });
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

const authHeaders = () => ({ Authorization: `Bearer ${engine.token}` });

describe('TC-SYS-001 Remote access blocked', () => {
  it('listens on 127.0.0.1 and never on all interfaces', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
    expect(engine.url).toBe(`http://127.0.0.1:${engine.port}`);
    expect(engine.url).not.toContain('0.0.0.0');
  });

  it('serves the API on the loopback address', async () => {
    const response = await fetch(`${engine.url}/api/v1/health`, { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json()).db).toBe('ok');
  });

  it('binds the loopback address itself, which is what closes the port to the LAN', () => {
    // The ground truth for FR-SYS-001. Connecting to 0.0.0.0 as a *client* is resolved to
    // localhost by the OS, so it proves nothing — what the socket is bound to does.
    expect(engine.address).toBe('127.0.0.1');
  });

  it('does not answer on this machine LAN address', async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && entry.internal === false);

    if (lan === undefined) {
      // A machine with no LAN interface (some CI containers) has nothing to prove here; the bind
      // assertion above already covers the requirement.
      expect(engine.address).toBe('127.0.0.1');
      return;
    }

    const attempt = fetch(`http://${lan.address}:${engine.port}/api/v1/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });

    await expect(attempt).rejects.toThrow();
  });
});

describe('§2.10 session token handshake', () => {
  it('mints 32 random bytes as hex, new on every start', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(engine.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the token to <dataDir>/session-token for the CLI', () => {
    const path = join(dir, 'session-token');

    expect(readFileSync(path, 'utf8')).toBe(engine.token);
  });

  it('gives the token file owner-only permissions where the OS has them', () => {
    const mode = statSync(join(dir, 'session-token')).mode & 0o777;

    if (process.platform === 'win32') {
      // Node cannot express a POSIX mode on Windows — it reports 0666 whatever the ACL says. The
      // file's protection there comes from the ACL it inherits from the user profile directory,
      // which is where <dataDir> lives by default (§2.1: ~/.ace).
      expect(statSync(join(dir, 'session-token')).isFile()).toBe(true);
      return;
    }

    expect(mode).toBe(0o600);
  });

  it('prints the line from §2.10 with the URL and the token', () => {
    const line = readyLine('http://127.0.0.1:4747', 'http://localhost:5173', 'abc123');

    expect(line).toBe(
      'ACE engine ready · http://127.0.0.1:4747 · open http://localhost:5173/?token=abc123',
    );
  });

  it('refuses a request without the token (FR-SYS-002)', async () => {
    const response = await fetch(`${engine.url}/api/v1/health`);

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
  });

  it('refuses a request from a foreign origin (FR-SYS-003)', async () => {
    const response = await fetch(`${engine.url}/api/v1/health`, {
      headers: { ...authHeaders(), Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
  });
});

describe('FR-SYS-004 the engine really persists', () => {
  it('keeps a project across a restart over the same data directory', async () => {
    const created = await fetch(`${engine.url}/api/v1/projects`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo', folderPath: join(dir, 'demo') }),
    });
    expect(created.status).toBe(201);

    await engine.stop();
    engine = await startEngine({ dataDir: dir, port: 0, env: {} });

    const listed = await fetch(`${engine.url}/api/v1/projects`, { headers: authHeaders() });
    const body = (await listed.json()) as { items: { name: string }[] };

    expect(body.items.map((p) => p.name)).toEqual(['Demo']);
  });

  it('issues a different token on each start, so an old one stops working', async () => {
    const old = engine.token;

    await engine.stop();
    engine = await startEngine({ dataDir: dir, port: 0, env: {} });

    expect(engine.token).not.toBe(old);
    const response = await fetch(`${engine.url}/api/v1/health`, {
      headers: { Authorization: `Bearer ${old}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('TC-SYS-003 WebSocket over a real socket', () => {
  function open(token: string): Promise<{ socket: WebSocket; frames: unknown[]; closed: Promise<number> }> {
    const socket = new WebSocket(`${engine.wsUrl}?token=${token}`);
    const frames: unknown[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data))));

    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    return new Promise((resolve) => {
      socket.on('open', () => resolve({ socket, frames, closed }));
      socket.on('close', () => resolve({ socket, frames, closed }));
    });
  }

  it('closes a connection with a bad token using 4401', async () => {
    const { closed } = await open('not-the-token');

    expect(await closed).toBe(4401);
  });

  it('greets a good token with hello', async () => {
    const { socket, frames } = await open(engine.token);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(frames).toHaveLength(1);
    expect(WsServerFrameSchema.parse(frames[0]).type).toBe('hello');
    socket.close();
  });

  it('delivers workflow.updated after a graph-ops batch, end to end', async () => {
    const project = (await (
      await fetch(`${engine.url}/api/v1/projects`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Demo', folderPath: join(dir, 'ws-demo') }),
      })
    ).json()) as { id: string };

    const workflow = (await (
      await fetch(`${engine.url}/api/v1/projects/${project.id}/workflows`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Flow 1' }),
      })
    ).json()) as { id: string };

    const { socket, frames } = await open(engine.token);
    socket.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflow.id } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const node = {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
      workflowId: workflow.id,
      kind: 'output',
      name: 'Output',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [],
      config: {},
    };
    const applied = await fetch(`${engine.url}/api/v1/workflows/${workflow.id}/graph-ops`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ baseVersion: 0, ops: [{ op: 'add_node', node }] }),
    });
    expect(applied.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const updates = frames.map((f) => WsServerFrameSchema.parse(f)).filter((f) => f.type === 'workflow.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.type === 'workflow.updated' && updates[0].payload.version).toBe(1);

    socket.close();
  });
});

describe('FR-SYS-007 the engine logs to its data directory', () => {
  it('writes a dated log file under <dataDir>/logs', async () => {
    await fetch(`${engine.url}/api/v1/health`, { headers: authHeaders() });

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(dir, 'logs'));

    expect(files.some((name) => /^ace-\d{4}-\d{2}-\d{2}\.log$/.test(name))).toBe(true);
  });

  it('never writes the session token into the log', async () => {
    await fetch(`${engine.url}/api/v1/health`, { headers: authHeaders() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { readdirSync } = await import('node:fs');
    const logs = readdirSync(join(dir, 'logs'))
      .map((name) => readFileSync(join(dir, 'logs', name), 'utf8'))
      .join('');

    expect(logs).not.toContain(engine.token);
  });
});
