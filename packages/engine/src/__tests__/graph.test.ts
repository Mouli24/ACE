import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApiErrorSchema,
  ProjectSchema,
  WorkflowExportSchema,
  WorkflowGraphResponseSchema,
  WorkflowSchema,
  type GraphOpsResponse,
  type ValidationIssue,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGraphService } from '../graph/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';
import {
  addEdge,
  addNode,
  agentNode,
  createHarness,
  createProject,
  createWorkflow,
  del,
  edgeBetween,
  get,
  graphOps,
  inputNode,
  mergeNode,
  outputNode,
  patch,
  post,
  type Harness,
} from './graph-helpers.js';

let h: Harness;
let dir: string;

beforeEach(() => {
  h = createHarness();
  dir = mkdtempSync(join(tmpdir(), 'ace-graph-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const projectFolder = () => join(dir, `project-${newId()}`);

async function seed() {
  const project = await createProject(h.app, projectFolder());
  const workflow = await createWorkflow(h.app, project.id);
  return { project, workflow };
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

describe('TC-PRJ-001 Create project', () => {
  it('creates the folder when it is missing and lists the project', async () => {
    const folder = projectFolder();
    const project = ProjectSchema.parse(await body(await post(h.app, '/api/v1/projects', { name: 'Demo', folderPath: folder })));

    expect(project.name).toBe('Demo');
    expect(project.folderPath).toBe(folder);

    const listed = await body<{ items: unknown[] }>(await get(h.app, '/api/v1/projects'));
    expect(listed.items).toHaveLength(1);
  });

  it('accepts a folder that already exists', async () => {
    const folder = projectFolder();
    const first = await post(h.app, '/api/v1/projects', { name: 'A', folderPath: folder });
    const second = await post(h.app, '/api/v1/projects', { name: 'B', folderPath: folder });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('refuses a project with no name', async () => {
    const response = await post(h.app, '/api/v1/projects', { name: '' });

    expect(response.status).toBe(400);
  });

  it('[audit E-8] a project without a folder lands under projectsRoot, never the working directory', async () => {
    const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
    const root = join(dir, 'projects');
    const graph = createGraphService({
      repository: new FakeRepository(),
      scope: LOCAL_SCOPE,
      logger,
      projectsRoot: root,
    });

    const project = await graph.createProject({ name: 'No folder' });

    expect(project.folderPath).toBe(join(root, project.id));
    expect(statSync(project.folderPath).isDirectory()).toBe(true);
    expect(project.folderPath.startsWith(process.cwd())).toBe(false);

    // A harness that passes no root still never writes under the working directory.
    const bare = createGraphService({
      repository: new FakeRepository(),
      scope: LOCAL_SCOPE,
      logger,
    });
    const fallback = await bare.createProject({ name: 'Bare' });
    try {
      expect(fallback.folderPath).toBe(join(tmpdir(), 'ace-projects', fallback.id));
    } finally {
      rmSync(fallback.folderPath, { recursive: true, force: true });
    }
  });
});

describe('TC-PRJ-002 Unwritable folder', () => {
  it('refuses a path that is a file, naming the path', async () => {
    const file = join(dir, 'not-a-folder.txt');
    writeFileSync(file, 'i am a file');

    const response = await post(h.app, '/api/v1/projects', { name: 'Demo', folderPath: file });

    expect(response.status).toBe(400);
    const error = ApiErrorSchema.parse(await response.json());
    expect(error.error.code).toBe('invalid_path');
    expect(error.error.message).toContain(file);
    expect(error.error.details).toMatchObject({ path: file });
  });
});

describe('TC-PRJ-003 Delete project', () => {
  it('removes it from the list', async () => {
    const project = await createProject(h.app, projectFolder());

    expect((await del(h.app, `/api/v1/projects/${project.id}`)).status).toBe(204);

    const listed = await body<{ items: unknown[] }>(await get(h.app, '/api/v1/projects'));
    expect(listed.items).toEqual([]);
    expect((await get(h.app, `/api/v1/projects/${project.id}`)).status).toBe(404);
  });

  it('answers 404 when deleting something that is not there', async () => {
    expect((await del(h.app, `/api/v1/projects/${newId()}`)).status).toBe(404);
  });

  it('renames a project', async () => {
    const project = await createProject(h.app, projectFolder());
    const renamed = ProjectSchema.parse(
      await body(await patch(h.app, `/api/v1/projects/${project.id}`, { name: 'Renamed' })),
    );

    expect(renamed.name).toBe('Renamed');
  });

  it('D301 stores the terminal trust level a PATCH sets, and refuses one it does not know', async () => {
    const project = await createProject(h.app, projectFolder());

    const scripts = ProjectSchema.parse(
      await body(await patch(h.app, `/api/v1/projects/${project.id}`, { terminal: 'scripts' })),
    );
    expect(scripts.terminal).toBe('scripts');
    const read = ProjectSchema.parse(await body(await get(h.app, `/api/v1/projects/${project.id}`)));
    expect(read.terminal).toBe('scripts');

    const refused = await patch(h.app, `/api/v1/projects/${project.id}`, { terminal: 'sometimes' });
    expect(refused.status).toBe(400);
    expect(ApiErrorSchema.parse(await body(refused)).error.code).toBe('validation_failed');
  });

  it('D299 Phase 4 stores the check command and format-on-save a PATCH sets; null removes the command', async () => {
    const project = await createProject(h.app, projectFolder());
    const url = `/api/v1/projects/${project.id}`;

    const set = ProjectSchema.parse(
      await body(
        await patch(h.app, url, { checkCommand: 'pnpm tsc --noEmit', formatOnSave: true }),
      ),
    );
    expect(set).toMatchObject({ checkCommand: 'pnpm tsc --noEmit', formatOnSave: true });
    expect(ProjectSchema.parse(await body(await get(h.app, url)))).toMatchObject({
      checkCommand: 'pnpm tsc --noEmit',
      formatOnSave: true,
    });

    // Each field alone is enough for the PATCH to reach the store.
    const off = ProjectSchema.parse(await body(await patch(h.app, url, { formatOnSave: false })));
    expect(off).toMatchObject({ checkCommand: 'pnpm tsc --noEmit', formatOnSave: false });
    const cleared = ProjectSchema.parse(
      await body(await patch(h.app, url, { checkCommand: null })),
    );
    expect(cleared.checkCommand).toBeUndefined();
    expect(cleared.formatOnSave).toBe(false);

    const refused = await patch(h.app, url, { checkCommand: '' });
    expect(refused.status).toBe(400);
    expect(ApiErrorSchema.parse(await body(refused)).error.code).toBe('validation_failed');
  });
});

describe('TC-PRJ-004 Reopen last project', () => {
  it('records lastOpenedAt and remembers the project as the last one used', async () => {
    const a = await createProject(h.app, projectFolder());
    const b = await createProject(h.app, projectFolder());

    await post(h.app, `/api/v1/projects/${a.id}/open`);
    const opened = ProjectSchema.parse(await body(await post(h.app, `/api/v1/projects/${b.id}/open`)));

    expect(opened.lastOpenedAt).toBeDefined();

    const settings = await body<{ lastProjectId?: string }>(await get(h.app, '/api/v1/settings'));
    expect(settings.lastProjectId).toBe(b.id);
  });
});

/* -------------------------------------------------------------------------- */
/* Workflows                                                                   */
/* -------------------------------------------------------------------------- */

describe('TC-WF-001 Create workflow', () => {
  it('creates an empty workflow at version 0', async () => {
    const { workflow } = await seed();

    expect(workflow.version).toBe(0);
    expect(workflow.formatVersion).toBe(1);

    const graph = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('lists workflows inside their project', async () => {
    const { project } = await seed();
    const listed = await body<{ items: unknown[] }>(
      await get(h.app, `/api/v1/projects/${project.id}/workflows`),
    );

    expect(listed.items).toHaveLength(1);
  });
});

describe('TC-WF-003 Duplicate workflow', () => {
  it('copies the structure with fresh ids and remapped ports', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const output = outputNode(workflow.id);

    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(output),
      addEdge(edgeBetween(workflow.id, input.id, 'text', output.id, 'text')),
    ]);

    const copy = WorkflowGraphResponseSchema.parse(
      await body(await post(h.app, `/api/v1/workflows/${workflow.id}/duplicate`)),
    );

    expect(copy.workflow.id).not.toBe(workflow.id);
    expect(copy.nodes).toHaveLength(2);
    expect(copy.edges).toHaveLength(1);
    expect(copy.nodes.map((n) => n.id)).not.toContain(input.id);

    // Every edge endpoint must point at a node of the copy, through that node's own port id.
    const ids = new Set(copy.nodes.map((n) => n.id));
    for (const edge of copy.edges) {
      expect(ids.has(edge.from.nodeId)).toBe(true);
      expect(ids.has(edge.to.nodeId)).toBe(true);
      expect(edge.from.portId.startsWith(`${edge.from.nodeId}:out:`)).toBe(true);
      expect(edge.to.portId.startsWith(`${edge.to.nodeId}:in:`)).toBe(true);
    }
  });

  it('leaves the original untouched', async () => {
    const { workflow } = await seed();
    await graphOps(h.app, workflow.id, 0, [addNode(inputNode(workflow.id))]);

    await post(h.app, `/api/v1/workflows/${workflow.id}/duplicate`);

    const original = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(original.nodes).toHaveLength(1);
  });

  it('renames and deletes a workflow', async () => {
    const { workflow } = await seed();

    const renamed = WorkflowSchema.parse(
      await body(await patch(h.app, `/api/v1/workflows/${workflow.id}`, { name: 'Renamed' })),
    );
    expect(renamed.name).toBe('Renamed');
    expect(renamed.version).toBe(0);

    expect((await del(h.app, `/api/v1/workflows/${workflow.id}`)).status).toBe(204);
    expect((await get(h.app, `/api/v1/workflows/${workflow.id}`)).status).toBe(404);
  });
});

describe('TC-WF-004 Autosave', () => {
  it('keeps a node after it is added, and moves the version on by one', async () => {
    const { workflow } = await seed();
    const node = inputNode(workflow.id);

    const response = await graphOps(h.app, workflow.id, 0, [addNode(node)]);
    const result = await body<GraphOpsResponse>(response);

    expect(response.status).toBe(200);
    expect(result.version).toBe(1);
    expect(result.nodes).toHaveLength(1);

    const reloaded = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(reloaded.nodes[0]?.id).toBe(node.id);
    expect(reloaded.workflow.version).toBe(1);
  });

  it('derives the ports server-side, whatever the client sent', async () => {
    const { workflow } = await seed();
    const node = inputNode(workflow.id, ['text', 'image']);

    const result = await body<GraphOpsResponse>(
      await graphOps(h.app, workflow.id, 0, [addNode(node)]),
    );

    expect(result.nodes[0]?.outputs.map((p) => p.name)).toEqual(['text', 'image']);
    expect(result.nodes[0]?.outputs[0]?.id).toBe(`${node.id}:out:text`);
  });

  it('re-derives the ports after update_node changes the types', async () => {
    const { workflow } = await seed();
    const node = inputNode(workflow.id, ['text']);
    await graphOps(h.app, workflow.id, 0, [addNode(node)]);

    const result = await body<GraphOpsResponse>(
      await graphOps(h.app, workflow.id, 1, [
        { op: 'update_node', nodeId: node.id, patch: { config: { outputTypes: ['text', 'image'] } } },
      ]),
    );

    expect(result.nodes[0]?.outputs.map((p) => p.name)).toEqual(['text', 'image']);
  });

  it('moves a node', async () => {
    const { workflow } = await seed();
    const node = inputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [addNode(node)]);

    const result = await body<GraphOpsResponse>(
      await graphOps(h.app, workflow.id, 1, [
        { op: 'move_node', nodeId: node.id, position: { x: 250, y: 75 } },
      ]),
    );

    expect(result.nodes[0]?.position).toEqual({ x: 250, y: 75 });
  });

  it('takes a node edges with it when the node is deleted', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const output = outputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(output),
      addEdge(edgeBetween(workflow.id, input.id, 'text', output.id, 'text')),
    ]);

    const result = await body<GraphOpsResponse>(
      await graphOps(h.app, workflow.id, 1, [{ op: 'delete_node', nodeId: output.id }]),
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });
});

describe('TC-WF-005 Stale edit', () => {
  it('refuses a second client writing against the version the first already used', async () => {
    const { workflow } = await seed();

    const first = await graphOps(h.app, workflow.id, 0, [addNode(inputNode(workflow.id))]);
    expect(first.status).toBe(200);

    const second = await graphOps(h.app, workflow.id, 0, [addNode(outputNode(workflow.id))]);

    expect(second.status).toBe(409);
    const error = ApiErrorSchema.parse(await second.json());
    expect(error.error.code).toBe('stale_version');
    expect(error.error.details).toMatchObject({ currentVersion: 1 });
  });

  it('leaves the graph untouched when a batch is refused as stale', async () => {
    const { workflow } = await seed();
    await graphOps(h.app, workflow.id, 0, [addNode(inputNode(workflow.id))]);

    await graphOps(h.app, workflow.id, 0, [addNode(outputNode(workflow.id))]);

    const graph = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.workflow.version).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Connections, through graph-ops                                              */
/* -------------------------------------------------------------------------- */

describe('TC-CON-002 Type mismatch', () => {
  it('refuses a text output into an image-only input, with a reason', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id, ['text']);
    const agent = agentNode(workflow.id, ['image'], ['text']);
    await graphOps(h.app, workflow.id, 0, [addNode(input), addNode(agent)]);

    const response = await graphOps(h.app, workflow.id, 1, [
      addEdge(edgeBetween(workflow.id, input.id, 'text', agent.id, 'image')),
    ]);

    expect(response.status).toBe(400);
    const error = ApiErrorSchema.parse(await response.json());
    expect(error.error.code).toBe('validation_failed');
    expect(JSON.stringify(error.error.details)).toContain('incompatible_types');
  });

  it('allows code into a text port, the one cross-type pair §2.5 permits', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id, ['code']);
    const agent = agentNode(workflow.id, ['text'], ['text']);
    await graphOps(h.app, workflow.id, 0, [addNode(input), addNode(agent)]);

    const response = await graphOps(h.app, workflow.id, 1, [
      addEdge(edgeBetween(workflow.id, input.id, 'code', agent.id, 'text')),
    ]);

    expect(response.status).toBe(200);
  });
});

describe('TC-CON-003 Plain cycle', () => {
  it('refuses an edge that closes a cycle', async () => {
    const { workflow } = await seed();
    const a = agentNode(workflow.id, ['text'], ['text']);
    const b = agentNode(workflow.id, ['text'], ['text']);
    await graphOps(h.app, workflow.id, 0, [
      addNode(a),
      addNode(b),
      addEdge(edgeBetween(workflow.id, a.id, 'text', b.id, 'text')),
    ]);

    const response = await graphOps(h.app, workflow.id, 1, [
      addEdge(edgeBetween(workflow.id, b.id, 'text', a.id, 'text')),
    ]);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('cycle');
  });

  it('refuses a node connected to itself', async () => {
    const { workflow } = await seed();
    const a = agentNode(workflow.id, ['text'], ['text']);
    await graphOps(h.app, workflow.id, 0, [addNode(a)]);

    const response = await graphOps(h.app, workflow.id, 1, [
      addEdge(edgeBetween(workflow.id, a.id, 'text', a.id, 'text')),
    ]);

    expect(response.status).toBe(400);
  });

  it('allows a diamond, which is not a cycle', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const left = agentNode(workflow.id, ['text'], ['text']);
    const right = agentNode(workflow.id, ['text'], ['text']);
    const merge = mergeNode(workflow.id);

    const response = await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(left),
      addNode(right),
      addNode(merge),
      addEdge(edgeBetween(workflow.id, input.id, 'text', left.id, 'text')),
      addEdge(edgeBetween(workflow.id, input.id, 'text', right.id, 'text')),
      addEdge(edgeBetween(workflow.id, left.id, 'text', merge.id, 'in')),
      addEdge(edgeBetween(workflow.id, right.id, 'text', merge.id, 'in')),
    ]);

    expect(response.status).toBe(200);
  });

  it('refuses a loop edge that carries no loop config (round 3, FR-CON-007)', async () => {
    const { workflow } = await seed();
    const a = agentNode(workflow.id, ['text'], ['text']);
    const b = agentNode(workflow.id, ['text'], ['text']);
    await graphOps(h.app, workflow.id, 0, [addNode(a), addNode(b)]);

    const loop = { ...edgeBetween(workflow.id, a.id, 'text', b.id, 'text'), kind: 'loop' as const };
    const response = await graphOps(h.app, workflow.id, 1, [addEdge(loop)]);

    // Loop edges are accepted from round 3; what is refused is one with no maximum, exit condition
    // or on-max behaviour. The accepting cases live in `loop-edges.test.ts` (TC-CON-007).
    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('validation_failed');
  });
});

