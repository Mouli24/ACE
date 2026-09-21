import { derivePorts, portId, type Node } from '@ace/contracts';
import { AceApiError, createAceClient } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createHandlers } from './handlers';

const db = new MockDb({ persist: false });
const server = setupServer(...createHandlers(db));
// fetch is resolved per call: msw/node swaps the global when the server starts listening.
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => db.reset());

function node(kind: 'input' | 'agent' | 'output', workflowId: string, x = 0): Node {
  const id = newId();
  const config =
    kind === 'input'
      ? { artifactIds: [], outputTypes: ['text' as const] }
      : kind === 'output'
        ? {}
        : {
            routing: { policy: 'fixed' as const, fallbackModelIds: [] },
            instructions: '',
            inputTypes: ['text' as const],
            outputTypes: ['text' as const],
            execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
            contextPolicy: { budgetTokens: 4000 },
            tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
            knowledgeBaseIds: [],
            memory: { enabled: false },
            skillIds: [],
          };
  const base = { id, kind, config } as Pick<Node, 'id' | 'kind' | 'config'>;
  return {
    ...base,
    workflowId,
    name: kind,
    position: { x, y: 0 },
    ...derivePorts(base),
  } as Node;
}

async function projectAndWorkflow() {
  const project = await client.createProject({ name: 'Demo' });
  const workflow = await client.createWorkflow(project.id, { name: 'Flow 1' });
  return { project, workflow };
}

describe('mock engine — system', () => {
  it('GET /health', async () => {
    expect(await client.health()).toEqual({ status: 'ok', version: 'mock', db: 'ok' });
  });

  it('GET/PATCH /settings', async () => {
    const before = await client.getSettings();
    expect(before.theme).toBe('dark');
    const after = await client.patchSettings({ theme: 'light' });
    expect(after.theme).toBe('light');
  });
});

