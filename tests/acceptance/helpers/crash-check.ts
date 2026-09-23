/**
 * §8.2 manual pass: `kill -9` the engine during a burst of 200 graph-ops -> restart -> the DB
 * opens and the graph is consistent.
 *
 * Each batch is three ops (add_node, add_node, add_edge) so the check is about batch atomicity
 * across an unclean death, not just "a row survived": after the restart the invariants
 * `nodes === 2 * version`, `edges === version` and "every edge endpoint exists" can only hold if
 * each batch landed whole or not at all.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivePorts, portId, type Edge, type Node, type NodePortSource } from '@ace/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.argv[2] as string;
const DATA = join(SCRATCH, 'crash-data');
const HANDLE = join(SCRATCH, 'crash-handle.json');
const PORT = 47491;
const BURST = 200;
const KILL_AFTER = 60;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newId(now = Date.now()): string {
  let time = now;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    const mod = time % 32;
    out = CROCKFORD[mod] + out;
    time = (time - mod) / 32;
  }
  for (let i = 0; i < 16; i += 1) out += CROCKFORD[Math.floor(Math.random() * 32)];
  return out;
}

function inputNode(workflowId: string, x: number): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'input',
    config: { artifactIds: [], outputTypes: ['text'] },
  };
  const node = { ...base, workflowId, name: 'Input', position: { x, y: 0 } } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function outputNode(workflowId: string, x: number): Node {
  const base: NodePortSource = { id: newId(), kind: 'output', config: {} };
  const node = { ...base, workflowId, name: 'Output', position: { x, y: 120 } } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function edgeBetween(workflowId: string, from: Node, to: Node): Edge {
  return {
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: portId(from.id, 'out', 'text') },
    to: { nodeId: to.id, portId: portId(to.id, 'in', 'text') },
  };
}

interface Handle {
  url: string;
  token: string;
  pid: number;
}

async function boot(label: string): Promise<Handle> {
  if (existsSync(HANDLE)) rmSync(HANDLE);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(HERE, 'standalone-engine.ts'), DATA, String(PORT), HANDLE],
    { cwd: join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  for (let i = 0; i < 90; i += 1) {
    if (existsSync(HANDLE)) break;
    if (child.exitCode !== null) {
      throw new Error(`${label}: engine exited ${child.exitCode}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!existsSync(HANDLE)) throw new Error(`${label}: engine never wrote its handle\n${stderr}`);
  const handle = JSON.parse(readFileSync(HANDLE, 'utf8')) as Handle;
  console.log(`[${label}] engine up  pid=${handle.pid}  ${handle.url}`);
  return handle;
}

/**
 * Windows has no SIGKILL; `taskkill /F` is the same thing — immediate termination with no chance
 * to flush and no shutdown hook, which is exactly what this check needs.
 */
function sigkill(pid: number): void {
  spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }).unref();
}

async function main(): Promise<void> {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });

  /* ---------------------------------------------------------- phase 1: burst */

  const first = await boot('phase-1');
  const headers = { Authorization: `Bearer ${first.token}`, 'content-type': 'application/json' };
  const api = (path: string): string => `${first.url}/api/v1${path}`;

  const project = (await (
    await fetch(api('/projects'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `crash-${newId().slice(-6)}` }),
    })
  ).json()) as { id: string };
  const workflow = (await (
    await fetch(api(`/projects/${project.id}/workflows`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'crash' }),
    })
  ).json()) as { id: string };
  console.log(`[phase-1] workflow ${workflow.id}`);

  let confirmed = 0;
  let killedAt = -1;
  let deathError = '';
  for (let i = 0; i < BURST; i += 1) {
    const from = inputNode(workflow.id, i * 60);
    const to = outputNode(workflow.id, i * 60);
    const body = JSON.stringify({
      baseVersion: confirmed,
      ops: [
        { op: 'add_node', node: from },
        { op: 'add_node', node: to },
        { op: 'add_edge', edge: edgeBetween(workflow.id, from, to) },
      ],
    });

    if (i === KILL_AFTER) {
      killedAt = confirmed;
      console.log(`[phase-1] SIGKILL (taskkill /F) at confirmed version ${confirmed}, mid-burst`);
      sigkill(first.pid);
    }

    try {
      const response = await fetch(api(`/workflows/${workflow.id}/graph-ops`), {
        method: 'POST',
        headers,
        body,
      });
      if (!response.ok) {
        deathError = `HTTP ${response.status} at op ${i}`;
        break;
      }
      confirmed = ((await response.json()) as { version: number }).version;
    } catch (error) {
      deathError = `${(error as Error).message} at op ${i}`;
      break;
    }
  }

  console.log(`[phase-1] client stopped: ${deathError || 'burst completed'}`);
  console.log(
    `[phase-1] last version the client saw confirmed: ${confirmed} (kill fired at ${killedAt})`,
  );
  sigkill(first.pid);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  /* -------------------------------------------------------- phase 2: restart */

  console.log(`[phase-2] ace.sqlite on disk: ${statSync(join(DATA, 'ace.sqlite')).size} bytes`);
  const second = await boot('phase-2');
  const h2 = { Authorization: `Bearer ${second.token}`, 'content-type': 'application/json' };

  const health = (await (await fetch(`${second.url}/api/v1/health`, { headers: h2 })).json()) as {
    db?: string;
  };
  console.log(`[phase-2] GET /health -> ${JSON.stringify(health)}`);

  const after = (await (
    await fetch(`${second.url}/api/v1/workflows/${workflow.id}`, { headers: h2 })
  ).json()) as { workflow: { version: number }; nodes: Node[]; edges: Edge[] };

  const version = after.workflow.version;
  const nodeIds = new Set(after.nodes.map((node) => node.id));
  const portIds = new Set(
    after.nodes.flatMap((node) => [...node.inputs, ...node.outputs].map((port) => port.id)),
  );
  const dangling = after.edges.filter(
    (edge) =>
      !nodeIds.has(edge.from.nodeId) ||
      !nodeIds.has(edge.to.nodeId) ||
      !portIds.has(edge.from.portId) ||
      !portIds.has(edge.to.portId),
  );

  console.log('');
  console.log('=== after restart ===');
  console.log(`version        ${version}`);
  console.log(`nodes          ${after.nodes.length}   (expected 2 x version = ${2 * version})`);
  console.log(`edges          ${after.edges.length}   (expected version = ${version})`);
  console.log(`dangling edges ${dangling.length}`);

  const checks: [string, boolean][] = [
    ['DB reopened after SIGKILL', health.db === 'ok'],
    ['batches are whole: nodes === 2 x version', after.nodes.length === 2 * version],
    ['batches are whole: edges === version', after.edges.length === version],
    ['no dangling edge endpoints', dangling.length === 0],
    ['no committed work lost (version >= client-confirmed)', version >= confirmed],
    ['no phantom commits (version <= client-confirmed + 1 in-flight)', version <= confirmed + 1],
  ];

  console.log('');
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

  const writable = await fetch(`${second.url}/api/v1/workflows/${workflow.id}/graph-ops`, {
    method: 'POST',
    headers: h2,
    body: JSON.stringify({
      baseVersion: version,
      ops: [{ op: 'add_node', node: inputNode(workflow.id, -100) }],
    }),
  });
  console.log(
    `${writable.ok ? 'PASS' : 'FAIL'}  the recovered graph still accepts writes (HTTP ${writable.status})`,
  );

  sigkill(second.pid);

  const failed = checks.filter(([, ok]) => !ok).length + (writable.ok ? 0 : 1);
  console.log('');
  console.log(failed === 0 ? 'RESULT: all checks passed' : `RESULT: ${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
