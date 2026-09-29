import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ApiErrorSchema,
  ArtifactSchema,
  ChatThreadDetailSchema,
  GuardrailPolicySchema,
  HealthResponseSchema,
  McpServerSchema,
  MessageListResponseSchema,
  NodeRunSchema,
  PostMessageResponseSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  ToolListResponseSchema,
  WorkflowGraphResponseSchema,
  WsServerFrameSchema,
  type ApprovalRequest,
  type GuardrailCheck,
  type WorkflowExport,
  type WorkflowGraphResponse,
} from '@ace/contracts';
import { openDatabase } from '@ace/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  BIND_HOST,
  generateSessionToken,
  guardrailInputFor,
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
    // How many streamed at the same instant: a sweep over the spans, ends first on a tie.
    let streaming = 0;
    let peak = 0;
    for (const edge of all
      .flatMap((span) => [
        { at: span.from, delta: 1 },
        { at: span.to, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta)) {
      streaming += edge.delta;
      peak = Math.max(peak, streaming);
    }
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

/*
 * `guardrailInputFor` is the translation the server owns between the engine's `CheckInput` and the
 * rule packs' `GuardrailInput` (CLAUDE.md §3.4 rule 3). It is a pure function, so it is tested
 * directly rather than driven through a run: every branch of its switch corresponds to a family of
 * checks, and the point of the test is that each family reads the field it needs and no other.
 */
describe('guardrailInputFor maps each check family to the field it reads (FR-GRD-004..010)', () => {
  const check = (type: GuardrailCheck['type'], point: GuardrailCheck['point']): GuardrailCheck => ({
    id: '01M3R3PC0000000000000000CA',
    point,
    type,
    action: 'block',
    enabled: true,
    params: {},
  });

  it('carries text, parts and contract through for a content check', () => {
    const mapped = guardrailInputFor(check('pii', 'output'), {
      point: 'output',
      text: 'a body',
      parts: [{ type: 'text', text: 'a body' }],
      contract: { outputTypes: ['text'] },
    });
    expect(mapped).toEqual({
      text: 'a body',
      parts: [{ type: 'text', text: 'a body' }],
      contract: { outputTypes: ['text'] },
    });
  });

  it('reads the iteration counter for max_iterations, and nothing when there is no loop', () => {
    const input = { point: 'loop' as const, text: '', loop: { iteration: 4, toolCalls: 1, outputHashes: [] } };
    expect(guardrailInputFor(check('max_iterations', 'loop'), input).value).toBe(4);
    // The same check with no loop figures falls back to the base — it adds no `value`.
    expect(guardrailInputFor(check('max_iterations', 'loop'), { point: 'loop', text: '' }).value).toBeUndefined();
  });

  it('reads the tool-call counter for max_tool_calls', () => {
    const input = { point: 'loop' as const, text: '', loop: { iteration: 1, toolCalls: 7, outputHashes: [] } };
    expect(guardrailInputFor(check('max_tool_calls', 'loop'), input).value).toBe(7);
  });

  it('reads the output hashes for repeated_output', () => {
    const input = { point: 'loop' as const, text: '', loop: { iteration: 3, toolCalls: 0, outputHashes: ['a', 'a', 'a'] } };
    expect(guardrailInputFor(check('repeated_output', 'loop'), input).outputHashes).toEqual(['a', 'a', 'a']);
    expect(guardrailInputFor(check('repeated_output', 'loop'), { point: 'loop', text: '' }).outputHashes).toBeUndefined();
  });

  it.each(['max_cost_per_run', 'daily_budget', 'max_tokens_per_node'] as const)(
    'reads the cost figures for %s as value + limit',
    (type) => {
      const input = { point: 'cost' as const, text: '', cost: { costUsd: 0.5, capUsd: 0.4, projected: true } };
      const mapped = guardrailInputFor(check(type, 'cost'), input);
      expect(mapped.value).toBe(0.5);
      expect(mapped.limit).toBe(0.4);
      // No cost figures: the base is returned, with neither value nor limit.
      const bare = guardrailInputFor(check(type, 'cost'), { point: 'cost', text: '' });
      expect(bare.value).toBeUndefined();
      expect(bare.limit).toBeUndefined();
    },
  );

  it('returns the base unchanged for a check that needs no extra field (default)', () => {
    const mapped = guardrailInputFor(check('required_citations', 'output'), { point: 'output', text: 'cited' });
    expect(mapped).toEqual({ text: 'cited' });
  });
});

/*
 * Round 3 wiring: the guardrail engine, the approval flow and the run controls, exercised through
 * the real HTTP + WS server (temp DB, mock provider). The engine's own units cover the services;
 * what this covers is the *wiring in server.ts* — `emitNodeState`, `onWaiting`/`onDecided` and the
 * three callbacks the controls drive the scheduler through. The acceptance suite proves the same
 * paths end to end; these keep them in `apps/server`'s own coverage.
 */
describe('Round 3 wiring: guardrail approvals and run controls over the real server', () => {
  const PLACEHOLDER_PROVIDER = '01M3R3PV0000000000000000PV';
  const PLACEHOLDER_POLICY = '01M3R3PC0000000000000000PC';

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

  async function fixtureProvider(): Promise<string> {
    const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
    await post(`/providers/${provider.id}/refresh-models`, {});
    return provider.id;
  }

  /** Imports a round 3 fixture, rewriting the provider and (optionally) the policy placeholder. */
  async function importFixture(
    file: string,
    options: { providerId: string; policyId?: string },
  ): Promise<{ projectId: string; workflowId: string }> {
    const project = ProjectSchema.parse(await post('/projects', { name: 'R3 wiring' }));
    let text = readFileSync(
      new URL(`../../../../tests/acceptance/fixtures/round-3/${file}`, import.meta.url),
      'utf8',
    ).replaceAll(PLACEHOLDER_PROVIDER, options.providerId);
    if (options.policyId !== undefined) text = text.replaceAll(PLACEHOLDER_POLICY, options.policyId);
    const imported = WorkflowGraphResponseSchema.parse(
      await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
    );
    return { projectId: project.id, workflowId: imported.workflow.id };
  }

  /** The `ask_user`-on-output policy from the fixtures' sidecar, on the project under test. */
  async function askPolicy(projectId: string): Promise<string> {
    const sidecar = JSON.parse(
      readFileSync(
        new URL('../../../../tests/acceptance/fixtures/round-3/pii-ask.policy.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const policy = GuardrailPolicySchema.parse(
      await post('/guardrail-policies', { ...sidecar, projectId }),
    );
    return policy.id;
  }

  async function waitForApproval(runId: string): Promise<ApprovalRequest> {
    for (let i = 0; i < 200; i++) {
      const pending = (await (await api(`/runs/${runId}/approvals`)).json()) as ApprovalRequest[];
      if (pending.length > 0) return pending[0]!;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no approval request appeared');
  }

  async function waitForEnd(runId: string): Promise<ReturnType<typeof RunSchema.parse>> {
    let run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    for (let i = 0; i < 300 && ['PREFLIGHT', 'RUNNING'].includes(run.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    }
    return run;
  }

  it('an ask_user verdict moves the node to WAITING; approving it resumes the run to COMPLETE', async () => {
    const providerId = await fixtureProvider();
    const project = ProjectSchema.parse(await post('/projects', { name: 'holder' }));
    const policyId = await askPolicy(project.id);
    const { workflowId } = await importFixture('pii-ask.json', { providerId, policyId });

    const started = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    const request = await waitForApproval(started.id);

    // The node is parked WAITING while the person decides — the wiring's `onWaiting` did that.
    const waiting = NodeRunSchema.parse(await (await api(`/node-runs/${request.nodeRunId}`)).json());
    expect(waiting.status).toBe('WAITING');

    const approved = NodeRunSchema.parse(
      await post(`/node-runs/${request.nodeRunId}/approve`, { note: 'fine' }),
    );
    expect(approved.approvals?.[0]?.decision).toBe('approve');

    const run = await waitForEnd(started.id);
    expect(run.status, JSON.stringify(run)).toBe('COMPLETE');
    expect((await (await api(`/runs/${run.id}/approvals`)).json()) as unknown[]).toEqual([]);
  }, 60_000);

  it('rejecting an ask_user verdict fails the node GUARDRAIL_VIOLATION and halts the run', async () => {
    const providerId = await fixtureProvider();
    const project = ProjectSchema.parse(await post('/projects', { name: 'holder' }));
    const policyId = await askPolicy(project.id);
    const { workflowId } = await importFixture('pii-ask.json', { providerId, policyId });

    const started = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    const request = await waitForApproval(started.id);

    const rejected = NodeRunSchema.parse(
      await post(`/node-runs/${request.nodeRunId}/reject`, { note: 'no' }),
    );
    expect(rejected.approvals?.[0]?.decision).toBe('reject');

    const run = await waitForEnd(started.id);
    expect(run.status).toBe('HALTED');
    const node = NodeRunSchema.parse(await (await api(`/node-runs/${request.nodeRunId}`)).json());
    expect(node.status).toBe('FAILED');
    expect(node.failureReason).toBe('GUARDRAIL_VIOLATION');
  }, 60_000);

  it('restart replays a finished run onto the same snapshot through the controls (TC-CTL-004)', async () => {
    const providerId = await fixtureProvider();
    const { workflowId } = await importFixture('parallel-merge-all.json', { providerId });

    const first = await waitForEnd(
      RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {})).id,
    );
    expect(first.status, JSON.stringify(first.preflightIssues)).toBe('COMPLETE');

    // The controls own restart, and drive the scheduler through `driveRecordedRun`/`envelopesFor`.
    const restarted = RunSchema.parse(await post(`/runs/${first.id}/restart`, {}));
    expect(restarted.id).not.toBe(first.id);
    expect(restarted.restartedFromRunId).toBe(first.id);
    expect(restarted.snapshot).toEqual(first.snapshot);

    const second = await waitForEnd(restarted.id);
    expect(second.status).toBe('COMPLETE');
    // BR-04: the first run is a recording; a restart never edits it.
    const firstAgain = RunSchema.parse(await (await api(`/runs/${first.id}`)).json());
    expect(firstAgain.status).toBe('COMPLETE');
  }, 60_000);
});

/*
 * Round 4 wiring: the artifact store, the tool registry + MCP manager, the tool loop and multimodal
 * materialisation threaded through the executor, the chat service and the timeline populator — all
 * exercised through the real HTTP + WS server (temp DB, mock provider, no Docker, no network). The
 * engine's own units cover each service; what this covers is the *wiring in server.ts*: the artifact
 * service behind the routes, the `ToolProvider`/`sandboxDirFor`/`recordToolCall`/`toolGuardrails`
 * given to the run service, the `ArtifactMaterialiser`, `resolveNode`/`startRun` on the chat service,
 * the MCP register->persist->emit path, and `startTimelinePopulation`.
 */
describe('Round 4 wiring: artifacts, tools, MCP, chat and the tool loop over the real server', () => {
  const PLACEHOLDER_PROVIDER = '01M4R4PV0000000000000000PV';
  const PLACEHOLDER_ARTIFACT = '01M4R4AR0000000000000000AR';
  const fixturesDir = new URL('../../../../tests/acceptance/fixtures/round-4/', import.meta.url);

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${engine.url}/api/v1${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } });
  const json = (path: string, init: RequestInit = {}) =>
    api(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await json(path, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response.json();
  };

  async function uploadFile(bytes: Uint8Array, name: string, mime: string): Promise<Response> {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type: mime }));
    return fetch(`${engine.url}/api/v1/artifacts`, { method: 'POST', headers: authHeaders(), body: form });
  }

  async function mockProvider(): Promise<string> {
    const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
    await post(`/providers/${provider.id}/refresh-models`, {});
    return provider.id;
  }

  async function importFixture(
    file: string,
    providerId: string,
    rewrites: Record<string, string> = {},
  ): Promise<WorkflowGraphResponse> {
    const project = ProjectSchema.parse(await post('/projects', { name: 'R4 wiring' }));
    let text = readFileSync(new URL(file, fixturesDir), 'utf8').replaceAll(
      PLACEHOLDER_PROVIDER,
      providerId,
    );
    for (const [from, to] of Object.entries(rewrites)) text = text.replaceAll(from, to);
    return WorkflowGraphResponseSchema.parse(
      await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
    );
  }

  async function waitForEnd(runId: string): Promise<ReturnType<typeof RunSchema.parse>> {
    let run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    for (let i = 0; i < 300 && ['PREFLIGHT', 'RUNNING'].includes(run.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    }
    return run;
  }

  function nodeId(graph: WorkflowGraphResponse, kind: string, index = 0): string {
    const node = graph.nodes.filter((candidate) => candidate.kind === kind)[index];
    if (node === undefined) throw new Error(`no ${kind} node in fixture`);
    return node.id;
  }

  const png = (): Buffer => readFileSync(new URL('media/sample.png', fixturesDir));

  it('POST /artifacts stores a file; GET returns the row and bytes with the §2.1 headers (FR-MM-001/009)', async () => {
    const bytes = png();
    const created = await uploadFile(bytes, 'sample.png', 'image/png');
    expect(created.status).toBe(201);
    const artifact = ArtifactSchema.parse(await created.json());
    expect(artifact.mime).toBe('image/png');
    expect(artifact.name).toBe('sample.png');
    expect(artifact.size).toBe(bytes.byteLength);

    const row = ArtifactSchema.parse(await (await api(`/artifacts/${artifact.id}`)).json());
    expect(row.id).toBe(artifact.id);

    const content = await api(`/artifacts/${artifact.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('Content-Type')).toBe('image/png');
    expect(content.headers.get('ETag')).toBe(`"${artifact.hash}"`);
    expect(content.headers.get('Accept-Ranges')).toBe('bytes');
    expect(content.headers.get('Content-Disposition')).toContain('sample.png');
    expect(new Uint8Array(await content.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });

  it('dedupes identical bytes to one artifact id (FR-MM-002)', async () => {
    const bytes = png();
    const first = ArtifactSchema.parse(await (await uploadFile(bytes, 'a.png', 'image/png')).json());
    const second = ArtifactSchema.parse(await (await uploadFile(bytes, 'b.png', 'image/png')).json());
    expect(second.id).toBe(first.id);
  });

  it('serves a byte range as 206 with Content-Range (FR-MM-009)', async () => {
    const bytes = png();
    const artifact = ArtifactSchema.parse(await (await uploadFile(bytes, 'r.png', 'image/png')).json());

    const ranged = await api(`/artifacts/${artifact.id}/content`, { headers: { Range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect(new Uint8Array(await ranged.arrayBuffer()).byteLength).toBe(4);
  });

  it('refuses an over-limit upload 413 upload_too_large, naming the limit (TC-MM-001)', async () => {
    await json('/settings', { method: 'PATCH', body: JSON.stringify({ maxUploadMb: 1 }) });
    const tooBig = new Uint8Array(2 * 1024 * 1024); // 2 MB, over the 1 MB cap just set
    const response = await uploadFile(tooBig, 'big.zip', 'application/zip');

    expect(response.status).toBe(413);
    const error = ApiErrorSchema.parse(await response.json());
    expect(error.error.code).toBe('upload_too_large');
    expect((error.error.details as { maxBytes: number }).maxBytes).toBe(1024 * 1024);
  });

  it('refuses a type §2.1 does not allow 415 unsupported_type (TC-MM-002)', async () => {
    const response = await uploadFile(new Uint8Array([1, 2, 3]), 'evil.exe', 'application/x-msdownload');
    expect(response.status).toBe(415);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('unsupported_type');
  });

  it('GET /tools lists the six built-ins in §2.2 order (FR-TOOL-001)', async () => {
    const body = ToolListResponseSchema.parse(await (await api('/tools')).json());
    expect(body.items.map((tool) => tool.name)).toEqual([
      'echo',
      'code_sandbox',
      'sandbox_delete',
      'http_request',
      'web_search',
      'web_fetch',
    ]);
  });

  it('connects a stdio MCP server, registers its tools, checks and removes it (FR-TOOL-007)', async () => {
    const mcpStatus: unknown[] = [];
    const socket = new WebSocket(`${engine.wsUrl}?token=${engine.token}`);
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string };
      if (frame.type === 'mcp.status') mcpStatus.push(frame);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'engine' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const serverPath = fileURLToPath(new URL('servers/mcp-server.mjs', fixturesDir));
    const server = McpServerSchema.parse(
      await post('/mcp-servers', {
        name: 'fixtures',
        transport: 'stdio',
        command: process.execPath,
        args: [serverPath],
      }),
    );
    expect(server.status).toBe('connected');
    expect(server.toolCount).toBe(2);

    const listed = (await (await api('/mcp-servers')).json()) as { items: unknown[] };
    expect(listed.items).toHaveLength(1);

    const withMcp = ToolListResponseSchema.parse(await (await api('/tools')).json());
    expect(withMcp.items.map((tool) => tool.name)).toContain('mcp_fixtures_ping');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mcpStatus.length).toBeGreaterThanOrEqual(1);

    const checked = McpServerSchema.parse(await post(`/mcp-servers/${server.id}/check`, {}));
    expect(checked.status).toBe('connected');

    const removed = await api(`/mcp-servers/${server.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const afterRemove = ToolListResponseSchema.parse(await (await api('/tools')).json());
    expect(afterRemove.items.map((tool) => tool.name)).not.toContain('mcp_fixtures_ping');

    socket.close();
  }, 30_000);

  it('runs a tool workflow to COMPLETE and records the tool call on the node run (FR-TOOL-002/009)', async () => {
    const providerId = await mockProvider();
    const graph = await importFixture('tools-echo.json', providerId);
    const agentId = nodeId(graph, 'agent');

    const started = RunSchema.parse(await post(`/workflows/${graph.workflow.id}/runs`, {}));
    const run = await waitForEnd(started.id);
    expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');

    const nodeRuns = (await (await api(`/runs/${run.id}/node-runs`)).json()) as unknown[];
    const agentRun = nodeRuns.map((n) => NodeRunSchema.parse(n)).find((n) => n.nodeId === agentId);
    expect(agentRun?.toolCalls.map((call) => call.toolName)).toContain('echo');
    expect(agentRun?.toolCalls[0]?.status).toBe('ok');
  }, 30_000);

  it('materialises an uploaded image onto the Input node so a vision run completes (FR-MM-003/005)', async () => {
    const providerId = await mockProvider();
    const artifact = ArtifactSchema.parse(await (await uploadFile(png(), 'sample.png', 'image/png')).json());
    const graph = await importFixture('vision.json', providerId, { [PLACEHOLDER_ARTIFACT]: artifact.id });

    const started = RunSchema.parse(await post(`/workflows/${graph.workflow.id}/runs`, {}));
    const run = await waitForEnd(started.id);
    expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');
  }, 30_000);

  it('backs a produced media part with a real stored artifact (FR-MM-004)', async () => {
    const providerId = await mockProvider();
    const graph = await importFixture('media.json', providerId);

    const started = RunSchema.parse(await post(`/workflows/${graph.workflow.id}/runs`, {}));
    const run = await waitForEnd(started.id);
    expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');

    const events = (await (await api(`/runs/${run.id}/events`)).json()) as {
      type: string;
      payload: { output?: { type: string; artifactId?: string }[] };
    }[];
    const mediaRefs = events
      .filter((event) => event.type === 'node.output')
      .flatMap((event) => event.payload.output ?? [])
      .filter((part) => 'artifactId' in part && part.artifactId !== undefined);
    expect(mediaRefs.length).toBeGreaterThan(0);

    // Every produced media reference resolves to a real, stored artifact (store() materialised it).
    for (const ref of mediaRefs) {
      const resolved = await api(`/artifacts/${ref.artifactId}`);
      expect(resolved.status, `artifact ${ref.artifactId}`).toBe(200);
    }
  }, 30_000);

  it('starts a direct chat, persists the reply, lists and deletes the thread (FR-CHAT-004/006)', async () => {
    const providerId = await mockProvider();
    const graph = await importFixture('chat-french.json', providerId);
    const agentId = nodeId(graph, 'agent');

    const begun = (await (
      await json(`/nodes/${agentId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ content: [{ type: 'text', text: 'Bonjour' }] }),
      })
    ).json()) as { threadId: string; messageId: string };
    expect(begun.threadId).toBeDefined();
    expect(begun.messageId).toBeDefined();

    // The reply streams in the background; poll the thread until the agent turn is persisted.
    let detail = ChatThreadDetailSchema.parse(await (await api(`/chat/threads/${begun.threadId}`)).json());
    for (let i = 0; i < 200 && detail.messages.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      detail = ChatThreadDetailSchema.parse(await (await api(`/chat/threads/${begun.threadId}`)).json());
    }
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'agent']);

    const threads = (await (await api(`/nodes/${agentId}/chat/threads`)).json()) as { id: string }[];
    expect(threads.map((thread) => thread.id)).toContain(begun.threadId);

    const deleted = await api(`/chat/threads/${begun.threadId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await api(`/chat/threads/${begun.threadId}`)).status).toBe(404);
  }, 30_000);

  it('refuses a direct chat on a non-agent node without a 500', async () => {
    const providerId = await mockProvider();
    const graph = await importFixture('chat-french.json', providerId);
    const outputId = nodeId(graph, 'output');

    const response = await json(`/nodes/${outputId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe('invalid_config');
  }, 30_000);

  it('derives a timeline from run events and starts a run from a posted message (FR-CHAT-001/003)', async () => {
    const providerId = await mockProvider();
    const graph = await importFixture('chat-french.json', providerId);

    // FR-CHAT-003: the message becomes the Input node's text and, with run:true, starts a run.
    const posted = PostMessageResponseSchema.parse(
      await post(`/workflows/${graph.workflow.id}/messages`, {
        content: [{ type: 'text', text: 'Start please' }],
        run: true,
      }),
    );
    expect(posted.run).toBeDefined();
    const run = await waitForEnd(posted.run!.id);
    expect(run.status, JSON.stringify(run.preflightIssues)).toBe('COMPLETE');

    // FR-CHAT-001: the timeline populator turned the run events into rows.
    const timeline = MessageListResponseSchema.parse(
      await (await api(`/workflows/${graph.workflow.id}/messages`)).json(),
    );
    const types = new Set(timeline.items.map((message) => message.type));
    expect(types.has('user')).toBe(true);
    expect(types.has('event')).toBe(true);
    expect(types.has('output') || types.has('agent')).toBe(true);
  }, 30_000);
});