describe('TC-CON-005 Fan-out', () => {
  it('connects one output to three inputs', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const targets = [
      agentNode(workflow.id, ['text'], ['text']),
      agentNode(workflow.id, ['text'], ['text']),
      agentNode(workflow.id, ['text'], ['text']),
    ];

    const response = await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      ...targets.map(addNode),
      ...targets.map((t) => addEdge(edgeBetween(workflow.id, input.id, 'text', t.id, 'text'))),
    ]);

    expect(response.status).toBe(200);
    expect((await body<GraphOpsResponse>(response)).edges).toHaveLength(3);
  });
});

describe('TC-CON-006 Single-input port', () => {
  it('refuses a second edge into a single-edge input', async () => {
    const { workflow } = await seed();
    const a = inputNode(workflow.id);
    const b = inputNode(workflow.id);
    const agent = agentNode(workflow.id, ['text'], ['text']);
    await graphOps(h.app, workflow.id, 0, [
      addNode(a),
      addNode(b),
      addNode(agent),
      addEdge(edgeBetween(workflow.id, a.id, 'text', agent.id, 'text')),
    ]);

    const response = await graphOps(h.app, workflow.id, 1, [
      addEdge(edgeBetween(workflow.id, b.id, 'text', agent.id, 'text')),
    ]);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('single_input_occupied');
  });

  it('accepts many edges into a merge port, which is multi', async () => {
    const { workflow } = await seed();
    const a = inputNode(workflow.id);
    const b = inputNode(workflow.id);
    const merge = mergeNode(workflow.id);

    const response = await graphOps(h.app, workflow.id, 0, [
      addNode(a),
      addNode(b),
      addNode(merge),
      addEdge(edgeBetween(workflow.id, a.id, 'text', merge.id, 'in')),
      addEdge(edgeBetween(workflow.id, b.id, 'text', merge.id, 'in')),
    ]);

    expect(response.status).toBe(200);
  });
});

