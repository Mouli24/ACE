import { derivePorts, type GraphOp, type Node, type WorkflowGraphResponse } from '@ace/contracts';
import { AceApiError, createAceClient } from '@ace/sdk';
import { QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from '../mocks/db';
import { createHandlers } from '../mocks/handlers';
import { GraphSync } from './graph-sync';
import { queryKeys } from './query-keys';

const db = new MockDb({ persist: false });
const server = setupServer(...createHandlers(db));
let fetchCount = 0;
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => {
    fetchCount += 1;
    return globalThis.fetch(input, init);
  },
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

function inputNode(workflowId: string, x = 0): Node {
  const base = {
    id: newId(),
    kind: 'input' as const,
    config: { artifactIds: [], outputTypes: ['text' as const] },
  };
  return { ...base, workflowId, name: 'In', position: { x, y: 0 }, ...derivePorts(base) };
}

const add = (node: Node): GraphOp => ({ op: 'add_node', node });

async function setup() {
  db.reset();
  fetchCount = 0;
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = await client.getWorkflow(workflow.id);
  queryClient.setQueryData(queryKeys.workflow(workflow.id), initial);
  const conflicts: AceApiError[] = [];
  const rejections: AceApiError[] = [];
  const sync = new GraphSync({
    workflowId: workflow.id,
    client,
    queryClient,
    debounceMs: 5,
    networkRetryMs: 20,
    onConflictUnresolved: (e) => conflicts.push(e),
    onRejected: (e) => rejections.push(e),
  });
  const cache = () =>
    queryClient.getQueryData<WorkflowGraphResponse>(queryKeys.workflow(workflow.id));
  return { workflow, queryClient, sync, cache, conflicts, rejections };
}

describe('GraphSync — autosave through graph-ops (FR-WF-004, FR-WF-005, Arch §10.1)', () => {
  it('applies ops to the query cache immediately (optimistic UI)', async () => {
    const { workflow, sync, cache } = await setup();
    sync.enqueue([add(inputNode(workflow.id))]);
    expect(cache()?.nodes).toHaveLength(1);
    expect(cache()?.workflow.version).toBe(0);
    await sync.whenIdle();
  });

  it('batches ops enqueued within the debounce window into one request with baseVersion', async () => {
    const { workflow, sync, cache } = await setup();
    const before = fetchCount;
    sync.enqueue([add(inputNode(workflow.id))]);
    sync.enqueue([add(inputNode(workflow.id, 100))]);
    sync.enqueue([add(inputNode(workflow.id, 200))]);
    await sync.whenIdle();
    expect(fetchCount - before).toBe(1);
    expect(cache()?.workflow.version).toBe(1);
    expect(cache()?.nodes).toHaveLength(3);
    expect(db.nodesOf(workflow.id)).toHaveLength(3);
  });

  it('keeps ops enqueued while a request is in flight and sends them next', async () => {
    const { workflow, sync, cache } = await setup();
    sync.enqueue([add(inputNode(workflow.id))]);
    const first = sync.flush();
    sync.enqueue([add(inputNode(workflow.id, 100))]);
    await first;
    await sync.whenIdle();
    expect(cache()?.workflow.version).toBe(2);
    expect(cache()?.nodes).toHaveLength(2);
    expect(db.nodesOf(workflow.id)).toHaveLength(2);
  });

  it('TC-WF-005: on 409 it refetches, reapplies the pending ops on top and retries once', async () => {
    const { workflow, sync, cache } = await setup();
    // another tab writes first, so our cached version 0 is stale
    const theirs = inputNode(workflow.id, -100);
    db.commitGraph(workflow.id, [theirs], []);

    const mine = inputNode(workflow.id);
    sync.enqueue([add(mine)]);
    await sync.whenIdle();

    const ids = cache()
      ?.nodes.map((n) => n.id)
      .sort();
    expect(ids).toEqual([theirs.id, mine.id].sort());
    expect(cache()?.workflow.version).toBe(2);
    expect(
      db
        .nodesOf(workflow.id)
        .map((n) => n.id)
        .sort(),
    ).toEqual([theirs.id, mine.id].sort());
  });

  it('after two 409s in a row it gives up on that batch, reports the conflict and shows server truth', async () => {
    const { workflow, sync, cache, conflicts } = await setup();
    const theirs = inputNode(workflow.id, -100);
    db.commitGraph(workflow.id, [theirs], []);
    server.use(
      http.post('*/api/v1/workflows/:id/graph-ops', () =>
        HttpResponse.json(
          {
            error: {
              kind: 'workflow',
              code: 'stale_version',
              message: 'stale',
              details: { currentVersion: 1 },
              retryable: false,
            },
          },
          { status: 409 },
        ),
      ),
    );

    sync.enqueue([add(inputNode(workflow.id))]);
    await sync.whenIdle();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe('stale_version');
    expect(cache()?.nodes.map((n) => n.id)).toEqual([theirs.id]);
    expect(cache()?.workflow.version).toBe(1);
  });

  it('on 400 it drops the batch, reports the message and restores server truth (TC-NODE-006)', async () => {
    const { workflow, sync, cache, rejections } = await setup();
    const agentBase = {
      id: newId(),
      kind: 'agent' as const,
      config: {
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
      },
    };
    const agent: Node = {
      ...agentBase,
      workflowId: workflow.id,
      name: 'A',
      position: { x: 0, y: 0 },
      ...derivePorts(agentBase),
    };
    sync.enqueue([add(agent)]);
    await sync.whenIdle();
    expect(cache()?.workflow.version).toBe(1);

    sync.enqueue([
      { op: 'update_node', nodeId: agent.id, patch: { name: 'Renamed' } },
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: {
          config: { execution: { temperature: 5, maxTokens: 1, timeoutMs: 1000, retries: 0 } },
        },
      },
    ]);
    expect(cache()?.nodes[0]?.name).toBe('Renamed');
    await sync.whenIdle();

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.status).toBe(400);
    expect(cache()?.nodes[0]?.name).toBe('A');
    expect(cache()?.workflow.version).toBe(1);

    // the controller keeps working afterwards
    sync.enqueue([{ op: 'update_node', nodeId: agent.id, patch: { name: 'Second' } }]);
    await sync.whenIdle();
    expect(db.nodesOf(workflow.id)[0]?.name).toBe('Second');
    expect(cache()?.workflow.version).toBe(2);
  });

  it('onRemoteVersion refetches when the server moved on and nothing is pending', async () => {
    const { workflow, sync, cache } = await setup();
    const theirs = inputNode(workflow.id);
    db.commitGraph(workflow.id, [theirs], []);
    await sync.onRemoteVersion(1);
    expect(cache()?.workflow.version).toBe(1);
    expect(cache()?.nodes.map((n) => n.id)).toEqual([theirs.id]);
  });

  it('onRemoteVersion is a no-op for the version we already have', async () => {
    const { sync } = await setup();
    const before = fetchCount;
    await sync.onRemoteVersion(0);
    expect(fetchCount).toBe(before);
  });

  it('splits more than 200 ops across requests (§2.6 bound)', async () => {
    const { workflow, sync, cache } = await setup();
    const before = fetchCount;
    sync.enqueue(Array.from({ length: 250 }, (_, i) => add(inputNode(workflow.id, i))));
    await sync.whenIdle();
    expect(fetchCount - before).toBe(2);
    expect(cache()?.nodes).toHaveLength(250);
    expect(db.nodesOf(workflow.id)).toHaveLength(250);
  });

  it('keeps the ops queued and retries later when the engine is unreachable', async () => {
    const { workflow, sync, cache, rejections } = await setup();
    let failures = 0;
    server.use(
      http.all('*/api/v1/*', () => {
        if (failures < 2) {
          failures += 1;
          return HttpResponse.error();
        }
        return undefined;
      }),
    );
    const mine = inputNode(workflow.id);
    sync.enqueue([add(mine)]);
    await sync.whenIdle();
    expect(rejections[0]?.kind).toBe('network');
    expect(cache()?.nodes.map((n) => n.id)).toEqual([mine.id]);
    expect(cache()?.workflow.version).toBe(1);
    expect(db.nodesOf(workflow.id).map((n) => n.id)).toEqual([mine.id]);
  });
});
