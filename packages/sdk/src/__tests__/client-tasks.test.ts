import type {
  RepositoryInfo,
  Task,
  TaskActivity,
  TaskChanges,
  TaskDetail,
  TaskFileDiff,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient, createAceSocket } from '../index.js';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const T = '01ARZ3NDEKTSV4RRFFQ69G5FT0';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const WS = '01ARZ3NDEKTSV4RRFFQ69G5FT1';
const ACT = '01ARZ3NDEKTSV4RRFFQ69G5FT2';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = '2026-10-06T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

/** The recorder of the round 2–5 client tests: every call kept, replies answered from a queue. */
function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? undefined : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const task: Task = {
  id: T,
  projectId: P,
  number: 3,
  title: 'Fix search',
  brief: 'Search ignores accents.',
  type: 'app',
  stage: 'inbox',
  state: 'idle',
  finishLine: 'apply_local',
  automation: 'assisted',
  priority: 'normal',
  labels: ['search'],
  workflowId: W,
  plan: '',
  acceptance: 'café finds cafe',
  runChecks: true,
  paused: false,
  allowedActions: ['start', 'work', 'close', 'pause', 'move', 'delete'],
  createdAt: NOW,
  updatedAt: NOW,
};

const detail: TaskDetail = {
  task: { ...task, stage: 'review', allowedActions: ['approve', 'request_changes', 'apply'] },
  workspace: {
    id: WS,
    taskId: T,
    repoPath: 'D:\\repo',
    path: 'D:\\data\\workspaces\\t',
    branch: 'ace/task-3-fix-search',
    baseBranch: 'main',
    baseSha: SHA_A,
    headSha: SHA_B,
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
  },
  executions: [],
  checks: [],
  reviews: [],
  deliveries: [],
};

const activity: TaskActivity = {
  id: ACT,
  taskId: T,
  kind: 'created',
  message: 'Task #3 created.',
  at: NOW,
};

const changes: TaskChanges = {
  branch: 'ace/task-3-fix-search',
  baseBranch: 'main',
  baseSha: SHA_A,
  headSha: SHA_B,
  uncommitted: false,
  files: [
    {
      path: 'src/search.ts',
      status: 'modified',
      additions: 12,
      deletions: 3,
      binary: false,
    },
  ],
  totals: { files: 1, additions: 12, deletions: 3 },
};

const diff: TaskFileDiff = {
  path: 'src/search.ts',
  binary: false,
  patch: '@@ -1 +1 @@\n-a\n+b\n',
  truncated: false,
};

const repository: RepositoryInfo = {
  folderPath: 'D:\\repo',
  gitAvailable: true,
  isRepo: true,
  branch: 'main',
  headSha: SHA_A,
  clean: true,
  changedFiles: 0,
};

const apiError = (code: string, status: number) => ({
  status,
  body: { error: { kind: 'workflow', code, message: code, retryable: false } },
});