describe('mock engine — projects (FR-PRJ-001..004)', () => {
  it('creates, lists, renames and deletes a project', async () => {
    const p = await client.createProject({ name: 'Demo' });
    expect(p.folderPath).toContain('Demo');
    expect((await client.listProjects()).items.map((x) => x.id)).toEqual([p.id]);
    expect((await client.updateProject(p.id, { name: 'Demo 2' })).name).toBe('Demo 2');
    await client.deleteProject(p.id);
    expect((await client.listProjects()).items).toEqual([]);
    await expect(client.getProject(p.id)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('TC-PRJ-002: an unwritable folder is a 400 invalid_path naming the path', async () => {
    const err = (await client
      .createProject({ name: 'X', folderPath: '/readonly/x' })
      .catch((e: unknown) => e)) as AceApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_path');
    expect(err.details).toEqual({ path: '/readonly/x' });
  });

  it('open sets lastOpenedAt and settings.lastProjectId (FR-PRJ-004)', async () => {
    const p = await client.createProject({ name: 'B' });
    const opened = await client.openProject(p.id);
    expect(opened.lastOpenedAt).toBeDefined();
    expect((await client.getSettings()).lastProjectId).toBe(p.id);
  });

  it('paginates with cursor and limit', async () => {
    for (let i = 0; i < 3; i += 1) await client.createProject({ name: `P${i}` });
    const first = await client.listProjects({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await client.listProjects({ cursor: first.nextCursor, limit: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe('mock engine — workflows (FR-WF-001..008)', () => {
  it('creates, gets (with nodes and edges), renames, deletes', async () => {
    const { project, workflow } = await projectAndWorkflow();
    expect(workflow.version).toBe(0);
    const graph = await client.getWorkflow(workflow.id);
    expect(graph).toEqual({ workflow, nodes: [], edges: [] });
    expect((await client.updateWorkflow(workflow.id, { name: 'Renamed' })).name).toBe('Renamed');
    expect((await client.listWorkflows(project.id)).items).toHaveLength(1);
    await client.deleteWorkflow(workflow.id);
    expect((await client.listWorkflows(project.id)).items).toHaveLength(0);
  });

  it('graph-ops applies a batch, bumps the version and records a workflow.updated event', async () => {
    const { workflow } = await projectAndWorkflow();
    const a = node('input', workflow.id);
    const b = node('agent', workflow.id, 200);
    const res = await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: a },
        { op: 'add_node', node: b },
        {
          op: 'add_edge',
          edge: {
            id: newId(),
            workflowId: workflow.id,
            kind: 'data',
            from: { nodeId: a.id, portId: portId(a.id, 'out', 'text') },
            to: { nodeId: b.id, portId: portId(b.id, 'in', 'text') },
          },
        },
      ],
    });
    expect(res.version).toBe(1);
    expect(res.nodes).toHaveLength(2);
    expect(res.edges).toHaveLength(1);
    expect(db.events.at(-1)).toMatchObject({
      type: 'workflow.updated',
      payload: { workflowId: workflow.id, version: 1 },
    });
    expect(db.events.at(-1)?.seq).toBeGreaterThan(0);
  });

  it('TC-WF-005: a stale baseVersion is a 409 with currentVersion and applies nothing', async () => {
    const { workflow } = await projectAndWorkflow();
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: node('input', workflow.id) }],
    });
    const err = (await client
      .applyGraphOps(workflow.id, {
        baseVersion: 0,
        ops: [{ op: 'add_node', node: node('output', workflow.id) }],
      })
      .catch((e: unknown) => e)) as AceApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('stale_version');
    expect(err.details).toEqual({ currentVersion: 1 });
    expect((await client.getWorkflow(workflow.id)).nodes).toHaveLength(1);
  });

  it('TC-NODE-006 / TC-NFR-006: one invalid op makes the whole batch a 400 and nothing is applied', async () => {
    const { workflow } = await projectAndWorkflow();
    const agent = node('agent', workflow.id);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: agent }],
    });
    const err = (await client
      .applyGraphOps(workflow.id, {
        baseVersion: 1,
        ops: [
          { op: 'add_node', node: node('input', workflow.id) },
          {
            op: 'update_node',
            nodeId: agent.id,
            patch: {
              config: { execution: { temperature: 5, maxTokens: 1, timeoutMs: 1000, retries: 0 } },
            },
          },
        ],
      })
      .catch((e: unknown) => e)) as AceApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    const after = await client.getWorkflow(workflow.id);
    expect(after.workflow.version).toBe(1);
    expect(after.nodes).toHaveLength(1);
  });

  it('TC-CON-003: a plain edge that closes a cycle is a 400 whose message says so', async () => {
    const { workflow } = await projectAndWorkflow();
    const a = node('agent', workflow.id);
    const b = node('agent', workflow.id, 200);
    const edge = (from: Node, to: Node) => ({
      id: newId(),
      workflowId: workflow.id,
      kind: 'data' as const,
      from: { nodeId: from.id, portId: portId(from.id, 'out', 'text') },
      to: { nodeId: to.id, portId: portId(to.id, 'in', 'text') },
    });
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: a },
        { op: 'add_node', node: b },
        { op: 'add_edge', edge: edge(a, b) },
      ],
    });
    const err = (await client
      .applyGraphOps(workflow.id, { baseVersion: 1, ops: [{ op: 'add_edge', edge: edge(b, a) }] })
      .catch((e: unknown) => e)) as AceApiError;
    expect(err.status).toBe(400);
    expect(err.message.toLowerCase()).toContain('cycle');
    expect((await client.getWorkflow(workflow.id)).edges).toHaveLength(1);
  });

  it('TC-CON-002 / TC-CON-006: incompatible types and a second edge into a single input are 400s', async () => {
    const { workflow } = await projectAndWorkflow();
    const inp = node('input', workflow.id);
    const agent = node('agent', workflow.id, 200);
    const other = node('input', workflow.id, -200);
    const mk = (from: Node, fromPort: string, to: Node, toPort: string) => ({
      id: newId(),
      workflowId: workflow.id,
      kind: 'data' as const,
      from: { nodeId: from.id, portId: portId(from.id, 'out', fromPort) },
      to: { nodeId: to.id, portId: portId(to.id, 'in', toPort) },
    });
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: inp },
        { op: 'add_node', node: agent },
        { op: 'add_node', node: other },
        {
          op: 'update_node',
          nodeId: agent.id,
          patch: { config: { inputTypes: ['text', 'image'] } },
        },
        { op: 'add_edge', edge: mk(inp, 'text', agent, 'text') },
      ],
    });
    const mismatch = (await client
      .applyGraphOps(workflow.id, {
        baseVersion: 1,
        ops: [{ op: 'add_edge', edge: mk(other, 'text', agent, 'image') }],
      })
      .catch((e: unknown) => e)) as AceApiError;
    expect(mismatch.status).toBe(400);
    expect(mismatch.message).toContain('image');
    const occupied = (await client
      .applyGraphOps(workflow.id, {
        baseVersion: 1,
        ops: [{ op: 'add_edge', edge: mk(other, 'text', agent, 'text') }],
      })
      .catch((e: unknown) => e)) as AceApiError;
    expect(occupied.status).toBe(400);
    expect(occupied.message).toContain('only one');
  });

  it('delete_node also removes its edges; update_node re-derives ports (TC-CAN-004, TC-NODE-005)', async () => {
    const { workflow } = await projectAndWorkflow();
    const a = node('input', workflow.id);
    const b = node('agent', workflow.id, 200);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: a },
        { op: 'add_node', node: b },
        {
          op: 'add_edge',
          edge: {
            id: newId(),
            workflowId: workflow.id,
            kind: 'data',
            from: { nodeId: a.id, portId: portId(a.id, 'out', 'text') },
            to: { nodeId: b.id, portId: portId(b.id, 'in', 'text') },
          },
        },
      ],
    });
    const rederived = await client.applyGraphOps(workflow.id, {
      baseVersion: 1,
      ops: [
        { op: 'update_node', nodeId: b.id, patch: { config: { outputTypes: ['text', 'image'] } } },
      ],
    });
    expect(rederived.nodes.find((n) => n.id === b.id)?.outputs.map((p) => p.name)).toEqual([
      'text',
      'image',
    ]);
    const deleted = await client.applyGraphOps(workflow.id, {
      baseVersion: 2,
      ops: [{ op: 'delete_node', nodeId: a.id }],
    });
    expect(deleted.nodes).toHaveLength(1);
    expect(deleted.edges).toHaveLength(0);
  });

  it('duplicate copies the structure with fresh ids (TC-WF-003)', async () => {
    const { workflow } = await projectAndWorkflow();
    const a = node('input', workflow.id);
    const b = node('agent', workflow.id, 200);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [
        { op: 'add_node', node: a },
        { op: 'add_node', node: b },
        {
          op: 'add_edge',
          edge: {
            id: newId(),
            workflowId: workflow.id,
            kind: 'data',
            from: { nodeId: a.id, portId: portId(a.id, 'out', 'text') },
            to: { nodeId: b.id, portId: portId(b.id, 'in', 'text') },
          },
        },
      ],
    });
    const copy = await client.duplicateWorkflow(workflow.id);
    expect(copy.workflow.id).not.toBe(workflow.id);
    expect(copy.workflow.name).toBe('Flow 1 (copy)');
    expect(copy.nodes).toHaveLength(2);
    expect(copy.edges).toHaveLength(1);
    expect(copy.nodes.map((n) => n.id)).not.toContain(a.id);
    expect(copy.edges[0]?.from.nodeId).toBe(copy.nodes[0]?.id);
    expect(copy.edges[0]?.from.portId.startsWith(copy.nodes[0]?.id ?? '!')).toBe(true);
  });

  it('validate lists issues with severity, code, message and node reference (TC-WF-006)', async () => {
    const { workflow } = await projectAndWorkflow();
    const agent = node('agent', workflow.id);
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: agent }],
    });
    const { issues } = await client.validateWorkflow(workflow.id);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('unconnected_required_input');
    expect(codes).toContain('no_input_node');
    expect(codes).toContain('no_output_node');
    expect(issues.find((i) => i.code === 'unconnected_required_input')).toMatchObject({
      severity: 'error',
      nodeId: agent.id,
    });
    expect(issues.find((i) => i.code === 'missing_model')?.severity).toBe('warning');
  });

  it('export then import reproduces the graph; a bad formatVersion is refused (TC-WF-007/008)', async () => {
    const { project, workflow } = await projectAndWorkflow();
    await client.applyGraphOps(workflow.id, {
      baseVersion: 0,
      ops: [{ op: 'add_node', node: node('input', workflow.id) }],
    });
    const file = await client.exportWorkflow(workflow.id);
    expect(file.formatVersion).toBe(1);
    expect(JSON.stringify(file)).not.toMatch(/apiKey|secret|token/i);
    const imported = await client.importWorkflow(project.id, file);
    expect(imported.nodes).toHaveLength(1);
    expect(imported.workflow.id).not.toBe(workflow.id);

    const bad = (await client
      .importWorkflow(project.id, { ...file, formatVersion: 99 as unknown as 1 })
      .catch((e: unknown) => e)) as AceApiError;
    expect(bad.code).toBe('validation_failed');
    expect((await client.listWorkflows(project.id)).items).toHaveLength(2);
  });

  it('unknown workflow is a 404 not_found', async () => {
    await expect(client.getWorkflow(newId())).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('MockDb persistence', () => {
  it('round-trips through localStorage so two tabs share one engine', () => {
    localStorage.clear();
    const a = new MockDb({ persist: true, storageKey: 'ace.mock.test' });
    a.createProject({ name: 'Shared' });
    const b = new MockDb({ persist: true, storageKey: 'ace.mock.test' });
    expect(b.listProjects().map((p) => p.name)).toEqual(['Shared']);
    localStorage.clear();
  });
});

describe('mock engine — raw HTTP edges the SDK never sends', () => {
  it('a missing token is a 401 in the FR-SYS-006 shape', async () => {
    const res = await fetch('http://mock.local/api/v1/projects');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized', kind: 'auth' } });
  });

  it('import with formatVersion 99 is a 400 unsupported_format_version and creates nothing (TC-WF-008)', async () => {
    const project = await client.createProject({ name: 'Imp' });
    const res = await fetch(`http://mock.local/api/v1/projects/${project.id}/workflows/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
      body: JSON.stringify({ formatVersion: 99, exportedAt: 'x', name: 'n', nodes: [], edges: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'unsupported_format_version' } });
    expect((await client.listWorkflows(project.id)).items).toHaveLength(0);
  });
});