/**
 * D-001, reported by Mouli after M1 merged. The repro from the defect log, end to end through
 * `graph-ops`: set a non-default temperature, then patch an unrelated field, and the temperature
 * must survive. §2.6's patch is `Partial<NodeConfig>` and shallow — untouched keys keep their
 * values.
 */
describe('D-001 a partial config patch leaves the fields it did not mention alone', () => {
  async function seedAgentWithTemperature(temperature: number) {
    const { workflow } = await seed();
    const agent = agentNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [addNode(agent)]);
    await graphOps(h.app, workflow.id, 1, [
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: {
          config: { execution: { temperature, maxTokens: 2048, timeoutMs: 5000, retries: 1 } },
        },
      },
    ]);
    return { workflow, agent };
  }

  const storedAgent = async (workflowId: string) => {
    const graph = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflowId}`)),
    );
    const stored = graph.nodes.find((node) => node.kind === 'agent');
    return stored?.kind === 'agent' ? stored.config : undefined;
  };

  it('keeps execution.temperature when only contextPolicy is patched', async () => {
    const { workflow, agent } = await seedAgentWithTemperature(0.3);

    const response = await graphOps(h.app, workflow.id, 2, [
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: { config: { contextPolicy: { budgetTokens: 8000 } } },
      },
    ]);
    expect(response.status).toBe(200);

    const config = await storedAgent(workflow.id);
    expect(config?.contextPolicy.budgetTokens).toBe(8000);
    expect(config?.execution.temperature).toBe(0.3);
    expect(config?.execution.maxTokens).toBe(2048);
  });

  it('keeps the rest of execution when only instructions are patched', async () => {
    const { workflow, agent } = await seedAgentWithTemperature(0.9);

    await graphOps(h.app, workflow.id, 2, [
      { op: 'update_node', nodeId: agent.id, patch: { config: { instructions: 'Rewrite' } } },
    ]);

    const config = await storedAgent(workflow.id);
    expect(config?.instructions).toBe('Rewrite');
    expect(config?.execution.temperature).toBe(0.9);
    expect(config?.execution.retries).toBe(1);
  });

  it('keeps a non-default routing policy when an unrelated field is patched', async () => {
    const { workflow } = await seed();
    const agent = agentNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [addNode(agent)]);
    await graphOps(h.app, workflow.id, 1, [
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: { config: { routing: { policy: 'fallback', fallbackModelIds: ['mock-text'] } } },
      },
    ]);

    await graphOps(h.app, workflow.id, 2, [
      { op: 'update_node', nodeId: agent.id, patch: { config: { instructions: 'Rewrite' } } },
    ]);

    const config = await storedAgent(workflow.id);
    expect(config?.routing.policy).toBe('fallback');
    expect(config?.routing.fallbackModelIds).toEqual(['mock-text']);
  });

  it('still replaces a key the patch does name, because §2.6 is shallow', async () => {
    const { workflow, agent } = await seedAgentWithTemperature(0.3);

    await graphOps(h.app, workflow.id, 2, [
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: {
          config: { execution: { temperature: 0.8, maxTokens: 1024, timeoutMs: 9000, retries: 0 } },
        },
      },
    ]);

    const config = await storedAgent(workflow.id);
    expect(config?.execution).toEqual({
      temperature: 0.8,
      maxTokens: 1024,
      timeoutMs: 9000,
      retries: 0,
    });
  });

  it('still rejects an out-of-range value inside a patch (TC-NODE-006 stays true)', async () => {
    const { workflow, agent } = await seedAgentWithTemperature(0.3);

    const response = await graphOps(h.app, workflow.id, 2, [
      { op: 'update_node', nodeId: agent.id, patch: { config: { execution: { temperature: 5 } } } },
    ]);

    expect(response.status).toBe(400);
    expect((await storedAgent(workflow.id))?.execution.temperature).toBe(0.3);
  });
});

describe('TC-NODE-006 Out-of-range setting', () => {
  it('refuses temperature 5 and saves nothing', async () => {
    const { workflow } = await seed();
    const agent = agentNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [addNode(agent)]);

    const response = await graphOps(h.app, workflow.id, 1, [
      { op: 'update_node', nodeId: agent.id, patch: { config: { execution: { temperature: 5 } } } },
    ]);

    expect(response.status).toBe(400);

    const graph = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(graph.workflow.version).toBe(1);
    const stored = graph.nodes[0];
    expect(stored?.kind).toBe('agent');
    expect(stored?.kind === 'agent' && stored.config.execution.temperature).toBe(0.7);
  });

  it('applies nothing from a batch when one op later in it is invalid', async () => {
    const { workflow } = await seed();
    const good = inputNode(workflow.id);
    const agent = agentNode(workflow.id);

    const response = await graphOps(h.app, workflow.id, 0, [
      addNode(good),
      addNode(agent),
      { op: 'update_node', nodeId: agent.id, patch: { config: { execution: { retries: 99 } } } },
    ]);

    expect(response.status).toBe(400);

    const graph = WorkflowGraphResponseSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}`)),
    );
    expect(graph.nodes).toEqual([]);
    expect(graph.workflow.version).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Validate, export, import                                                    */
