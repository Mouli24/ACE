import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDb } from './temp-db.js';
import { makeEdge, makeInputNode, makeOutputNode, makeProject, makeWorkflow, scope } from './fixtures.js';

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

describe('FR-PRJ-001 projects repository', () => {
  it('round-trips a project through SQLite unchanged', async () => {
    const project = makeProject();

    await db.repository.projects.create(scope, project);

    expect(await db.repository.projects.get(scope, project.id)).toEqual(project);
  });

  it('returns null for a project that does not exist', async () => {
    expect(await db.repository.projects.get(scope, makeProject().id)).toBeNull();
  });

  it('never returns another workspace rows', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);

    expect(await db.repository.projects.get({ workspaceId: 'other' }, project.id)).toBeNull();
    expect(await db.repository.projects.list({ workspaceId: 'other' }, { limit: 50 })).toEqual({
      items: [],
    });
  });

  it('renames and records lastOpenedAt', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);

    const updated = await db.repository.projects.update(scope, project.id, {
      name: 'Renamed',
      lastOpenedAt: '2026-09-22T08:00:00.000Z',
      updatedAt: '2026-09-22T08:00:00.000Z',
    });

    expect(updated?.name).toBe('Renamed');
    expect(updated?.lastOpenedAt).toBe('2026-09-22T08:00:00.000Z');
  });

  it('deletes and reports whether anything was removed', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);

    expect(await db.repository.projects.delete(scope, project.id)).toBe(true);
    expect(await db.repository.projects.delete(scope, project.id)).toBe(false);
    expect(await db.repository.projects.get(scope, project.id)).toBeNull();
  });
});

describe('FR-WF-003 cursor pagination', () => {
  it('pages through projects in creation order and stops without a cursor', async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      const project = makeProject({ name: `P${i}` });
      await db.repository.projects.create(scope, project);
      created.push(project);
    }

    const first = await db.repository.projects.list(scope, { limit: 2 });
    expect(first.items.map((p) => p.name)).toEqual(['P0', 'P1']);
    expect(first.nextCursor).toBeDefined();

    const second = await db.repository.projects.list(scope, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((p) => p.name)).toEqual(['P2', 'P3']);

    const third = await db.repository.projects.list(scope, {
      limit: 2,
      cursor: second.nextCursor as string,
    });
    expect(third.items.map((p) => p.name)).toEqual(['P4']);
    expect(third.nextCursor).toBeUndefined();
  });
});

describe('FR-WF-004 nodes and edges round-trip', () => {
  it('stores a node config and derived ports as written', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    const node = makeInputNode(workflow.id);

    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);
    await db.repository.nodes.insert(scope, node);

    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([node]);
  });

  it('resolves a node to its workflow and project by id (FR-CHAT-004)', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    const node = makeInputNode(workflow.id);

    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);
    await db.repository.nodes.insert(scope, node);

    expect(await db.repository.nodes.getById(scope, node.id)).toEqual({
      node,
      workflowId: workflow.id,
      projectId: project.id,
    });
    expect(await db.repository.nodes.getById(scope, 'no-such-node')).toBeNull();
  });

  it('stores an edge and finds it by workflow', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);
    const edge = makeEdge(workflow.id, input, output);

    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);
    await db.repository.nodes.insert(scope, input);
    await db.repository.nodes.insert(scope, output);
    await db.repository.edges.insert(scope, edge);

    expect(await db.repository.edges.listByWorkflow(scope, workflow.id)).toEqual([edge]);
  });

  it('deletes every edge attached to a node', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);

    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);
    await db.repository.nodes.insert(scope, input);
    await db.repository.nodes.insert(scope, output);
    await db.repository.edges.insert(scope, makeEdge(workflow.id, input, output));

    await db.repository.edges.deleteByNode(scope, output.id);

    expect(await db.repository.edges.listByWorkflow(scope, workflow.id)).toEqual([]);
  });
});

