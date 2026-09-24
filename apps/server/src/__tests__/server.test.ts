import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApiErrorSchema,
  HealthResponseSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  WsServerFrameSchema,
  type WorkflowExport,
} from '@ace/contracts';
import { openDatabase } from '@ace/storage-local';
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

describe('§2.9 the WebSocket lives only at /ws', () => {
  it('refuses an upgrade on any other path', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/not-ws?token=${engine.token}`);
    const failed = await new Promise<boolean>((resolve) => {
      socket.on('error', () => resolve(true));
      socket.on('open', () => {
        socket.close();
        resolve(false);
      });
    });

    expect(failed).toBe(true);
  });
});

describe('startEngine defaults', () => {
  it('reads the port from the config when none is passed', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ace-default-port-'));
    writeFileSync(join(other, 'ace.config.json'), JSON.stringify({ port: 47_595 }));

    const started = await startEngine({ dataDir: other, env: {} });
    expect(started.port).toBe(47_595);

    await started.stop();
    try {
      rmSync(other, { recursive: true, force: true });
    } catch {
      // Windows may still hold the handle.
    }
  }, 30_000);

  it('falls back to the real environment when none is passed', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ace-default-env-'));
    const started = await startEngine({ dataDir: other, port: 0 });

    expect(started.port).toBeGreaterThan(0);

    await started.stop();
    try {
      rmSync(other, { recursive: true, force: true });
    } catch {
      // Windows may still hold the handle.
    }
  }, 30_000);

  it('exposes the adapters later rounds build on', () => {
    expect(engine.ports.repository).toBeDefined();
    expect(engine.ports.blobs).toBeDefined();
    expect(engine.ports.secrets).toBeDefined();
  });
});

describe('NFR-REL-03 the engine backs up before it migrates', () => {
  it('copies an existing database when a shipped migration is still pending', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ace-migrate-'));
    const dbPath = join(other, 'ace.sqlite');

    // A database that already carries a migration ledger, but not ours: opening it for real makes
    // the shipped migration pending against a non-empty ledger, which is the case that must back up.
    const seeded = openDatabase({
      path: dbPath,
      migrations: [{ id: '19990101T000000_someone_elses', up: 'CREATE TABLE legacy (id TEXT);' }],
    });
    seeded.sqlite.close();

    const started = await startEngine({ dataDir: other, port: 0, env: {} });
    await started.stop();

    const backups = readdirSync(other).filter((name) => name.startsWith('ace-backup-'));
    expect(backups).toHaveLength(1);

    try {
      rmSync(other, { recursive: true, force: true });
    } catch {
      // Windows may still hold the handle.
    }
  }, 30_000);
});

describe('Round 2 wiring: a run goes through the real router, provider check and gate', () => {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${engine.url}/api/v1${path}`, {
      ...init,
      headers: { ...authHeaders(), 'Content-Type': 'application/json', ...init.headers },
    });
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response.json();
  };

  /** Imports a round 2 fixture against a fresh mock provider and returns the workflow id. */
  async function importFixture(
    file: string,
    options: { concurrency?: number; patch?: (exported: WorkflowExport) => void } = {},
  ): Promise<string> {
    const provider = ProviderSchema.parse(
      await post('/providers', {
        type: 'mock',
        name: 'Mock',
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      }),
    );
    await post(`/providers/${provider.id}/refresh-models`, {});
    const project = ProjectSchema.parse(await post('/projects', { name: 'Wiring' }));

    const exported = JSON.parse(
      readFileSync(
        new URL(`../../../../tests/acceptance/fixtures/round-2/${file}`, import.meta.url),
        'utf8',
      ).replaceAll('01M3R2PV0000000000000000PV', provider.id),
    ) as WorkflowExport;
    options.patch?.(exported);
    const imported = WorkflowGraphResponseSchema.parse(
      await post(`/projects/${project.id}/workflows/import`, exported),
    );
    return imported.workflow.id;
  }

  async function waitForEnd(runId: string): Promise<ReturnType<typeof RunSchema.parse>> {
    let run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    for (let i = 0; i < 200 && ['PREFLIGHT', 'RUNNING'].includes(run.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    }
    return run;
  }

  it('runs the linear mock workflow to COMPLETE', async () => {
    const workflowId = await importFixture('linear-mock.json');

    const started = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    const run = await waitForEnd(started.id);

    expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');
  }, 30_000);

  it('FR-EXE-008 answers POST /runs while the run is still going (D65)', async () => {
    const workflowId = await importFixture('slow.json');

    const began = Date.now();
    const started = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));

    // mock-slow streams for about two seconds; the response must not wait for it.
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(started.status).toBe('RUNNING');
    expect(started.endedAt).toBeUndefined();

    const run = await waitForEnd(started.id);
    expect(run.status).toBe('COMPLETE');
  }, 30_000);

  it('D-027 never streams from more agents at once than the provider allows (TC-PRV-009)', async () => {
    // Five mock-slow agents fed by one Input, on a provider limited to two. Node runs are stamped
    // at dispatch, before the gate, so overlap is measured where the limit applies: the provider
    // call, seen as the span of each node run's streamed tokens.
    const workflowId = await importFixture('slow.json', {
      concurrency: 2,
      patch: (exported) => {
        const input = exported.nodes.find((node) => node.kind === 'input');
        const agent = exported.nodes.find((node) => node.kind === 'agent');
        if (input === undefined || agent === undefined) throw new Error('fixture shape changed');
        for (const i of [1, 2, 3, 4]) {
          const id = `${agent.id.slice(0, -1)}${i}`;
          const port = <P extends { name: string }>(p: P, dir: 'in' | 'out'): P => ({
            ...p,
            id: `${id}:${dir}:${p.name}`,
          });
          const copy = {
            ...structuredClone(agent),
            id,
            name: `Agent ${i}`,
            inputs: agent.inputs.map((p) => port(p, 'in')),
            outputs: agent.outputs.map((p) => port(p, 'out')),
          };
          exported.nodes.push(copy);
          exported.edges.push({
            ...structuredClone(exported.edges[0]!),
            id: `${id.slice(0, -2)}E${i}`,
            from: { nodeId: input.id, portId: input.outputs[0]!.id },
            to: { nodeId: id, portId: copy.inputs[0]!.id },
          });
        }
      },
    });

    const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
    const spans = new Map<string, { from: number; to: number }>();
    let completed = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string; payload: { nodeRunId?: string } };
      if (frame.type === 'run.completed') completed = true;
      if (frame.type !== 'node.token' || frame.payload.nodeRunId === undefined) return;
      const at = Date.now();
      const span = spans.get(frame.payload.nodeRunId);
      spans.set(frame.payload.nodeRunId, { from: span?.from ?? at, to: at });
    });
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    for (let i = 0; i < 400 && !completed; i++) await new Promise((r) => setTimeout(r, 50));
    socket.close();

    expect((await waitForEnd(started.id)).status).toBe('COMPLETE');
    const all = [...spans.values()];
    expect(all).toHaveLength(5);
    const peak = Math.max(
      ...all.map((span) => all.filter((other) => other.from <= span.to && span.from <= other.to).length),
    );
    expect(peak, `peak concurrent provider calls was ${peak}`).toBeLessThanOrEqual(2);
  }, 60_000);

  it.each([
    [{ apiKey: 'bad' }, 'AUTH_FAILED'],
    [{ apiKey: 'ratelimited' }, 'RATE_LIMITED'],
    [{ baseUrl: 'http://unreachable.local' }, 'UNREACHABLE'],
    [{}, 'CONNECTED'],
  ] as const)(
    'D-025 a mock provider created with %o checks as %s over the API (TC-PRV-003/004)',
    async (row, expected) => {
      const provider = ProviderSchema.parse(
        await post('/providers', { type: 'mock', name: 'Mock', ...row }),
      );

      const checked = (await post(`/providers/${provider.id}/check`, {})) as { status: string };

      expect(checked.status).toBe(expected);
    },
  );

  it('D64 lists providers as { items }, like every other collection', async () => {
    await post('/providers', { type: 'mock', name: 'Mock' });

    const response = await api('/providers');
    const body = (await response.json()) as { items: unknown[] };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => ProviderSchema.parse(item).name)).toEqual(['Mock']);
  });
});
