import type { WorkflowGraphResponse } from '@ace/contracts';
import { QueryClient } from '@tanstack/react-query';
import { setupServer } from 'msw/node';

import { MockDb } from '../mocks/db';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createHandlers } from '../mocks/handlers';
import { getGraphSync, resetGraphSyncRegistry } from '../workflows/sync-registry';
import { queryKeys } from '../workflows/query-keys';
import { configureApi } from './api';
import { getSocket, startSocket, stopSocket } from './socket';

const db = new MockDb({ persist: false });
const server = setupServer(...createHandlers(db));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  configureApi({ token: 'mock', baseUrl: 'http://mock.local' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  resetGraphSyncRegistry();
  stopSocket();
});

describe('startSocket — one socket patching the query cache (Arch §10.1, §2.9)', () => {
  it('workflow.updated for a workflow with a GraphSync refetches it into the cache', async () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    const queryClient = new QueryClient();
    const initial: WorkflowGraphResponse = { workflow: wf, nodes: [], edges: [] };
    queryClient.setQueryData(queryKeys.workflow(wf.id), initial);
    getGraphSync(wf.id, queryClient);

    const socket = startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    expect(getSocket()).toBe(socket);
    expect(startSocket({ token: 'mock', queryClient })).toBe(socket);
    socket.subscribe({ scope: 'workflow', id: wf.id });
    await tick();
    expect(socket.status).toBe('open');

    db.commitGraph(wf.id, [], []);
    await tick(50);
    expect(
      queryClient.getQueryData<WorkflowGraphResponse>(queryKeys.workflow(wf.id))?.workflow.version,
    ).toBe(1);
  });

  it('workflow.updated for a workflow without a GraphSync invalidates its query', async () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.workflow(wf.id), { workflow: wf, nodes: [], edges: [] });
    const socket = startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    socket.subscribe({ scope: 'workflow', id: wf.id });
    await tick();
    db.commitGraph(wf.id, [], []);
    await tick(20);
    expect(queryClient.getQueryState(queryKeys.workflow(wf.id))?.isInvalidated).toBe(true);
  });
});
