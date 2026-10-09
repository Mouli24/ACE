import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ApiErrorSchema,
  WorkflowExportSchema,
  defaultAgentTools,
  defaultExecutionSettings,
  defaultRouting,
  derivePorts,
  portId,
  type Edge,
  type Node,
  type NodePortSource,
  type Workflow,
} from '@ace/contracts';
import { AceApiError, createAceClient, type AceClient } from '@ace/sdk';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';

/**
 * Round 1 cross-test: Mouli verifying Arhant's A1 engine skeleton
 * (`docs/team-prompts/01-round-1-skeleton.md` §8.2).
 *
 * Everything here drives the **real engine** over HTTP and WebSocket through `@ace/sdk`, exactly
 * as the web app does — a temp database, the mock provider, no env vars and no keys. The engine is
 * started once by `tests/acceptance/global-setup.ts`, which publishes `ACE_URL`, `ACE_WS_URL`,
 * `ACE_TOKEN` and `ACE_DATA_DIR`.
 */

const url = process.env['ACE_URL'] as string;
const wsUrl = process.env['ACE_WS_URL'] as string;
const token = process.env['ACE_TOKEN'] as string;
const dataDir = process.env['ACE_DATA_DIR'] as string;

const client: AceClient = createAceClient({ baseUrl: url, token });

/* -------------------------------------------------------------------------- */
/* Helpers — ids and graph fixtures the engine will accept                     */
/* -------------------------------------------------------------------------- */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A Crockford ULID (D21); the engine refuses anything else as an id. */
function newId(now = Date.now()): string {
  let time = now;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    const mod = time % 32;
    out = CROCKFORD[mod] + out;
    time = (time - mod) / 32;
  }
  for (let i = 0; i < 16; i += 1) {
    out += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return out;
}

function agentNode(
  workflowId: string,
  overrides: Partial<{ name: string; inputTypes: Node['inputs'] }> = {},
): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'agent',
    config: {
      routing: defaultRouting(),
      instructions: '',
      inputTypes: ['text'],
      outputTypes: ['text'],
      execution: defaultExecutionSettings(),
      contextPolicy: { budgetTokens: 4000 },
      tools: defaultAgentTools(),
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
    },
  };
  const node = {
    ...base,
    workflowId,
    name: overrides.name ?? 'Agent',
    position: { x: 0, y: 0 },
  } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function inputNode(workflowId: string, x = 0): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'input',
    config: { artifactIds: [], outputTypes: ['text'] },
  };
  const node = {
    ...base,
    workflowId,
    name: 'Input',
    position: { x, y: 0 },
  } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function outputNode(workflowId: string): Node {
  const base: NodePortSource = { id: newId(), kind: 'output', config: {} };
  const node = {
    ...base,
    workflowId,
    name: 'Output',
    position: { x: 400, y: 0 },
  } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function edgeBetween(
  workflowId: string,
  from: Node,
  fromPort: string,
  to: Node,
  toPort: string,
): Edge {
  return {
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: portId(from.id, 'out', fromPort) },
    to: { nodeId: to.id, portId: portId(to.id, 'in', toPort) },
  };
}

/** A fresh project + workflow for one test, so no test depends on another's state. */
async function freshWorkflow(
  name = 'cross-test',
): Promise<{ projectId: string; workflow: Workflow }> {
  const project = await client.createProject({
    name: `${name}-${newId().slice(-6)}`,
  });
  const workflow = await client.createWorkflow(project.id, { name });
  return { projectId: project.id, workflow };
}

const expectApiError = async (promise: Promise<unknown>): Promise<AceApiError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AceApiError);
  return error as AceApiError;
};