/* -------------------------------------------------------------------------- */

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

describe('TC-WF-006 Validation list', () => {
  it('reports an unconnected input with the node it belongs to', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const agent = agentNode(workflow.id);
    const output = outputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [addNode(input), addNode(agent), addNode(output)]);

    const { issues } = await body<{ issues: ValidationIssue[] }>(
      await post(h.app, `/api/v1/workflows/${workflow.id}/validate`),
    );

    const unconnected = issues.filter((i) => i.code === 'unconnected_required_input');
    expect(unconnected.length).toBeGreaterThan(0);
    expect(unconnected[0]?.severity).toBe('error');
    expect(unconnected.map((i) => i.nodeId)).toContain(output.id);
    // D285: an Agent with a goal may start on its own, so it is not "unconnected".
    expect(unconnected.map((i) => i.nodeId)).not.toContain(agent.id);
  });

  it('reports an empty workflow as having nothing to start from, and no longer asks for an Output node', async () => {
    const { workflow } = await seed();

    const { issues } = await body<{ issues: ValidationIssue[] }>(
      await post(h.app, `/api/v1/workflows/${workflow.id}/validate`),
    );

    expect(issues.map((i) => i.code)).toContain('no_input_node');
    expect(issues.map((i) => i.code)).not.toContain('no_output_node');
  });

  it('reports a missing model as an error from round 2, because a run cannot start without one', async () => {
    const { workflow } = await seed();
    await graphOps(h.app, workflow.id, 0, [addNode(agentNode(workflow.id))]);

    const { issues } = await body<{ issues: ValidationIssue[] }>(
      await post(h.app, `/api/v1/workflows/${workflow.id}/validate`),
    );

    // D358 (PG-1.3): this helper Agent has no provider either, so its issue is `missing_provider`.
    const missing = issues.find((i) => i.code === 'missing_provider');
    expect(missing?.severity).toBe('error');
  });

  it('finds nothing wrong with a connected Input -> Agent -> Output', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const agent = agentNode(workflow.id);
    // From round 2 an agent without a model is an error, so a clean graph has one chosen.
    if (agent.kind === 'agent') {
      agent.config = { ...agent.config, providerId: PROVIDER_ID, modelId: 'mock-text' };
    }
    const output = outputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(agent),
      addNode(output),
      addEdge(edgeBetween(workflow.id, input.id, 'text', agent.id, 'text')),
      addEdge(edgeBetween(workflow.id, agent.id, 'text', output.id, 'text')),
    ]);

    const { issues } = await body<{ issues: ValidationIssue[] }>(
      await post(h.app, `/api/v1/workflows/${workflow.id}/validate`),
    );

    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('TC-WF-007 Export has no secrets', () => {
  it('exports the graph at formatVersion 1', async () => {
    const { workflow } = await seed();
    const input = inputNode(workflow.id);
    const output = outputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(output),
      addEdge(edgeBetween(workflow.id, input.id, 'text', output.id, 'text')),
    ]);

    const exported = WorkflowExportSchema.parse(
      await body(await get(h.app, `/api/v1/workflows/${workflow.id}/export`)),
    );

    expect(exported.formatVersion).toBe(1);
    expect(exported.nodes).toHaveLength(2);
    expect(exported.edges).toHaveLength(1);
  });

  it('carries no credential-shaped content', async () => {
    const { workflow } = await seed();
    await graphOps(h.app, workflow.id, 0, [addNode(agentNode(workflow.id))]);

    const raw = await (await get(h.app, `/api/v1/workflows/${workflow.id}/export`)).text();

    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
    expect(raw).not.toContain('apiKey');
  });
});

