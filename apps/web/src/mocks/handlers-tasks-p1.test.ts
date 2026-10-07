import type { CreateTaskRequest, Task } from '@ace/contracts';
import { createAceClient, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { MockDb } from './db';
import { createHandlers } from './handlers';
import { createRound2Handlers } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createRound4Handlers } from './handlers-round4';
import { createRound5Handlers } from './handlers-round5';
import { createTaskHandlers } from './handlers-tasks';
import {
  completeMockWork,
  exitMockPreview,
  failNextChecks,
  failNextClone,
  failNextMerge,
  failNextPush,
  resetMockTasks,
  setMockGitHub,
  setTaskWorkPace,
  tickMockSchedules,
} from './tasks';

/**
 * The ACE parity P1 MSW seam (D275–D278): deliverables, accept and send, GitHub delivery and
 * clone, previews and schedules — through the real SDK, so every reply is parsed with the contract
 * the engine must satisfy, with the engine's refusals and messages (packages/engine/src/tasks).
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

function seed(patch: Parameters<MockDb['updateProject']>[1] = {}) {
  const project = db.createProject({ name: 'Shop', folderPath: '/mock/projects/shop' });
  db.updateProject(project.id, {
    checkCommands: [{ name: 'test', command: 'pnpm test' }],
    ...patch,
  });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

/** Create, run and land the task in Review, the way the engine's p1 tests do. */
async function toReview(projectId: string, body: CreateTaskRequest): Promise<Task> {
  const task = await client.createTask(projectId, { start: 'now', ...body });
  expect(completeMockWork(task.id)).toBe(true);
  return (await client.getTask(task.id)).task;
}

const HOUR = 3_600_000;

describe('ACE-P1 D275 Document tasks', () => {
  it('the run writes the document; Accept saves it into the project folder', async () => {
    const { project, team } = seed();
    const reviewed = await toReview(project.id, {
      title: 'Release notes',
      type: 'document',
      documentPath: 'docs/notes.md',
      finishLine: 'accept_document',
      workflowId: team.id,
    });
    expect(reviewed).toMatchObject({ stage: 'review', state: 'idle' });
    expect(reviewed.deliverable).toMatchObject({ kind: 'document', path: 'docs/notes.md' });
    expect(reviewed.deliverable?.kind === 'document' && reviewed.deliverable.content).toContain(
      '# Release notes',
    );
    expect(reviewed.allowedActions).toContain('accept');
    expect(reviewed.allowedActions).not.toContain('apply');
    expect((await client.getTask(reviewed.id)).workspace).toBeUndefined();

    const accepted = await client.acceptTask(reviewed.id, { path: 'docs/notes.md' });
    expect(accepted).toMatchObject({ stage: 'done', state: 'done', outcome: 'accepted' });
    expect(db.projectFileOf(project.id, 'docs/notes.md')).toContain('Café Nord');
    const detail = await client.getTask(reviewed.id);
    expect(detail.deliveries.at(-1)).toMatchObject({
      kind: 'document_accept',
      status: 'succeeded',
      destination: '/mock/projects/shop/docs/notes.md',
    });
    expect((await client.listTaskActivity(reviewed.id)).items.at(-1)?.message).toBe(
      'Document accepted as docs/notes.md.',
    );
  });

  it('never overwrites a file and refuses a moved destination; an edit moves it', async () => {
    const { project, team } = seed();
    db.writeProjectFile(project.id, 'notes.md', '# Already here');
    const reviewed = await toReview(project.id, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      workflowId: team.id,
    });
    expect(await failure(client.acceptTask(reviewed.id, { path: 'other.md' }))).toMatchObject({
      status: 409,
      code: 'destination_changed',
      message:
        'The document is now set to be saved as notes.md, not other.md. Check it and accept again.',
    });
    const exists = await failure(client.acceptTask(reviewed.id, { path: 'notes.md' }));
    expect(exists).toMatchObject({
      status: 409,
      code: 'file_exists',
      details: { path: 'notes.md' },
    });
    expect(exists.message).toBe(
      'notes.md already exists in the project folder; ACE never overwrites a file on accept. Choose another path.',
    );
    expect(db.projectFileOf(project.id, 'notes.md')).toBe('# Already here');
    expect((await client.getTask(reviewed.id)).task.stage).toBe('review');

    const edited = await client.putTaskDeliverable(reviewed.id, {
      deliverable: { kind: 'document', path: 'docs/final.md', content: '# Final' },
    });
    expect(edited.deliverable).toEqual({
      kind: 'document',
      path: 'docs/final.md',
      content: '# Final',
    });
    await client.acceptTask(reviewed.id, { path: 'docs/final.md' });
    expect(db.projectFileOf(project.id, 'docs/final.md')).toBe('# Final');
  });

  it('refuses an edit of another kind (400) and while a run is going (409)', async () => {
    const { project, team } = seed();
    const reviewed = await toReview(project.id, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      workflowId: team.id,
    });
    expect(
      await failure(
        client.putTaskDeliverable(reviewed.id, {
          deliverable: { kind: 'email', to: [], cc: [], subject: 'x', body: 'y' },
        }),
      ),
    ).toMatchObject({
      status: 400,
      code: 'validation_failed',
      message: 'Task #1 has no email to edit.',
    });

    await client.reviewTask(reviewed.id, { decision: 'changes_requested', note: 'Shorter.' });
    expect(
      await failure(
        client.putTaskDeliverable(reviewed.id, {
          deliverable: { kind: 'document', path: 'notes.md', content: 'x' },
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'invalid_task_state',
      message: 'Task #1 is work / running; its draft cannot be edited now.',
    });
  });
});