describe('ACE-P0 tasks — list, create, read, edit, delete (design §6)', () => {
  it('lists a project’s tasks with its filters on the query string', async () => {
    const { calls, client } = recorder([{ body: { items: [task] } }, { body: { items: [] } }]);

    await expect(client.listTasks(P)).resolves.toEqual({ items: [task] });
    await expect(
      client.listTasks(P, { stage: 'review', q: '  search ', label: 'ui', attention: true }),
    ).resolves.toEqual({ items: [] });

    expect(paths(calls)).toEqual([
      `GET /projects/${P}/tasks`,
      `GET /projects/${P}/tasks?stage=review&q=search&label=ui&attention=true`,
    ]);
  });

  it('leaves a blank search out, and refuses a filter the contract refuses before sending it', async () => {
    const { calls, client } = recorder([{ body: { items: [] } }]);
    await client.listTasks(P, { q: '   ', attention: false });
    expect(paths(calls)).toEqual([`GET /projects/${P}/tasks?attention=false`]);

    await expect(client.listTasks(P, { stage: 'nowhere' as never })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('creates a task (201) with the body as given', async () => {
    const { calls, client } = recorder([{ status: 201, body: task }]);
    await expect(
      client.createTask(P, { title: 'Fix search', workflowId: W, start: 'inbox' }),
    ).resolves.toEqual(task);
    expect(paths(calls)).toEqual([`POST /projects/${P}/tasks`]);
    expect(calls[0]?.body).toEqual({ title: 'Fix search', workflowId: W, start: 'inbox' });
  });

  it('refuses a finish line that does not fit the type before it is sent', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.createTask(P, { title: 'Draft', type: 'email', finishLine: 'apply_local' }),
    ).rejects.toBeInstanceOf(AceApiError);
    await expect(client.createTask(P, { title: '  ' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('reads the detail, patches (null clears the team), lists activity and deletes (204)', async () => {
    const { calls, client } = recorder([
      { body: detail },
      { body: { ...task, title: 'Renamed' } },
      { body: { items: [activity] } },
      { status: 204 },
    ]);

    await expect(client.getTask(T)).resolves.toEqual(detail);
    await expect(
      client.updateTask(T, { title: 'Renamed', workflowId: null }),
    ).resolves.toMatchObject({ title: 'Renamed' });
    await expect(client.listTaskActivity(T)).resolves.toEqual({ items: [activity] });
    await expect(client.deleteTask(T)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `GET /tasks/${T}`,
      `PATCH /tasks/${T}`,
      `GET /tasks/${T}/activity`,
      `DELETE /tasks/${T}`,
    ]);
    expect(calls[1]?.body).toEqual({ title: 'Renamed', workflowId: null });
  });

  it('refuses a PATCH that moves a task into Done, and a reply that is not a Task', async () => {
    const { calls, client } = recorder([{ body: { ...task, stage: 'nowhere' } }]);
    await expect(client.updateTask(T, { stage: 'done' as never })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
    await expect(client.getTask(T)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('surfaces 404 task_not_found as an AceApiError', async () => {
    const { client } = recorder([apiError('task_not_found', 404)]);
    await expect(client.getTask(T)).rejects.toMatchObject({ status: 404, code: 'task_not_found' });
  });
});

describe('ACE-P0 task actions (design §2, §6)', () => {
  it('posts {} for start, plan, stop, retry and checks', async () => {
    const { calls, client } = recorder(Array.from({ length: 5 }, () => ({ body: task })));

    await client.startTask(T);
    await client.planTask(T);
    await client.stopTask(T);
    await client.retryTask(T);
    await client.runTaskChecks(T);

    expect(paths(calls)).toEqual([
      `POST /tasks/${T}/start`,
      `POST /tasks/${T}/plan`,
      `POST /tasks/${T}/stop`,
      `POST /tasks/${T}/retry`,
      `POST /tasks/${T}/checks`,
    ]);
    expect(calls.map((call) => call.body)).toEqual([{}, {}, {}, {}, {}]);
  });

  it('work sends the follow-up message, or {} without one', async () => {
    const { calls, client } = recorder([{ body: task }, { body: task }]);
    await client.workTask(T);
    await client.workTask(T, { message: 'Handle umlauts too.' });
    expect(paths(calls)).toEqual([`POST /tasks/${T}/work`, `POST /tasks/${T}/work`]);
    expect(calls.map((call) => call.body)).toEqual([{}, { message: 'Handle umlauts too.' }]);
  });

  it('review: approve with the head sha; changes requested needs a note', async () => {
    const { calls, client } = recorder([{ body: task }]);
    await client.reviewTask(T, { decision: 'approved', headSha: SHA_B });
    expect(calls[0]?.body).toEqual({ decision: 'approved', headSha: SHA_B });

    await expect(client.reviewTask(T, { decision: 'changes_requested' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('apply repeats the destination; a moved repository answers 409 destination_changed', async () => {
    const { calls, client } = recorder([apiError('destination_changed', 409)]);
    const destination = { folderPath: 'D:\\repo', branch: 'main' };
    await expect(client.applyTask(T, { destination })).rejects.toMatchObject({
      status: 409,
      code: 'destination_changed',
    });
    expect(paths(calls)).toEqual([`POST /tasks/${T}/apply`]);
    expect(calls[0]?.body).toEqual({ destination });
  });

  it('close takes an optional reason; pause sends { paused }', async () => {
    const { calls, client } = recorder([{ body: task }, { body: task }, { body: task }]);
    await client.closeTask(T);
    await client.closeTask(T, { reason: 'Done by hand.' });
    await client.pauseTask(T, { paused: true });
    expect(paths(calls)).toEqual([
      `POST /tasks/${T}/close`,
      `POST /tasks/${T}/close`,
      `POST /tasks/${T}/pause`,
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      {},
      { reason: 'Done by hand.' },
      { paused: true },
    ]);
  });
});

describe('ACE-P0 changes and repository (design §6)', () => {
  it('reads the changes and one file’s diff by path', async () => {
    const { calls, client } = recorder([{ body: changes }, { body: diff }]);
    await expect(client.getTaskChanges(T)).resolves.toEqual(changes);
    await expect(client.getTaskFileDiff(T, 'src/search.ts')).resolves.toEqual(diff);
    expect(paths(calls)).toEqual([
      `GET /tasks/${T}/changes`,
      `GET /tasks/${T}/changes/diff?path=src%2Fsearch.ts`,
    ]);
  });

  it('a task without a workspace answers 404 no_workspace', async () => {
    const { client } = recorder([apiError('no_workspace', 404)]);
    await expect(client.getTaskChanges(T)).rejects.toMatchObject({ code: 'no_workspace' });
  });

  it('reads the repository and initialises one with {}', async () => {
    const { calls, client } = recorder([
      { body: { folderPath: 'D:\\plain', gitAvailable: true, isRepo: false } },
      { body: repository },
    ]);
    await expect(client.getRepository(P)).resolves.toMatchObject({ isRepo: false });
    await expect(client.initRepository(P)).resolves.toEqual(repository);
    expect(paths(calls)).toEqual([
      `GET /projects/${P}/repository`,
      `POST /projects/${P}/repository/init`,
    ]);
    expect(calls[1]?.body).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Socket: task.updated / task.deleted ride the engine subscription            */
/* -------------------------------------------------------------------------- */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.onclose?.({ code: 1000, reason: '' });
  }
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe('ACE-P0 engine frames: task.updated and task.deleted', () => {
  it('delivers both typed, and drops a task.updated whose task breaks the contract', () => {
    FakeWebSocket.instances = [];
    const socket = createAceSocket({
      url: 'ws://127.0.0.1:4747/ws',
      token: 'tok',
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const updated: string[] = [];
    const deleted: string[] = [];
    socket.on('task.updated', (payload) =>
      updated.push(`${payload.task.id}:${payload.task.state}`),
    );
    socket.on('task.deleted', (payload) => deleted.push(`${payload.projectId}/${payload.taskId}`));
    socket.subscribe({ scope: 'engine' });
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    expect(ws.sent).toContainEqual({ type: 'subscribe', payload: { scope: 'engine' } });

    ws.serverSend({ type: 'hello', payload: { seq: 0 } });
    ws.serverSend({
      type: 'task.updated',
      payload: { task: { ...task, state: 'running' }, activity },
      seq: 1,
    });
    ws.serverSend({ type: 'task.updated', payload: { task: { ...task, state: 'busy' } }, seq: 2 });
    ws.serverSend({ type: 'task.deleted', payload: { taskId: T, projectId: P }, seq: 3 });

    expect(updated).toEqual([`${T}:running`]);
    expect(deleted).toEqual([`${P}/${T}`]);
    socket.close();
  });
});