describe('FR-EXE-014 event log', () => {
  it('assigns a global monotonic seq that is never reused', async () => {
    const first = await db.repository.events.append(scope, {
      type: 'workflow.updated',
      workflowId: makeProject().id,
      payload: { version: 1 },
      createdAt: '2026-09-21T10:00:00.000Z',
    });
    const second = await db.repository.events.append(scope, {
      type: 'workflow.updated',
      workflowId: makeProject().id,
      payload: { version: 2 },
      createdAt: '2026-09-21T10:00:01.000Z',
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(await db.repository.events.currentSeq(scope)).toBe(second.seq);
  });

  it('replays only the events after a seq, for the subscribed workflows, in order', async () => {
    const wanted = makeProject().id;
    const other = makeProject().id;

    for (const [type, workflowId] of [
      ['workflow.updated', wanted],
      ['workflow.updated', other],
      ['workflow.updated', wanted],
    ] as const) {
      await db.repository.events.append(scope, {
        type,
        workflowId,
        payload: {},
        createdAt: '2026-09-21T10:00:00.000Z',
      });
    }

    const replayed = await db.repository.events.listAfter(scope, 0, { workflowIds: [wanted] });

    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.seq).toBeLessThan(replayed[1]!.seq);
    expect(replayed.every((e) => e.workflowId === wanted)).toBe(true);
  });

  it('starts an empty log at seq 0', async () => {
    expect(await db.repository.events.currentSeq(scope)).toBe(0);
  });
});

describe('FR-SYS-005 settings repository', () => {
  it('returns the §2.7 defaults before anything is saved', async () => {
    const settings = await db.repository.settings.get(scope);

    expect(settings.concurrency).toBe(20);
    expect(settings.theme).toBe('dark');
    expect(settings.onboardingCompleted).toBe(false);
    expect(settings.allowedOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('persists a patch and leaves the other fields alone (TC-SYS-006)', async () => {
    await db.repository.settings.update(scope, { concurrency: 5 });

    const settings = await db.repository.settings.get(scope);
    expect(settings.concurrency).toBe(5);
    expect(settings.theme).toBe('dark');
  });

  it('[audit U-4] clears an optional setting the patch names as undefined', async () => {
    const lastProjectId = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
    await db.repository.settings.update(scope, { lastProjectId });
    expect((await db.repository.settings.get(scope)).lastProjectId).toBe(lastProjectId);

    await db.repository.settings.update(scope, { lastProjectId: undefined });

    const settings = await db.repository.settings.get(scope);
    expect(settings.lastProjectId).toBeUndefined();
    expect(settings.theme).toBe('dark');
  });
});

describe('TC-NFR-006 Atomic writes', () => {
  it('rolls the whole batch back when the transaction body throws half way', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);

    const nodes = [makeInputNode(workflow.id), makeOutputNode(workflow.id)];

    await expect(
      db.repository.transaction(async (tx) => {
        await tx.nodes.insert(scope, nodes[0]!);
        throw new Error('killed mid-batch');
      }),
    ).rejects.toThrow('killed mid-batch');

    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([]);
    expect((await db.repository.workflows.get(scope, workflow.id))?.version).toBe(0);
  });

  it('commits every write when the body returns', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);

    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);

    await db.repository.transaction(async (tx) => {
      await tx.nodes.insert(scope, input);
      await tx.nodes.insert(scope, output);
      await tx.workflows.update(scope, workflow.id, { version: 1, updatedAt: '2026-09-21T11:00:00.000Z' });
    });

    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toHaveLength(2);
    expect((await db.repository.workflows.get(scope, workflow.id))?.version).toBe(1);
  });

  it('leaves the graph fully old or fully new, never half written', async () => {
    const project = makeProject();
    const workflow = makeWorkflow(project.id);
    await db.repository.projects.create(scope, project);
    await db.repository.workflows.create(scope, workflow);

    const batch = Array.from({ length: 10 }, () => makeInputNode(workflow.id));

    await expect(
      db.repository.transaction(async (tx) => {
        for (const [index, node] of batch.entries()) {
          if (index === 5) throw new Error('crash');
          await tx.nodes.insert(scope, node);
        }
      }),
    ).rejects.toThrow('crash');

    const stored = await db.repository.nodes.listByWorkflow(scope, workflow.id);
    expect(stored).toHaveLength(0);
  });
});