describe('ACE-P1 D275 Email tasks', () => {
  it('takes the proposed subject, accepts the draft and never pretends to send', async () => {
    const { project, team } = seed();
    const reviewed = await toReview(project.id, {
      title: 'Reply to Ann',
      type: 'email',
      emailTo: ['ann@example.com'],
      workflowId: team.id,
    });
    expect(reviewed.finishLine).toBe('accept_draft');
    expect(reviewed.deliverable).toMatchObject({
      kind: 'email',
      to: ['ann@example.com'],
      cc: [],
      subject: 'An update on your order',
    });
    expect(reviewed.deliverable?.kind === 'email' && reviewed.deliverable.body).toMatch(/^Hi,/);
    const accepted = await client.acceptTask(reviewed.id);
    expect(accepted).toMatchObject({ stage: 'done', outcome: 'accepted' });
    expect((await client.getTask(reviewed.id)).deliveries.at(-1)).toMatchObject({
      kind: 'email_accept',
      destination: 'ann@example.com',
      detail: 'Draft accepted: "An update on your order". It was not sent.',
    });

    const sending = await toReview(project.id, {
      title: 'Send it',
      type: 'email',
      emailTo: ['bo@example.com'],
      finishLine: 'send_email',
      workflowId: team.id,
    });
    expect(sending.allowedActions).toContain('send');
    expect(sending.allowedActions).toContain('accept');
    const refused = await failure(client.sendTask(sending.id));
    expect(refused).toMatchObject({ status: 422, code: 'not_connected' });
    expect(refused.message).toContain('Sending needs an email connection');
    expect((await client.getTask(sending.id)).task.stage).toBe('review');
  });
});

