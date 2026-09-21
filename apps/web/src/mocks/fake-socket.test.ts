import { createAceSocket, type AceSocketStatus } from '@ace/sdk';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createFakeWebSocket, type FakeWebSocketInstance } from './fake-socket';

const db = new MockDb({ persist: false });
const FakeWS = createFakeWebSocket(db);

const tick = () => new Promise((r) => setTimeout(r, 5));

function connect(token = 'mock') {
  const socket = createAceSocket({
    url: 'ws://mock.local/ws',
    token,
    WebSocket: FakeWS as unknown as typeof WebSocket,
    backoff: { initialMs: 1, maxMs: 2 },
  });
  socket.connect();
  return socket;
}

beforeEach(() => db.reset());

describe('FakeSocket — the mock side of round 1 §2.9', () => {
  it('opens and sends hello with the current global seq', async () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    db.commitGraph(wf.id, [], []);
    db.commitGraph(wf.id, [], []);
    const socket = connect();
    await tick();
    expect(socket.status).toBe('open');
    expect(socket.lastSeq).toBe(2);
    socket.close();
  });

  it('closes with 4401 when the token is missing', async () => {
    const statuses: AceSocketStatus[] = [];
    const socket = connect('');
    socket.onStatus((s) => statuses.push(s));
    await tick();
    expect(statuses).toContain('unauthorized');
  });

  it('delivers workflow.updated live to a subscribed client, with seq', async () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    const other = db.createWorkflow(project.id, 'G');
    const socket = connect();
    const seen: Array<{ workflowId: string; version: number; seq: number }> = [];
    socket.on('workflow.updated', (p, f) => seen.push({ ...p, seq: f.seq }));
    socket.subscribe({ scope: 'workflow', id: wf.id });
    await tick();
    db.commitGraph(other.id, [], []);
    db.commitGraph(wf.id, [], []);
    await tick();
    expect(seen).toEqual([{ workflowId: wf.id, version: 1, seq: 2 }]);
    socket.close();
  });

  it('replays missed events for the subscription on resume, then continues live', async () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    const socket = connect();
    const seen: number[] = [];
    socket.on('workflow.updated', (_p, f) => seen.push(f.seq));
    socket.subscribe({ scope: 'workflow', id: wf.id });
    await tick();
    db.commitGraph(wf.id, [], []);
    await tick();
    expect(seen).toEqual([1]);

    // drop the connection from the server side, then write while offline
    const live = FakeWS.instances.at(-1) as FakeWebSocketInstance;
    live.serverClose();
    db.commitGraph(wf.id, [], []);
    db.commitGraph(wf.id, [], []);
    await tick();
    await tick();
    expect(socket.status).toBe('open');
    expect(seen).toEqual([1, 2, 3]);

    db.commitGraph(wf.id, [], []);
    await tick();
    expect(seen).toEqual([1, 2, 3, 4]);
    socket.close();
  });

  it('exposes a test hook to bump a version without telling this tab (TC-WF-005 setup)', () => {
    const project = db.createProject({ name: 'P' });
    const wf = db.createWorkflow(project.id, 'F');
    const nodeId = newId();
    expect(db.getWorkflow(wf.id)?.version).toBe(0);
    db.commitGraph(wf.id, [], [], { silent: true });
    expect(db.getWorkflow(wf.id)?.version).toBe(1);
    expect(nodeId).toBeDefined();
  });
});
