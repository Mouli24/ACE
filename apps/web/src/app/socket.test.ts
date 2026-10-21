import { WS_CLOSE_UNAUTHORIZED, type WorkflowGraphResponse } from '@ace/contracts';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { setupServer } from 'msw/node';

import { MockDb } from '../mocks/db';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { createHandlers } from '../mocks/handlers';
import { getGraphSync, resetGraphSyncRegistry } from '../workflows/sync-registry';
import { queryKeys } from '../workflows/query-keys';
import { configureApi } from './api';
import { getSocket, startSocket, stopSocket, useWorkflowSubscription } from './socket';
import { useSessionStore } from './stores/session';

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

describe('useWorkflowSubscription — shared by every screen watching a workflow (FR-OBS-001, FR-MOB-001)', () => {
  it('keeps the subscription until the last screen watching that workflow unmounts', () => {
    const socket = startSocket({
      token: 'mock',
      queryClient: new QueryClient(),
      url: 'ws://mock.local/ws',
      WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
    });
    const subscribe = vi.spyOn(socket, 'subscribe');
    const unsubscribe = vi.spyOn(socket, 'unsubscribe');

    const canvas = renderHook(() => useWorkflowSubscription('wf-1'));
    const runPage = renderHook(() => useWorkflowSubscription('wf-1'));
    expect(subscribe).toHaveBeenCalledTimes(1);

    runPage.unmount();
    expect(unsubscribe).not.toHaveBeenCalled();
    canvas.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith({ scope: 'workflow', id: 'wf-1' });
  });
});

describe('audit U-2 the socket closing unauthorized', () => {
  afterEach(() => useSessionStore.setState({ lost: false }));

  it('marks the session lost (a restarted engine no longer takes the token)', async () => {
    const FakeWebSocket = createFakeWebSocket(db);
    startSocket({
      token: 'mock',
      queryClient: new QueryClient(),
      url: 'ws://mock.local/ws',
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    await tick();
    expect(useSessionStore.getState().lost).toBe(false);
    FakeWebSocket.instances.at(-1)?.serverClose(WS_CLOSE_UNAUTHORIZED);
    expect(useSessionStore.getState().lost).toBe(true);
  });
});