describe('ACE-P1 D276 GitHub delivery', () => {
  async function opened(projectId: string, teamId: string) {
    const reviewed = await toReview(projectId, {
      title: 'Search',
      finishLine: 'github_merge',
      workflowId: teamId,
    });
    expect(reviewed.allowedActions).toContain('open_pr');
    expect(reviewed.allowedActions).not.toContain('apply');
    const task = await client.openTaskPullRequest(reviewed.id, { title: 'Search', draft: false });
    return task;
  }

  it('the repository reports its GitHub origin', async () => {
    const { project } = seed();
    expect(await client.getRepository(project.id)).toMatchObject({
      remoteUrl: 'https://github.com/mock/shop.git',
      github: { owner: 'mock', repo: 'shop' },
    });
  });

  it('opens a pull request, then merges it only into the confirmed destination', async () => {
    const { project, team } = seed();
    const task = await opened(project.id, team.id);
    expect(task).toMatchObject({ stage: 'review', state: 'idle' });
    expect(task.stateReason).toContain('#1');
    expect(task.allowedActions).toContain('merge_pr');
    const pr = (await client.getTask(task.id)).workspace?.pullRequest;
    expect(pr).toEqual({
      number: 1,
      url: 'https://github.com/mock/shop/pull/1',
      state: 'open',
      base: 'main',
      repo: 'mock/shop',
    });

    const moved = await failure(
      client.mergeTaskPullRequest(task.id, {
        method: 'squash',
        confirm: { repo: 'mock/other', base: 'main' },
      }),
    );
    expect(moved).toMatchObject({
      status: 409,
      code: 'destination_changed',
      message: 'Pull request #1 merges into mock/shop @ main, not the destination you confirmed.',
    });
    const merged = await client.mergeTaskPullRequest(task.id, {
      method: 'squash',
      confirm: { repo: 'mock/shop', base: 'main' },
    });
    expect(merged).toMatchObject({ stage: 'done', outcome: 'merged' });
    const after = await client.getTask(task.id);
    expect(after.workspace).toMatchObject({ status: 'merged', pullRequest: { state: 'merged' } });
    expect(after.deliveries.at(-1)).toMatchObject({
      kind: 'github_merge',
      status: 'succeeded',
      url: 'https://github.com/mock/shop/pull/1',
    });
  });

  it('records an unconfirmed merge as uncertain and stays in review; a failed one is retried', async () => {
    const { project, team } = seed();
    const task = await opened(project.id, team.id);
    failNextMerge('uncertain');
    const confirm = { repo: 'mock/shop', base: 'main' };
    const waiting = await client.mergeTaskPullRequest(task.id, { method: 'merge', confirm });
    expect(waiting).toMatchObject({ stage: 'review', state: 'idle' });
    expect(waiting.stateReason).toBe(
      'GitHub has not confirmed the merge of #1 (it is open). Check it on GitHub, then try Merge again.',
    );
    expect((await client.getTask(task.id)).deliveries.at(-1)).toMatchObject({
      kind: 'github_merge',
      status: 'uncertain',
    });

    failNextMerge('failed');
    const failed = await client.mergeTaskPullRequest(task.id, { method: 'merge', confirm });
    expect(failed).toMatchObject({ stage: 'review', state: 'failed' });
    expect(failed.stateReason).toMatch(/^Merging #1 failed:/);
    const retried = await client.retryTask(task.id);
    expect(retried).toMatchObject({ stage: 'review', state: 'idle' });
    expect(await client.mergeTaskPullRequest(task.id, { method: 'rebase', confirm })).toMatchObject(
      { outcome: 'merged' },
    );
  });

  it('says what is missing: a GitHub remote, a signed-in gh, a push that works, passing checks', async () => {
    const { project, team } = seed();
    const reviewed = await toReview(project.id, {
      title: 'Search',
      finishLine: 'github_merge',
      workflowId: team.id,
    });
    setMockGitHub({ remotes: false });
    const noRemote = await failure(client.openTaskPullRequest(reviewed.id));
    expect(noRemote).toMatchObject({ status: 422, code: 'not_connected' });
    expect(noRemote.message).toContain('no GitHub remote named origin');
    setMockGitHub({ remotes: true, signedIn: false });
    expect(await failure(client.openTaskPullRequest(reviewed.id))).toMatchObject({
      status: 422,
      code: 'not_connected',
      message: 'The GitHub CLI is not signed in. Run gh auth login in a terminal.',
    });
    setMockGitHub({ signedIn: true });
    failNextPush('rejected: non-fast-forward');
    const failed = await client.openTaskPullRequest(reviewed.id);
    expect(failed).toMatchObject({ stage: 'review', state: 'failed' });
    expect(failed.stateReason).toContain('non-fast-forward');

    failNextChecks();
    await client.retryTask(reviewed.id);
    await client.runTaskChecks(reviewed.id);
    expect(await failure(client.openTaskPullRequest(reviewed.id))).toMatchObject({
      status: 409,
      code: 'checks_failed',
    });
  });

  it('clones a GitHub repository into a new project (201) with its origin', async () => {
    const project = await client.cloneProject({ repo: 'acme/storefront' });
    expect(project).toMatchObject({ name: 'storefront', folderPath: '/mock/projects/storefront' });
    expect(await client.getRepository(project.id)).toMatchObject({
      isRepo: true,
      branch: 'main',
      github: { owner: 'acme', repo: 'storefront' },
    });
    const named = await client.cloneProject({
      repo: 'https://github.com/acme/api.git',
      name: 'API',
      folderPath: '/mock/elsewhere/api',
    });
    expect(named).toMatchObject({ name: 'API', folderPath: '/mock/elsewhere/api' });

    expect(await failure(client.cloneProject({ repo: 'not a repo' }))).toMatchObject({
      status: 502,
      code: 'delivery_failed',
    });
    failNextClone('repository not found');
    expect(await failure(client.cloneProject({ repo: 'acme/gone' }))).toMatchObject({
      status: 502,
      message: 'Cloning acme/gone failed: repository not found',
    });
    setMockGitHub({ signedIn: false });
    expect(await failure(client.cloneProject({ repo: 'acme/storefront' }))).toMatchObject({
      status: 422,
      code: 'not_connected',
    });
    expect(db.listProjects().map((each) => each.name)).toEqual(['storefront', 'API']);
  });
});

describe('ACE-P1 D278 previews', () => {
  it('runs the preview command on a port, stops it, and reports a crash as failed', async () => {
    const { project, team } = seed({
      previewCommand: 'pnpm dev --port $PORT',
      previewUrl: 'http://localhost:{port}/app',
    });
    const reviewed = await toReview(project.id, { title: 'Search', workflowId: team.id });
    expect(reviewed.allowedActions).toContain('preview');

    await client.startTaskPreview(reviewed.id);
    expect((await client.getTask(reviewed.id)).preview).toMatchObject({
      status: 'running',
      command: 'pnpm dev --port $PORT',
      port: 5199,
      url: 'http://localhost:5199/app',
    });
    await client.stopTaskPreview(reviewed.id);
    expect((await client.getTask(reviewed.id)).preview?.status).toBe('stopped');

    await client.startTaskPreview(reviewed.id);
    expect(exitMockPreview(db, reviewed.id, 1)).toBe(true);
    expect((await client.getTask(reviewed.id)).preview).toMatchObject({
      status: 'failed',
      exitCode: 1,
      port: 5200,
    });
  });

  it('is not offered without a preview command, and a cleared one takes it away', async () => {
    const { project, team } = seed();
    const reviewed = await toReview(project.id, { title: 'Search', workflowId: team.id });
    expect(reviewed.allowedActions).not.toContain('preview');
    expect(await failure(client.startTaskPreview(reviewed.id))).toMatchObject({ status: 409 });

    await client.updateProject(project.id, { previewCommand: 'npm start' });
    expect((await client.getTask(reviewed.id)).task.allowedActions).toContain('preview');
    const cleared = await client.updateProject(project.id, { previewCommand: null });
    expect(cleared.previewCommand).toBeUndefined();
    expect((await client.getTask(reviewed.id)).task.allowedActions).not.toContain('preview');
  });
});

describe('ACE-P1 D277 schedules', () => {
  it('schedules a task once, keeps it in the Inbox, then a tick starts it', async () => {
    const { project, team } = seed();
    const at = new Date(Date.now() + HOUR).toISOString();
    const task = await client.createTask(project.id, {
      title: 'Nightly',
      workflowId: team.id,
      start: 'inbox',
      trigger: { kind: 'once', at },
    });
    expect(task).toMatchObject({
      stage: 'inbox',
      state: 'idle',
      stateReason: `Scheduled for ${at}.`,
    });
    expect((await client.getTask(task.id)).schedule).toMatchObject({
      trigger: { kind: 'once', at },
      enabled: true,
      nextRunAt: at,
      skipped: 0,
    });

    tickMockSchedules(db);
    expect((await client.getTask(task.id)).task.stage).toBe('inbox');
    tickMockSchedules(db, Date.now() + 2 * HOUR);
    const started = await client.getTask(task.id);
    expect(started.task).toMatchObject({ stage: 'work', state: 'running' });
    expect(started.schedule?.enabled).toBe(false);
  });

  it('a recurring template makes a new task per occurrence and skips one while the last runs', async () => {
    const { project, team } = seed();
    const template = await client.createTask(project.id, {
      title: 'Daily triage',
      workflowId: team.id,
      trigger: { kind: 'recurring', cron: '0 9 * * *', timezone: 'UTC' },
    });
    const schedule = (await client.getTask(template.id)).schedule;
    expect(schedule?.nextRunAt).toMatch(/T09:00:00\.000Z$/);
    expect(template.stateReason).toBe(
      `Repeats "0 9 * * *" (UTC) — next ${schedule?.nextRunAt ?? ''}.`,
    );

    const due = Date.parse(schedule?.nextRunAt ?? '') + 30_000;
    tickMockSchedules(db, due);
    const occurrence = db.listTasks(project.id).find((each) => each.id !== template.id);
    expect(occurrence).toMatchObject({ stage: 'work', state: 'running' });
    expect(occurrence?.title).toMatch(/^Daily triage · \d{4}-\d{2}-\d{2}$/);
    expect(occurrence?.source).toEqual({
      kind: 'schedule',
      refId: template.id,
      label: 'Daily triage',
    });

    tickMockSchedules(db, due + 24 * HOUR);
    const after = await client.getTask(template.id);
    expect(after.schedule?.skipped).toBe(1);
    expect(after.task.stateReason).toContain('is not Done yet');
    expect(db.listTasks(project.id)).toHaveLength(2);
  });

  it('starts a task when the task it waits on reaches its finish line', async () => {
    const { project, team } = seed();
    const first = await toReview(project.id, { title: 'First', workflowId: team.id });
    const second = await client.createTask(project.id, {
      title: 'Second',
      workflowId: team.id,
      trigger: { kind: 'after_task', taskId: first.id },
    });
    expect(second.stateReason).toBe('Starts when the task it waits on reaches its finish line.');
    expect((await client.getTask(second.id)).schedule?.nextRunAt).toBeUndefined();
    await client.reviewTask(first.id, { decision: 'approved' });
    expect((await client.getTask(second.id)).task).toMatchObject({
      stage: 'work',
      state: 'running',
    });
  });

  it('refuses a schedule that cannot fire, with the engine’s reasons, and removes one', async () => {
    const { project, team } = seed();
    const task = await client.createTask(project.id, { title: 'x', workflowId: team.id });
    const reason = async (trigger: Parameters<typeof client.putTaskSchedule>[1]['trigger']) => {
      const refused = await failure(client.putTaskSchedule(task.id, { trigger }));
      expect(refused).toMatchObject({ status: 400, code: 'validation_failed' });
      return refused.message;
    };
    expect(await reason({ kind: 'once', at: new Date(Date.now() - HOUR).toISOString() })).toBe(
      'The time must be in the future.',
    );
    expect(await reason({ kind: 'recurring', cron: '0 9 31 2 *', timezone: 'UTC' })).toBe(
      'That cron expression never matches.',
    );
    expect(await reason({ kind: 'recurring', cron: '0 9 * * *', timezone: 'Mars/Base' })).toBe(
      '"Mars/Base" is not a known time zone, such as Europe/London or UTC.',
    );
    expect(await reason({ kind: 'recurring', cron: '0 25 * * *', timezone: 'UTC' })).toBe(
      'The hour field allows 0-23; "25" is outside it.',
    );
    expect(await reason({ kind: 'after_task', taskId: task.id })).toBe(
      'The task to wait on must be another task of this project.',
    );

    const at = new Date(Date.now() + HOUR).toISOString();
    await client.putTaskSchedule(task.id, { trigger: { kind: 'once', at } });
    // a second PUT replaces the trigger of the same schedule
    const replaced = await client.putTaskSchedule(task.id, {
      trigger: { kind: 'recurring', cron: '0 9 * * 1', timezone: 'UTC' },
    });
    expect(db.listTaskSchedules()).toHaveLength(1);
    expect(replaced.trigger).toEqual({ kind: 'recurring', cron: '0 9 * * 1', timezone: 'UTC' });

    await client.deleteTaskSchedule(task.id);
    const detail = await client.getTask(task.id);
    expect(detail.schedule).toBeUndefined();
    expect(detail.task.stateReason).toBeUndefined();
    expect((await client.listTaskActivity(task.id)).items.at(-1)?.message).toBe(
      'Schedule removed.',
    );

    await client.startTask(task.id);
    expect(
      await failure(client.putTaskSchedule(task.id, { trigger: { kind: 'once', at } })),
    ).toMatchObject({
      status: 409,
      code: 'invalid_task_state',
      message: 'Task #1 is work / running; only an Inbox task can be scheduled.',
    });
  });
});

describe('ACE-P1 Send to Build — a task from a chat', () => {
  it('keeps its source and reports its outcome on the workflow timeline', async () => {
    const { project, team } = seed();
    const source = { kind: 'chat' as const, workflowId: team.id, label: 'Builder' };
    const task = await toReview(project.id, { title: 'From chat', workflowId: team.id, source });
    expect(task.source).toEqual(source);
    expect((await client.listTaskActivity(task.id)).items[0]?.message).toBe(
      'Task created from a chat message.',
    );
    await client.reviewTask(task.id, { decision: 'approved' });
    expect(db.messagesOf(team.id).map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'Task #1 "From chat" reached Done: reviewed.' }],
    ]);
  });
});
