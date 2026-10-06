import { EngineEventSchema, TaskSchema, type Task, type TaskAction } from '@ace/contracts';
import { createAceClient, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createRound4Handlers } from './handlers-round4';
import { createRound5Handlers } from './handlers-round5';
import { createTaskHandlers } from './handlers-tasks';
import { allowedTaskActions, type TaskActionContext } from './task-actions';
import {
  completeMockWork,
  failNextApply,
  failNextChecks,
  failNextWork,
  headChecksFailed,
  pendingMockWork,
  resetMockTasks,
  setTaskWorkPace,
} from './tasks';

/**
 * The ACE parity P0 MSW seam (design §6): the mock tasks engine answered through the real SDK, so
 * every reply is parsed with the contract schema the engine must also satisfy, and every state
 * change is checked to arrive as one engine-scope `task.updated`.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createTaskHandlers(db),
  ...createRound5Handlers(db),
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});
const FakeWS = createFakeWebSocket(db);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  resetMockTasks();
  setTaskWorkPace('manual');
  db.reset();
});

async function failure(promise: Promise<unknown>): Promise<AceApiError> {
  try {
    await promise;
  } catch (error) {
    return error as AceApiError;
  }
  throw new Error('expected the call to fail');
}

function seed(options: { folderPath?: string; checks?: boolean } = {}) {
  const project = db.createProject({
    name: 'Shop',
    ...(options.folderPath === undefined ? {} : { folderPath: options.folderPath }),
  });
  if (options.checks !== false) {
    db.updateProject(project.id, { checkCommands: [{ name: 'test', command: 'pnpm test' }] });
  }
  const team = db.createWorkflow(project.id, 'Builders');
  const planner = db.createWorkflow(project.id, 'Planner');
  return { project, team, planner };
}

function watchEngine() {
  const frames: { type: string; payload: Record<string, unknown> }[] = [];
  const socket = new FakeWS('ws://mock.local/ws?token=mock');
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as {
      type: string;
      payload: Record<string, unknown>;
    };
    if (frame.type === 'hello') return;
    // every engine frame the mock sends is one the contract accepts
    expect(EngineEventSchema.safeParse(frame).success).toBe(true);
    frames.push(frame);
  };
  socket.onopen = () =>
    socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'engine' } }));
  return {
    frames,
    states: () =>
      frames
        .filter((frame) => frame.type === 'task.updated')
        .map((frame) => {
          const task = frame.payload['task'] as Task;
          return `${task.stage}/${task.state}`;
        }),
    close: () => socket.close(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ACE-P0 tasks: create, list, edit, delete (design §6)', () => {
  it('numbers tasks per project from 1, with the contract defaults and allowed actions', async () => {
    const { project, team } = seed();
    const other = db.createProject({ name: 'Other' });

    const first = await client.createTask(project.id, { title: 'Fix search', workflowId: team.id });
    const second = await client.createTask(project.id, { title: 'Add filters' });
    const elsewhere = await client.createTask(other.id, { title: 'Elsewhere' });

    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({
      stage: 'inbox',
      state: 'idle',
      type: 'app',
      finishLine: 'review',
      automation: 'assisted',
      priority: 'normal',
      labels: [],
      runChecks: true,
      paused: false,
    });
    expect(first.allowedActions).toEqual(['start', 'work', 'close', 'pause', 'move', 'delete']);
    // without a team there is no work to start
    expect(second.allowedActions).not.toContain('work');

    // a deleted number is never handed out again
    await client.deleteTask(second.id);
    expect((await client.createTask(project.id, { title: 'Third' })).number).toBe(3);
  });

  it('filters by stage, search (title, brief or #n), label and Needs attention', async () => {
    const { project, team } = seed();
    const a = await client.createTask(project.id, {
      title: 'Fix search',
      brief: 'Accents are ignored',
      labels: ['search', 'bug'],
      workflowId: team.id,
    });
    await client.createTask(project.id, { title: 'Write docs', labels: ['docs'] });
    await client.startTask(a.id);

    const titles = async (filter: Parameters<typeof client.listTasks>[1]) =>
      (await client.listTasks(project.id, filter)).items.map((task) => task.title);

    expect(await titles({})).toEqual(['Write docs', 'Fix search']);
    expect(await titles({ stage: 'inbox' })).toEqual(['Write docs']);
    expect(await titles({ q: 'ACCENTS' })).toEqual(['Fix search']);
    expect(await titles({ q: '#2' })).toEqual(['Write docs']);
    expect(await titles({ label: 'Bug' })).toEqual(['Fix search']);
    // running is not waiting on a person; review idle is
    expect(await titles({ attention: true })).toEqual([]);
    completeMockWork(a.id);
    expect(await titles({ attention: true })).toEqual(['Fix search']);
  });

  it('patches fields, clears the team with null, refuses a finish line that does not fit', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });

    const edited = await client.updateTask(task.id, {
      title: 'Fix search',
      plan: '1. Do it',
      labels: ['ui'],
      priority: 'urgent',
      workflowId: null,
    });
    expect(edited).toMatchObject({ title: 'Fix search', plan: '1. Do it', priority: 'urgent' });
    expect(edited.workflowId).toBeUndefined();
    expect((await client.listTaskActivity(task.id)).items.at(-1)?.message).toBe(
      'Edited title, plan, team, priority, labels.',
    );

    const wrongLine = await failure(client.updateTask(task.id, { finishLine: 'send_email' }));
    expect(wrongLine).toMatchObject({ status: 422, code: 'validation_failed' });
    const foreign = db.createWorkflow(db.createProject({ name: 'X' }).id, 'Theirs');
    expect(await failure(client.updateTask(task.id, { workflowId: foreign.id }))).toMatchObject({
      status: 422,
    });
  });

  it('moves an idle task between columns but never a running one', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    expect((await client.updateTask(task.id, { stage: 'review' })).stage).toBe('review');

    await client.workTask(task.id);
    expect(await failure(client.updateTask(task.id, { stage: 'inbox' }))).toMatchObject({
      status: 409,
      code: 'invalid_transition',
    });
  });

  it('deletes with 204 and a task.deleted frame; a running task cannot be deleted', async () => {
    const { project, team } = seed();
    const engine = watchEngine();
    await tick();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    await client.workTask(task.id);
    expect(await failure(client.deleteTask(task.id))).toMatchObject({
      status: 409,
      code: 'invalid_transition',
    });
    await client.stopTask(task.id);
    await client.deleteTask(task.id);

    expect(engine.frames.at(-1)).toEqual({
      type: 'task.deleted',
      payload: { taskId: task.id, projectId: project.id },
      seq: expect.any(Number),
    });
    expect(await failure(client.getTask(task.id))).toMatchObject({
      status: 404,
      code: 'task_not_found',
    });
    engine.close();
  });

  it('refuses a request without the token and an unknown task', async () => {
    const anonymous = createAceClient({
      baseUrl: 'http://mock.local',
      token: '',
      fetch: (input, init) => globalThis.fetch(input, init),
    });
    expect(await failure(anonymous.listTasks(seed().project.id))).toMatchObject({ status: 401 });
    expect(await failure(client.startTask('01ARZ3NDEKTSV4RRFFQ69G5FT0'))).toMatchObject({
      status: 404,
    });
  });
});

describe('ACE-P0 the §1 flow: start → work → review → apply (design §2)', () => {
  it('runs, commits two files, checks them, and applies to the confirmed destination', async () => {
    const { project, team } = seed();
    const engine = watchEngine();
    await tick();

    const created = await client.createTask(project.id, {
      title: 'Fix search',
      workflowId: team.id,
      finishLine: 'apply_local',
      start: 'now',
    });
    // started, and as Assisted with no planner, straight into work
    expect(created).toMatchObject({ stage: 'work', state: 'running' });
    expect(created.allowedActions).toEqual(['stop', 'pause']);
    expect(pendingMockWork()).toEqual([created.id]);

    // the uncommitted changes show while the run is going
    expect(await client.getTaskChanges(created.id)).toMatchObject({ uncommitted: true });

    expect(completeMockWork(created.id)).toBe(true);
    const detail = await client.getTask(created.id);
    expect(detail.task).toMatchObject({ stage: 'review', state: 'idle' });
    expect(detail.task.allowedActions).toEqual(
      expect.arrayContaining(['approve', 'request_changes', 'apply', 'checks', 'work']),
    );
    expect(detail.executions).toHaveLength(1);
    expect(detail.executions[0]).toMatchObject({
      kind: 'work',
      status: 'completed',
      changedFiles: 2,
    });
    expect(detail.workspace).toMatchObject({
      branch: 'ace/task-1-fix-search',
      baseBranch: 'main',
      headSha: detail.executions[0]?.commitSha,
      status: 'ready',
    });
    expect(detail.checks.map((check) => `${check.name}:${check.status}`)).toEqual(['test:passed']);

    const changes = await client.getTaskChanges(created.id);
    expect(changes).toMatchObject({
      uncommitted: false,
      totals: { files: 2, additions: 52, deletions: 3 },
    });
    expect(
      changes.files.map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`),
    ).toEqual(['modified src/search.ts +12 -3', 'added src/search.test.ts +40 -0']);
    const diff = await client.getTaskFileDiff(created.id, 'src/search.ts');
    expect(diff.patch).toContain('@@ -1,8 +1,17 @@');
    expect(diff.patch).toContain('+export function normalize(text: string): string {');
    expect(await failure(client.getTaskFileDiff(created.id, 'nope.ts'))).toMatchObject({
      status: 404,
    });

    // a review of an older head is refused; the current head is approved
    const stale = await failure(
      client.reviewTask(created.id, { decision: 'approved', headSha: 'f'.repeat(40) }),
    );
    expect(stale).toMatchObject({ status: 409, code: 'stale_review' });
    const approved = await client.reviewTask(created.id, {
      decision: 'approved',
      headSha: changes.headSha,
    });
    // the finish line is Apply, so approval alone does not finish it
    expect(approved).toMatchObject({ stage: 'review', state: 'idle' });

    const repository = await client.getRepository(project.id);
    expect(repository).toMatchObject({ isRepo: true, branch: 'main', clean: true });
    const moved = await failure(
      client.applyTask(created.id, {
        destination: { folderPath: repository.folderPath, branch: 'develop' },
      }),
    );
    expect(moved).toMatchObject({ status: 409, code: 'destination_changed' });

    const applied = await client.applyTask(created.id, {
      destination: { folderPath: repository.folderPath, branch: 'main' },
    });
    expect(applied).toMatchObject({ stage: 'done', state: 'done', outcome: 'applied' });
    expect(applied.allowedActions).toEqual(['delete']);
    const after = await client.getTask(created.id);
    expect(after.workspace?.status).toBe('applied');
    expect(after.deliveries[0]).toMatchObject({
      kind: 'apply_local',
      status: 'succeeded',
      destination: `${repository.folderPath} @ main`,
    });
    expect((await client.getRepository(project.id)).headSha).toBe(after.deliveries[0]?.sha);

    expect(engine.states()).toEqual([
      'inbox/idle', // created
      'plan/idle', // started
      'plan/idle', // workspace ready
      'work/running', // run started
      'work/running', // run completed
      'work/running', // committed
      'work/running', // checks passed
      'review/idle', // ready for review
      'review/idle', // approved
      'done/done', // applied
    ]);
    const kinds = (await client.listTaskActivity(created.id)).items.map((row) => row.kind);
    expect(kinds).toEqual([
      'created',
      'stage_changed',
      'workspace_ready',
      'run_started',
      'run_completed',
      'committed',
      'checks_passed',
      'stage_changed',
      'approved',
      'delivered',
    ]);
    engine.close();
  });

  it('finish line Pass review: approval reaches Done with outcome reviewed', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    await client.workTask(task.id);
    completeMockWork(task.id);
    const done = await client.reviewTask(task.id, { decision: 'approved' });
    expect(done).toMatchObject({ stage: 'done', outcome: 'reviewed' });
    expect(done.completedAt).toBeDefined();
  });

  it('changes requested starts a new work run with the note as its request', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    await client.workTask(task.id);
    completeMockWork(task.id);
    const again = await client.reviewTask(task.id, {
      decision: 'changes_requested',
      note: 'Handle umlauts too.',
    });
    expect(again).toMatchObject({ stage: 'work', state: 'running' });
    const detail = await client.getTask(task.id);
    expect(detail.executions.map((row) => row.request)).toEqual(['', 'Handle umlauts too.']);
    expect(detail.reviews[0]).toMatchObject({ decision: 'changes_requested' });

    // paused, the note waits as the pending request instead
    completeMockWork(task.id);
    await client.pauseTask(task.id, { paused: true });
    const waiting = await client.reviewTask(task.id, {
      decision: 'changes_requested',
      note: 'More',
    });
    expect(waiting).toMatchObject({ stage: 'work', state: 'idle', pendingRequest: 'More' });
    const resumed = await client.pauseTask(task.id, { paused: false });
    expect(resumed).toMatchObject({ state: 'running' });
  });

  it('close: Done without verification; an action the state does not allow is a 409', async () => {
    const { project } = seed();
    const task = await client.createTask(project.id, { title: 'Fix' });
    const closed = await client.closeTask(task.id, { reason: 'Done by hand.' });
    expect(closed).toMatchObject({ stage: 'done', state: 'done', outcome: 'closed_unverified' });
    expect((await client.listTaskActivity(task.id)).items.at(-1)?.message).toBe(
      'Closed without verification: Done by hand.',
    );
    const refused = await failure(client.startTask(task.id));
    expect(refused).toMatchObject({ status: 409, code: 'invalid_transition' });
    expect(refused.message).toBe('A task in done that is done cannot start.');
  });

  it('a planner writes the plan, then Assisted moves on to work', async () => {
    const { project, team, planner } = seed();
    const task = await client.createTask(project.id, {
      title: 'Fix',
      workflowId: team.id,
      plannerWorkflowId: planner.id,
      start: 'now',
    });
    expect(task).toMatchObject({ stage: 'plan', state: 'running' });
    completeMockWork(task.id);
    const detail = await client.getTask(task.id);
    expect(detail.task.plan).toContain('normalize()');
    expect(detail.task).toMatchObject({ stage: 'work', state: 'running' });
    expect(detail.executions.map((row) => `${row.kind}:${row.status}`)).toEqual([
      'plan:completed',
      'work:running',
    ]);
  });

  it('Manual waits after start; an email task reaches review without a workspace', async () => {
    const { project, team } = seed();
    const manual = await client.createTask(project.id, {
      title: 'Manual',
      workflowId: team.id,
      automation: 'manual',
      start: 'now',
    });
    expect(manual).toMatchObject({ stage: 'plan', state: 'idle' });

    const email = await client.createTask(project.id, {
      title: 'Reply to Ada',
      type: 'email',
      workflowId: team.id,
    });
    expect(email.finishLine).toBe('accept_draft');
    await client.workTask(email.id);
    completeMockWork(email.id);
    const detail = await client.getTask(email.id);
    expect(detail.task.stage).toBe('review');
    expect(detail.workspace).toBeUndefined();
    expect(await failure(client.getTaskChanges(email.id))).toMatchObject({ code: 'no_workspace' });
  });
});

describe('ACE-P0 failures, stop, retry, checks and Apply refusals (design §2, §5)', () => {
  it('a failed run keeps its reason and Retry runs it again; Stop leaves it idle', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    failNextWork('The model ran out of budget.');
    await client.workTask(task.id, { message: 'Try harder' });
    completeMockWork(task.id);
    const failed = await client.getTask(task.id);
    expect(failed.task).toMatchObject({
      state: 'failed',
      stateReason: 'The model ran out of budget.',
    });
    expect(failed.task.allowedActions).toContain('retry');

    const retried = await client.retryTask(task.id);
    expect(retried).toMatchObject({ stage: 'work', state: 'running' });
    expect((await client.getTask(task.id)).executions.at(-1)?.request).toBe('Try harder');

    const stopped = await client.stopTask(task.id);
    expect(stopped).toMatchObject({ state: 'idle', stateReason: 'Stopped.' });
    expect((await client.getTask(task.id)).executions.at(-1)?.status).toBe('stopped');
    expect(completeMockWork(task.id)).toBe(false);
  });

  it('failed checks block Apply (409 checks_failed) until a passing run of the checks', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, {
      title: 'Fix',
      workflowId: team.id,
      finishLine: 'apply_local',
    });
    failNextChecks();
    await client.workTask(task.id);
    completeMockWork(task.id);
    const detail = await client.getTask(task.id);
    expect(detail.checks[0]).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(headChecksFailed(detail.checks, detail.workspace!.headSha)).toBe(true);

    const destination = { folderPath: project.folderPath, branch: 'main' };
    expect(await failure(client.applyTask(task.id, { destination }))).toMatchObject({
      status: 409,
      code: 'checks_failed',
    });

    await client.runTaskChecks(task.id);
    const rechecked = await client.getTask(task.id);
    expect(headChecksFailed(rechecked.checks, rechecked.workspace!.headSha)).toBe(false);
    expect((await client.applyTask(task.id, { destination })).outcome).toBe('applied');
  });

  it('a merge conflict fails the task in review; Retry brings it back to review', async () => {
    const { project, team } = seed({ checks: false });
    const task = await client.createTask(project.id, {
      title: 'Fix',
      workflowId: team.id,
      finishLine: 'apply_local',
    });
    await client.workTask(task.id);
    completeMockWork(task.id);
    failNextApply();
    const failed = await client.applyTask(task.id, {
      destination: { folderPath: project.folderPath, branch: 'main' },
    });
    expect(failed).toMatchObject({ stage: 'review', state: 'failed' });
    expect((await client.getTask(task.id)).deliveries[0]?.status).toBe('failed');
    expect(await client.retryTask(task.id)).toMatchObject({ stage: 'review', state: 'idle' });
  });

  it('a project that never named checks gets the stand-in check; [] means none', async () => {
    const { project, team } = seed({ checks: false });
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    await client.workTask(task.id);
    completeMockWork(task.id);
    expect((await client.getTask(task.id)).checks.map((check) => check.command)).toEqual([
      'npm test',
    ]);

    await client.updateProject(project.id, { checkCommands: [] });
    const second = await client.createTask(project.id, { title: 'Two', workflowId: team.id });
    await client.workTask(second.id);
    completeMockWork(second.id);
    const detail = await client.getTask(second.id);
    expect(detail.checks).toEqual([]);
    expect(detail.task.allowedActions).not.toContain('checks');
  });
});

describe('ACE-P0 capacity, pause and Autopilot (design §2.2, §2.3)', () => {
  it('queues work over the project’s Build capacity and starts it when a slot frees', async () => {
    const { project, team } = seed();
    await client.updateProject(project.id, { buildCapacity: 1 });
    const a = await client.createTask(project.id, { title: 'A', workflowId: team.id });
    const b = await client.createTask(project.id, { title: 'B', workflowId: team.id });
    await client.workTask(a.id);
    const queued = await client.workTask(b.id, { message: 'Also B' });
    expect(queued).toMatchObject({
      stage: 'work',
      state: 'queued',
      stateReason: 'Waiting for a Build slot (1 of 1 in use)',
      pendingRequest: 'Also B',
    });

    completeMockWork(a.id);
    const started = await client.getTask(b.id);
    expect(started.task).toMatchObject({ state: 'running' });
    expect(started.task.pendingRequest).toBeUndefined();
    expect(started.executions[0]?.request).toBe('Also B');
  });

  it('a paused project takes no automatic step; resuming it dequeues', async () => {
    const { project, team } = seed();
    await client.updateProject(project.id, { buildCapacity: 1, paused: true });
    const a = await client.createTask(project.id, { title: 'A', workflowId: team.id });
    // start is explicit, but the automatic step into work waits while the project is paused
    expect(await client.startTask(a.id)).toMatchObject({ stage: 'plan', state: 'idle' });

    const b = await client.createTask(project.id, { title: 'B', workflowId: team.id });
    await client.workTask(a.id);
    expect(await client.workTask(b.id)).toMatchObject({ state: 'queued' });
    completeMockWork(a.id);
    expect((await client.getTask(b.id)).task.state).toBe('queued');

    const resumed = await client.updateProject(project.id, { paused: false });
    expect(resumed.paused).toBe(false);
    expect((await client.getTask(b.id)).task.state).toBe('running');
  });

  it('Autopilot waits unless Full access; under Full access it applies by itself', async () => {
    const { project, team } = seed();
    const waiting = await client.createTask(project.id, {
      title: 'Wait',
      workflowId: team.id,
      automation: 'autopilot',
      finishLine: 'apply_local',
    });
    await client.workTask(waiting.id);
    completeMockWork(waiting.id);
    expect((await client.getTask(waiting.id)).task).toMatchObject({
      stage: 'review',
      stateReason: 'Autopilot is waiting: the approval mode is not Full access.',
    });

    expect((await client.patchSettings({ approvalMode: 'full_access' })).approvalMode).toBe(
      'full_access',
    );
    const auto = await client.createTask(project.id, {
      title: 'Auto',
      workflowId: team.id,
      automation: 'autopilot',
      finishLine: 'apply_local',
    });
    await client.workTask(auto.id);
    completeMockWork(auto.id);
    expect((await client.getTask(auto.id)).task).toMatchObject({
      stage: 'done',
      outcome: 'applied',
    });
  });

  it('the project PATCH takes the Build fields; null clears the setup command', async () => {
    const { project } = seed({ checks: false });
    const patched = await client.updateProject(project.id, {
      buildCapacity: 3,
      checkCommands: [{ name: 'lint', command: 'pnpm lint' }],
      setupCommand: 'pnpm install',
      paused: true,
    });
    expect(patched).toMatchObject({
      buildCapacity: 3,
      checkCommands: [{ name: 'lint', command: 'pnpm lint' }],
      setupCommand: 'pnpm install',
      paused: true,
    });
    const cleared = await client.updateProject(project.id, { setupCommand: null });
    expect(cleared.setupCommand).toBeUndefined();
    expect(await failure(client.updateProject(project.id, { buildCapacity: 9 }))).toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('ACE-P0 repository (design §6)', () => {
  it('a plain folder is not a repository, refuses work, and Initialize Git makes it one', async () => {
    const { project, team } = seed({ folderPath: '/mock/no-git/shop' });
    expect(await client.getRepository(project.id)).toEqual({
      folderPath: '/mock/no-git/shop',
      gitAvailable: true,
      isRepo: false,
    });
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    expect(await failure(client.workTask(task.id))).toMatchObject({
      status: 422,
      code: 'not_a_repository',
    });

    const repo = await client.initRepository(project.id);
    expect(repo).toMatchObject({ isRepo: true, branch: 'main', clean: true });
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await failure(client.initRepository(project.id))).toMatchObject({
      status: 409,
      code: 'already_repository',
    });
    expect(await client.workTask(task.id)).toMatchObject({ state: 'running' });
  });

  it('a task without a team cannot start work: 422 no_team', async () => {
    const { project } = seed();
    const task = await client.createTask(project.id, { title: 'Fix' });
    expect(await failure(client.workTask(task.id))).toMatchObject({
      status: 422,
      code: 'no_team',
    });
  });

  it('the work pace completes a run by itself', async () => {
    const { project, team } = seed();
    setTaskWorkPace(1);
    const task = await client.createTask(project.id, { title: 'Fix', workflowId: team.id });
    await client.workTask(task.id);
    await vi.waitFor(async () => expect((await client.getTask(task.id)).task.stage).toBe('review'));
  });
});

describe('ACE-P0 allowed actions (design §2.1)', () => {
  const base = {
    type: 'app' as const,
    finishLine: 'apply_local' as const,
    paused: false,
    workflowId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    plannerWorkflowId: undefined,
  };
  const context: TaskActionContext = {
    hasLiveRun: false,
    projectHasChecks: true,
    workspace: undefined,
  };
  const actions = (fields: Partial<Task>, ctx: Partial<TaskActionContext> = {}): TaskAction[] =>
    allowedTaskActions(
      { ...base, stage: 'inbox', state: 'idle', ...fields } as Parameters<
        typeof allowedTaskActions
      >[0],
      { ...context, ...ctx },
    );

  it('inbox idle; running with a run; failed; review with a ready workspace; done', () => {
    expect(actions({})).toEqual(['start', 'work', 'close', 'pause', 'move', 'delete']);
    expect(actions({ stage: 'work', state: 'running' }, { hasLiveRun: true })).toEqual([
      'stop',
      'pause',
    ]);
    expect(actions({ stage: 'work', state: 'failed', paused: true })).toEqual([
      'work',
      'retry',
      'close',
      'resume',
      'move',
      'delete',
    ]);
    expect(actions({ stage: 'review', state: 'idle' }, { workspace: { status: 'ready' } })).toEqual(
      ['work', 'checks', 'approve', 'request_changes', 'apply', 'close', 'pause', 'move', 'delete'],
    );
    expect(actions({ stage: 'review', state: 'idle', finishLine: 'review' })).not.toContain(
      'apply',
    );
    expect(actions({ stage: 'done', state: 'done' })).toEqual(['delete']);
    expect(actions({ plannerWorkflowId: '01ARZ3NDEKTSV4RRFFQ69G5FAX' })).toContain('plan');
    expect(TaskSchema.shape.allowedActions.safeParse(actions({})).success).toBe(true);
  });
});
