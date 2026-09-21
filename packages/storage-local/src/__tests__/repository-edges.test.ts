import { LOCAL_SCOPE } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InProcessPubSub } from '../pubsub.js';
import { createTempDb, type TempDb } from './temp-db.js';
import { makeEdge, makeInputNode, makeOutputNode, makeProject, makeWorkflow } from './fixtures.js';

const scope = LOCAL_SCOPE;

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

async function seedWorkflow() {
  const project = makeProject();
  const workflow = makeWorkflow(project.id);
  await db.repository.projects.create(scope, project);
  await db.repository.workflows.create(scope, workflow);
  return { project, workflow };
}

describe('FR-WF-003 workflow repository', () => {
  it('pages workflows within one project and ignores another project rows', async () => {
    const { project, workflow } = await seedWorkflow();
    const otherProject = makeProject();
    await db.repository.projects.create(scope, otherProject);
    await db.repository.workflows.create(scope, makeWorkflow(otherProject.id));

    const page = await db.repository.workflows.listByProject(scope, project.id, { limit: 50 });

    expect(page.items.map((w) => w.id)).toEqual([workflow.id]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('pages with a cursor', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);
    for (let i = 0; i < 3; i += 1) {
      await db.repository.workflows.create(scope, makeWorkflow(project.id, { name: `W${i}` }));
    }

    const first = await db.repository.workflows.listByProject(scope, project.id, { limit: 2 });
    const second = await db.repository.workflows.listByProject(scope, project.id, {
      limit: 2,
      cursor: first.nextCursor as string,
    });

    expect(first.items.map((w) => w.name)).toEqual(['W0', 'W1']);
    expect(second.items.map((w) => w.name)).toEqual(['W2']);
  });

  it('renames without touching the version', async () => {
    const { workflow } = await seedWorkflow();

    const renamed = await db.repository.workflows.update(scope, workflow.id, {
      name: 'Renamed',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(renamed?.name).toBe('Renamed');
    expect(renamed?.version).toBe(0);
  });

  it('bumps the version without touching the name', async () => {
    const { workflow } = await seedWorkflow();

    const bumped = await db.repository.workflows.update(scope, workflow.id, {
      version: 3,
      updatedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(bumped?.version).toBe(3);
    expect(bumped?.name).toBe(workflow.name);
  });

  it('returns null when updating a workflow that is not there', async () => {
    const missing = makeWorkflow(makeProject().id);

    expect(
      await db.repository.workflows.update(scope, missing.id, { updatedAt: '2026-09-22T00:00:00.000Z' }),
    ).toBeNull();
  });

  it('reports whether a delete removed anything', async () => {
    const { workflow } = await seedWorkflow();

    expect(await db.repository.workflows.delete(scope, workflow.id)).toBe(true);
    expect(await db.repository.workflows.delete(scope, workflow.id)).toBe(false);
  });

  it('returns null for a workflow in another workspace', async () => {
    const { workflow } = await seedWorkflow();

    expect(await db.repository.workflows.get({ workspaceId: 'other' }, workflow.id)).toBeNull();
  });
});

describe('FR-WF-004 node and edge updates', () => {
  it('replaces a node config and its derived ports in place', async () => {
    const { workflow } = await seedWorkflow();
    const node = makeInputNode(workflow.id);
    await db.repository.nodes.insert(scope, node);

    const moved = {
      ...node,
      name: 'Renamed',
      position: { x: 99, y: 100 },
      outputs: [
        { id: `${node.id}:out:json`, name: 'json', dataType: 'json' as const, multi: true },
      ],
      config: { artifactIds: [], outputTypes: ['json' as const] },
    };
    await db.repository.nodes.update(scope, moved);

    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([moved]);
  });

  it('updates an edge loop configuration', async () => {
    const { workflow } = await seedWorkflow();
    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);
    const edge = makeEdge(workflow.id, input, output);

    await db.repository.nodes.insert(scope, input);
    await db.repository.nodes.insert(scope, output);
    await db.repository.edges.insert(scope, edge);

    const looped = {
      ...edge,
      loop: {
        maxIterations: 4,
        exitCondition: { path: '$.done', equals: true },
        onMax: 'fail' as const,
      },
    };
    await db.repository.edges.update(scope, looped);

    expect(await db.repository.edges.listByWorkflow(scope, workflow.id)).toEqual([looped]);
  });

  it('deletes a single node and a single edge by id', async () => {
    const { workflow } = await seedWorkflow();
    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);
    const edge = makeEdge(workflow.id, input, output);

    await db.repository.nodes.insert(scope, input);
    await db.repository.nodes.insert(scope, output);
    await db.repository.edges.insert(scope, edge);

    await db.repository.edges.delete(scope, edge.id);
    await db.repository.nodes.delete(scope, input.id);

    expect(await db.repository.edges.listByWorkflow(scope, workflow.id)).toEqual([]);
    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([output]);
  });

  it('clears every node and edge of a workflow', async () => {
    const { workflow } = await seedWorkflow();
    const input = makeInputNode(workflow.id);
    const output = makeOutputNode(workflow.id);

    await db.repository.nodes.insert(scope, input);
    await db.repository.nodes.insert(scope, output);
    await db.repository.edges.insert(scope, makeEdge(workflow.id, input, output));

    await db.repository.edges.deleteByWorkflow(scope, workflow.id);
    await db.repository.nodes.deleteByWorkflow(scope, workflow.id);

    expect(await db.repository.nodes.listByWorkflow(scope, workflow.id)).toEqual([]);
    expect(await db.repository.edges.listByWorkflow(scope, workflow.id)).toEqual([]);
  });
});

describe('FR-EXE-014 event filtering', () => {
  async function appendEvent(type: string, workflowId?: string) {
    return db.repository.events.append(scope, {
      type,
      ...(workflowId === undefined ? {} : { workflowId }),
      payload: {},
      createdAt: '2026-09-21T10:00:00.000Z',
    });
  }

  it('returns nothing when the client is subscribed to nothing', async () => {
    await appendEvent('workflow.updated', makeProject().id);

    expect(await db.repository.events.listAfter(scope, 0, {})).toEqual([]);
  });

  it('includes unscoped engine events for a client subscribed to the engine scope', async () => {
    const workflowId = makeProject().id;
    await appendEvent('engine.something');
    await appendEvent('workflow.updated', workflowId);

    const both = await db.repository.events.listAfter(scope, 0, {
      workflowIds: [workflowId],
      includeEngineScope: true,
    });

    expect(both.map((e) => e.type)).toEqual(['engine.something', 'workflow.updated']);
  });

  it('returns only engine-scope events when the client subscribed to no workflow', async () => {
    await appendEvent('engine.something');
    await appendEvent('workflow.updated', makeProject().id);

    const engineOnly = await db.repository.events.listAfter(scope, 0, {
      includeEngineScope: true,
    });

    expect(engineOnly.map((e) => e.type)).toEqual(['engine.something', 'workflow.updated']);
  });

  it('replays strictly after the given seq', async () => {
    const first = await appendEvent('workflow.updated', 'unused');
    const second = await appendEvent('workflow.updated', 'unused');

    const after = await db.repository.events.listAfter(scope, first.seq, {
      workflowIds: ['unused'],
    });

    expect(after.map((e) => e.seq)).toEqual([second.seq]);
  });
});

describe('Arch §7 pub/sub edge cases', () => {
  it('publishing to a topic with no subscriber is a no-op', async () => {
    const pubsub = new InProcessPubSub<string>();

    await expect(pubsub.publish(scope, 'nobody-listening', 'x')).resolves.toBeUndefined();
  });

  it('keeps delivering to the remaining subscribers after one unsubscribes', async () => {
    const pubsub = new InProcessPubSub<string>();
    const kept: string[] = [];

    const drop = await pubsub.subscribe(scope, 'topic', () => undefined);
    await pubsub.subscribe(scope, 'topic', (m) => kept.push(m));
    drop();
    await pubsub.publish(scope, 'topic', 'still here');

    expect(kept).toEqual(['still here']);
  });
});