describe('TC-WF-008 Bad import version', () => {
  it('refuses an unknown format version and creates nothing', async () => {
    const { project, workflow } = await seed();
    const exported = await body<Record<string, unknown>>(
      await get(h.app, `/api/v1/workflows/${workflow.id}/export`),
    );

    const response = await post(h.app, `/api/v1/projects/${project.id}/workflows/import`, {
      ...exported,
      formatVersion: 99,
    });

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('unsupported_format_version');

    const listed = await body<{ items: unknown[] }>(
      await get(h.app, `/api/v1/projects/${project.id}/workflows`),
    );
    expect(listed.items).toHaveLength(1);
  });

  it('imports a valid export as a new workflow with fresh ids', async () => {
    const { project, workflow } = await seed();
    const input = inputNode(workflow.id);
    const output = outputNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(output),
      addEdge(edgeBetween(workflow.id, input.id, 'text', output.id, 'text')),
    ]);

    const exported = await body(await get(h.app, `/api/v1/workflows/${workflow.id}/export`));
    const imported = WorkflowGraphResponseSchema.parse(
      await body(await post(h.app, `/api/v1/projects/${project.id}/workflows/import`, exported)),
    );

    expect(imported.workflow.id).not.toBe(workflow.id);
    expect(imported.nodes).toHaveLength(2);
    expect(imported.edges).toHaveLength(1);
    expect(imported.nodes.map((n) => n.id)).not.toContain(input.id);
  });

  it('round-trips: export, import, and the graph has the same shape', async () => {
    const { project, workflow } = await seed();
    const input = inputNode(workflow.id, ['text']);
    const agent = agentNode(workflow.id);
    await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(agent),
      addEdge(edgeBetween(workflow.id, input.id, 'text', agent.id, 'text')),
    ]);

    const exported = await body(await get(h.app, `/api/v1/workflows/${workflow.id}/export`));
    const imported = WorkflowGraphResponseSchema.parse(
      await body(await post(h.app, `/api/v1/projects/${project.id}/workflows/import`, exported)),
    );

    expect(imported.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'input']);
    expect(imported.nodes.map((n) => n.name).sort()).toEqual(['Agent', 'Input']);
    expect(imported.edges).toHaveLength(1);
  });
});