/** The raw FR-SYS-006 envelope, for the cases the SDK would turn into its own error. */
async function raw(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${url}/api/v1${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const bearer = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

describe('TC-SYS-002 session token (FR-SYS-002)', () => {
  it('a request with no token is 401 in the FR-SYS-006 shape', async () => {
    const { status, body } = await raw('/projects');
    expect(status).toBe(401);
    const parsed = ApiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe('unauthorized');
    expect(parsed.success && parsed.data.error.kind).toBe('auth');
    expect(parsed.success && parsed.data.error.retryable).toBe(false);
  });

  it('a request with the wrong token is 401', async () => {
    const { status, body } = await raw('/projects', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(status).toBe(401);
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('/health is behind the token too', async () => {
    expect((await raw('/health')).status).toBe(401);
  });

  it('the token never appears in a response body', async () => {
    const { body } = await raw('/settings', { headers: bearer });
    expect(JSON.stringify(body)).not.toContain(token);
  });
});

describe('TC-SYS-003 origin allow-list (FR-SYS-003)', () => {
  it('a foreign Origin is 403 forbidden_origin', async () => {
    const { status, body } = await raw('/projects', {
      headers: { ...bearer, Origin: 'https://evil.example' },
    });
    expect(status).toBe(403);
    const parsed = ApiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe('forbidden_origin');
  });

  it('an allow-listed Origin passes and gets the CORS header back (D-002 regression)', async () => {
    const { status, headers } = await raw('/projects', {
      headers: { ...bearer, Origin: 'http://localhost:5173' },
    });
    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('a CORS preflight is answered without a token (D-002 regression)', async () => {
    const response = await fetch(`${url}/api/v1/projects`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });

  it('a request with no Origin at all is allowed (curl, the CLI)', async () => {
    expect((await raw('/health', { headers: bearer })).status).toBe(200);
  });
});

describe('TC-SYS-004 / TC-SYS-005 health (FR-SYS-004)', () => {
  it('GET /health answers { status: ok, version, db: ok }', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.db).toBe('ok');
    expect(health.version).toMatch(/\S/);
  });
});

describe('TC-SYS-007 every error matches ApiError (FR-SYS-006)', () => {
  it('400 on a bad body', async () => {
    const { projectId } = await freshWorkflow();
    const { status, body } = await raw(`/projects/${projectId}/workflows`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({ name: '' }),
    });
    expect(status).toBe(400);
    const parsed = ApiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe('validation_failed');
  });

  it('401 without a token, 404 for an unknown workflow, 409 for a stale version', async () => {
    expect(ApiErrorSchema.safeParse((await raw('/projects')).body).success).toBe(true);

    const notFound = await expectApiError(client.getWorkflow(newId()));
    expect(notFound.status).toBe(404);
    expect(notFound.code).toBe('not_found');
    expect(ApiErrorSchema.safeParse(notFound.toApiError()).success).toBe(true);

    const { workflow } = await freshWorkflow();
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: inputNode(workflow.id) }],
    });
    const stale = await expectApiError(
      client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [{ op: 'add_node', node: inputNode(workflow.id) }],
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe('stale_version');
    expect(ApiErrorSchema.safeParse(stale.toApiError()).success).toBe(true);
  });
});

describe('FR-SYS-007 no secret reaches the logs', () => {
  it('the session token is in no file under the data directory', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stats = statSync(full);
        if (stats.isDirectory()) {
          walk(full);
          continue;
        }
        // the engine deliberately writes the token to <dataDir>/session-token for the CLI (§2.10)
        if (entry === 'session-token') continue;
        if (/\.(sqlite|sqlite-wal|sqlite-shm|db)$/.test(entry)) continue;
        if (readFileSync(full, 'utf8').includes(token)) offenders.push(full);
      }
    };
    walk(dataDir);
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

describe('FR-PRJ-003 the project folder must be writable', () => {
  it('an unwritable path is 400 invalid_path naming the path', async () => {
    // A path under a file, not a directory: the folder can never be created, on every OS.
    const blocked = join(dataDir, 'session-token', 'cannot-exist');
    const error = await expectApiError(
      client.createProject({ name: 'bad-path', folderPath: blocked }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_path');
    expect(JSON.stringify(error.details)).toContain('cannot-exist');
    expect(error.message).toMatch(/cannot-exist|not writable|invalid/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Workflows and graph operations                                              */
/* -------------------------------------------------------------------------- */

describe('TC-WF-005 stale baseVersion (FR-WF-005)', () => {
  it('the second client gets 409 with details.currentVersion and nothing is applied', async () => {
    const { workflow } = await freshWorkflow();
    const first = await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: inputNode(workflow.id) }],
    });
    expect(first.version).toBe(1);

    const error = await expectApiError(
      client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [{ op: 'add_node', node: outputNode(workflow.id) }],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('stale_version');
    expect(error.details).toEqual({ currentVersion: 1 });

    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(1);
    expect(after.nodes).toHaveLength(1);
  });
});

describe('TC-WF-006 validation (FR-WF-006)', () => {
  it('a lone agent with no goal lists issues with severity, code, message and nodeId (D285)', async () => {
    const { workflow } = await freshWorkflow();
    const agent = agentNode(workflow.id, { name: 'Lonely' });
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: agent }],
    });

    const { issues } = await client.validateWorkflow(workflow.id);
    const codes = issues.map((issue) => issue.code);
    // D285: an Agent with nothing upstream starts from its own goal and the run needs no Output
    // node — so the issue is the missing goal, named on the node.
    expect(codes).not.toContain('unconnected_required_input');
    expect(codes).not.toContain('no_output_node');
    expect(codes).not.toContain('no_input_node');

    const noGoal = issues.find((issue) => issue.code === 'missing_input');
    expect(noGoal?.severity).toBe('error');
    expect(noGoal?.nodeId).toBe(agent.id);
    expect(noGoal?.message).toMatch(/\S/);
    for (const issue of issues) expect(['error', 'warning']).toContain(issue.severity);
  });
});

describe('TC-WF-007 export carries no secrets (FR-WF-007)', () => {
  it('the export validates against WorkflowExport and holds no key-shaped field anywhere', async () => {
    const { workflow } = await freshWorkflow();
    const input = inputNode(workflow.id);
    const agent = agentNode(workflow.id);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: input },
        { op: 'add_node', node: agent },
        {
          op: 'add_edge',
          edge: edgeBetween(workflow.id, input, 'text', agent, 'text'),
        },
      ],
    });

    const file = await client.exportWorkflow(workflow.id);
    expect(WorkflowExportSchema.safeParse(file).success).toBe(true);
    expect(file.formatVersion).toBe(1);
    expect(file.nodes).toHaveLength(2);
    expect(file.edges).toHaveLength(1);

    const forbidden = /^(apikey|api_key|token|secret|password|authorization)$/i;
    const offenders: string[] = [];
    const scan = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => scan(item, `${path}[${index}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (forbidden.test(key)) offenders.push(`${path}.${key}`);
          scan(child, `${path}.${key}`);
        }
      }
    };
    scan(file, 'export');
    expect(offenders).toEqual([]);
    expect(JSON.stringify(file)).not.toContain(token);
  });
});

describe('TC-WF-008 import checks the format version (FR-WF-008)', () => {
  it('formatVersion 99 is a 400 and creates no workflow', async () => {
    const { projectId } = await freshWorkflow();
    const before = (await client.listWorkflows(projectId)).items.length;

    const { status, body } = await raw(`/projects/${projectId}/workflows/import`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({
        formatVersion: 99,
        exportedAt: new Date().toISOString(),
        name: 'from the future',
        nodes: [],
        edges: [],
      }),
    });
    expect(status).toBe(400);
    const parsed = ApiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe('unsupported_format_version');

    expect((await client.listWorkflows(projectId)).items).toHaveLength(before);
  });

  it('a valid export imports into another workflow with fresh ids', async () => {
    const { projectId, workflow } = await freshWorkflow();
    const input = inputNode(workflow.id);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: input }],
    });
    const file = await client.exportWorkflow(workflow.id);

    const imported = await client.importWorkflow(projectId, file);
    expect(imported.workflow.id).not.toBe(workflow.id);
    expect(imported.nodes).toHaveLength(1);
    expect(imported.nodes[0]?.id).not.toBe(input.id);
    expect(imported.nodes[0]?.kind).toBe('input');
  });
});

describe('TC-CON-003 a plain edge may not close a cycle (FR-CON-003)', () => {
  it('the engine refuses it with 400 and the version does not move', async () => {
    const { workflow } = await freshWorkflow();
    const a = agentNode(workflow.id, { name: 'A' });
    const b = agentNode(workflow.id, { name: 'B' });
    const version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [
          { op: 'add_node', node: a },
          { op: 'add_node', node: b },
          {
            op: 'add_edge',
            edge: edgeBetween(workflow.id, a, 'text', b, 'text'),
          },
        ],
      })
    ).version;

    const error = await expectApiError(
      client.applyGraphOps(workflow.id, {
        baseVersion: version,
        ops: [
          {
            op: 'add_edge',
            edge: edgeBetween(workflow.id, b, 'text', a, 'text'),
          },
        ],
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/cycle/i);

    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(version);
    expect(after.edges).toHaveLength(1);
  });
});

describe('TC-CON-005 / TC-CON-006 port arity (FR-CON-005)', () => {
  it('one output feeds three inputs, and a second edge into a single input is refused', async () => {
    const { workflow } = await freshWorkflow();
    const source = inputNode(workflow.id);
    const targets = [agentNode(workflow.id), agentNode(workflow.id), agentNode(workflow.id)];
    const version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [
          { op: 'add_node', node: source },
          ...targets.map((node) => ({ op: 'add_node' as const, node })),
          ...targets.map((node) => ({
            op: 'add_edge' as const,
            edge: edgeBetween(workflow.id, source, 'text', node, 'text'),
          })),
        ],
      })
    ).version;

    const fanned = await client.getWorkflow(workflow.id);
    expect(fanned.edges).toHaveLength(3);

    const second = inputNode(workflow.id, 200);
    const error = await expectApiError(
      client.applyGraphOps(workflow.id, {
        baseVersion: version,
        ops: [
          { op: 'add_node', node: second },
          {
            op: 'add_edge',
            edge: edgeBetween(workflow.id, second, 'text', targets[0] as Node, 'text'),
          },
        ],
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/only one|single/i);

    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(version);
    expect(after.edges).toHaveLength(3);
    expect(after.nodes.some((node) => node.id === second.id)).toBe(false);
  });

  it('an incompatible data type is refused (TC-CON-002 at the API)', async () => {
    const { workflow } = await freshWorkflow();
    const source = inputNode(workflow.id);
    const agent = agentNode(workflow.id);
    const version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [
          { op: 'add_node', node: source },
          { op: 'add_node', node: agent },
          {
            op: 'update_node',
            nodeId: agent.id,
            patch: { config: { inputTypes: ['image'] } },
          },
        ],
      })
    ).version;

    const error = await expectApiError(
      client.applyGraphOps(workflow.id, {
        baseVersion: version,
        ops: [
          {
            op: 'add_edge',
            edge: edgeBetween(workflow.id, source, 'text', agent, 'image'),
          },
        ],
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/image|type/i);
  });
});

describe('TC-NODE-006 execution settings are range-checked server-side (FR-NODE-007)', () => {
  it('temperature 5 is a 400 and nothing is saved', async () => {
    const { workflow } = await freshWorkflow();
    const agent = agentNode(workflow.id);
    const version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [{ op: 'add_node', node: agent }],
      })
    ).version;

    const { status, body } = await raw(`/workflows/${workflow.id}/graph-ops`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({
        baseVersion: version,
        ops: [
          {
            op: 'update_node',
            nodeId: agent.id,
            patch: {
              config: {
                execution: { ...defaultExecutionSettings(), temperature: 5 },
              },
            },
          },
        ],
      }),
    });
    expect(status).toBe(400);
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);

    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(version);
    const saved = after.nodes.find((node) => node.id === agent.id);
    expect(saved?.kind === 'agent' && saved.config.execution.temperature).toBe(0.7);
  });

  it('D-001 regression: a patch that touches one field leaves its siblings alone', async () => {
    const { workflow } = await freshWorkflow();
    const agent = agentNode(workflow.id);
    let version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [{ op: 'add_node', node: agent }],
      })
    ).version;

    version = (
      await client.applyGraphOps(workflow.id, {
        baseVersion: version,
        ops: [
          {
            op: 'update_node',
            nodeId: agent.id,
            patch: {
              config: {
                execution: { ...defaultExecutionSettings(), temperature: 0.3 },
                instructions: 'keep me',
              },
            },
          },
        ],
      })
    ).version;

    await client.applyGraphOps(workflow.id, {
      baseVersion: version,
      ops: [
        {
          op: 'update_node',
          nodeId: agent.id,
          patch: { config: { contextPolicy: { budgetTokens: 8000 } } },
        },
      ],
    });

    const saved = (await client.getWorkflow(workflow.id)).nodes.find(
      (node) => node.id === agent.id,
    );
    expect(saved?.kind === 'agent' && saved.config.execution.temperature).toBe(0.3);
    expect(saved?.kind === 'agent' && saved.config.instructions).toBe('keep me');
    expect(saved?.kind === 'agent' && saved.config.contextPolicy.budgetTokens).toBe(8000);
  });
});

describe('TC-NFR-006 a batch is one transaction (NFR-REL-02)', () => {
  it('20 ops where op 15 is invalid apply none of them and leave the version alone', async () => {
    const { workflow } = await freshWorkflow();
    const nodes = Array.from({ length: 19 }, (_, i) => inputNode(workflow.id, i * 50));
    const ops = nodes.map((node) => ({ op: 'add_node' as const, node }));
    // op 15 (index 14) is the invalid one: a move of a node that does not exist
    ops.splice(14, 0, {
      op: 'move_node',
      nodeId: newId(),
      position: { x: 1, y: 1 },
    } as never);
    expect(ops).toHaveLength(20);

    const error = await expectApiError(client.applyGraphOps(workflow.id, { baseVersion: 0, ops }));
    expect(error.status).toBe(400);

    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(0);
    expect(after.nodes).toHaveLength(0);
    expect(after.edges).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Event log and resume                                                        */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-014 the event log replays on resume (Arch §21.4, §2.9)', () => {
  /** One socket, driven at the protocol level: this is the engine under test, not the SDK. */
  function open(): Promise<WebSocket & { frames: Array<Record<string, unknown>> }> {
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`) as WebSocket & {
      frames: Array<Record<string, unknown>>;
    };
    socket.frames = [];
    socket.on('message', (data: Buffer) => {
      socket.frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('a wrong token closes the socket with 4401 (FR-SYS-002)', async () => {
    const socket = new WebSocket(`${wsUrl}?token=nope`);
    const code = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(code).toBe(4401);
  });

  it('subscribe, disconnect, make 10 edits, reconnect and resume → exactly 10 workflow.updated frames in order', async () => {
    const { workflow } = await freshWorkflow('resume');

    const first = await open();
    first.send(
      JSON.stringify({
        type: 'subscribe',
        payload: { scope: 'workflow', id: workflow.id },
      }),
    );
    await settle();
    const hello = first.frames.find((frame) => frame['type'] === 'hello');
    expect(hello).toBeDefined();
    const afterSeq = (hello?.['payload'] as { seq: number }).seq;

    first.close();
    await new Promise((resolve) => first.once('close', resolve));

    for (let i = 0; i < 10; i += 1) {
      await client.applyGraphOps(workflow.id, {
        baseVersion: i,
        ops: [{ op: 'add_node', node: inputNode(workflow.id, i * 40) }],
      });
    }
    // nothing arrived while the socket was down
    expect(first.frames.filter((frame) => frame['type'] === 'workflow.updated')).toHaveLength(0);

    const second = await open();
    second.send(
      JSON.stringify({
        type: 'subscribe',
        payload: { scope: 'workflow', id: workflow.id },
      }),
    );
    second.send(JSON.stringify({ type: 'resume', payload: { afterSeq } }));
    await vi.waitFor(
      () => {
        const updates = second.frames.filter(
          (frame) =>
            frame['type'] === 'workflow.updated' &&
            (frame['payload'] as { workflowId: string }).workflowId === workflow.id,
        );
        expect(updates.length).toBeGreaterThanOrEqual(10);
      },
      { timeout: 10_000, interval: 100 },
    );
    await settle();

    const updates = second.frames.filter(
      (frame) =>
        frame['type'] === 'workflow.updated' &&
        (frame['payload'] as { workflowId: string }).workflowId === workflow.id,
    );
    second.close();

    expect(updates).toHaveLength(10);
    expect(updates.map((frame) => (frame['payload'] as { version: number }).version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const seqs = updates.map((frame) => frame['seq'] as number);
    expect(seqs.every((seq) => seq > afterSeq)).toBe(true);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
