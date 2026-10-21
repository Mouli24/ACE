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

describe('audit U-9 / P-10 the socket refreshes what may be stale', () => {
  function start(queryClient: QueryClient) {
    const FakeWebSocket = createFakeWebSocket(db);
    startSocket({
      token: 'mock',
      queryClient,
      url: 'ws://mock.local/ws',
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    return FakeWebSocket;
  }

  it('back after a drop, invalidates every query but a workflow with edits still queued', async () => {
    const project = db.createProject({ name: 'P' });
    const quiet = db.createWorkflow(project.id, 'Quiet');
    const busy = db.createWorkflow(project.id, 'Busy');
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projects(), []);
    queryClient.setQueryData(queryKeys.workflow(quiet.id), {
      workflow: quiet,
      nodes: [],
      edges: [],
    });
    queryClient.setQueryData(queryKeys.workflow(busy.id), { workflow: busy, nodes: [], edges: [] });
    // an edit queued and not yet sent (disposed, so it stays queued for the whole test)
    const sync = getGraphSync(busy.id, queryClient);
    sync.enqueue([{ op: 'move_node', nodeId: 'n1', position: { x: 1, y: 2 } }]);
    sync.dispose();
    expect(sync.pending).toBe(1);
    const FakeWebSocket = start(queryClient);
    await tick();
    expect(getSocket()?.status).toBe('open');
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);

    FakeWebSocket.instances.at(-1)?.serverClose(1006);
    expect(getSocket()?.status).toBe('reconnecting');
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'), { timeout: 2000 });
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.workflow(quiet.id))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.workflow(busy.id))?.isInvalidated).toBe(false);
  });

  it('the first open invalidates nothing', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projects(), []);
    start(queryClient);
    await tick();
    expect(getSocket()?.status).toBe('open');
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
  });

  it('a provider turning CONNECTED invalidates the model lists', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    db.setProviderStatus(provider.id, 'UNREACHABLE');
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.providers(), [db.getProvider(provider.id)]);
    queryClient.setQueryData(queryKeys.models({}), []);
    start(queryClient);
    await tick();

    db.setProviderStatus(provider.id, 'UNREACHABLE', 'still down');
    await tick();
    expect(queryClient.getQueryState(queryKeys.models({}))?.isInvalidated).toBe(false);

    db.setProviderStatus(provider.id, 'CONNECTED');
    await tick();
    expect(queryClient.getQueryState(queryKeys.models({}))?.isInvalidated).toBe(true);
  });
});
