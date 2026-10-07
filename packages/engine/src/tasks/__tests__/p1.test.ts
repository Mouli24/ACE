import type { Task } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../gateway/errors.js';
import { createTaskHarness, file, type TaskHarness } from './harness.js';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function toReview(
  h: TaskHarness,
  body: Parameters<TaskHarness['service']['create']>[1],
  text = 'Done.',
): Promise<Task> {
  const task = await h.service.create(h.project.id, {
    workflowId: h.team.id,
    start: 'now',
    ...body,
  });
  await h.settle();
  await h.finishRun(h.lastRunId(), 'COMPLETE', {
    text,
    ...(body.type === undefined || body.type === 'app' ? { changes: [file('src/a.ts')] } : {}),
  });
  return (await h.service.get(task.id)).task;
}

describe('D275 Document tasks', () => {
  it('writes the document from the run and accepts it into the project folder', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(
      h,
      {
        title: 'Release notes',
        type: 'document',
        documentPath: 'docs/notes.md',
        finishLine: 'accept_document',
      },
      '# Release notes\n\nEverything changed.',
    );
    const prompt = JSON.stringify(h.runs.get(h.lastRunId())?.request.inputs);
    expect(prompt).toContain('## What to produce');
    expect(prompt).toContain('docs/notes.md');
    expect(reviewed).toMatchObject({ stage: 'review', state: 'idle' });
    expect(reviewed.deliverable).toEqual({
      kind: 'document',
      path: 'docs/notes.md',
      content: '# Release notes\n\nEverything changed.',
    });
    expect(reviewed.allowedActions).toContain('accept');
    expect(reviewed.allowedActions).not.toContain('apply');
    expect((await h.service.get(reviewed.id)).workspace).toBeUndefined();

    const accepted = await h.service.accept(reviewed.id, { path: 'docs/notes.md' });
    expect(accepted).toMatchObject({ stage: 'done', outcome: 'accepted' });
    const written = [...h.files.written.entries()];
    expect(written).toHaveLength(1);
    expect(written[0]?.[0].replace(/\\/g, '/')).toBe('D:/repos/shop/docs/notes.md');
    expect(written[0]?.[1]).toContain('Everything changed.');
    expect(h.repos.deliveryRows.at(-1)).toMatchObject({
      kind: 'document_accept',
      status: 'succeeded',
    });
  });

  it('never overwrites a file, refuses a moved destination and a path outside the project', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(h, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      finishLine: 'accept_document',
    });
    expect(await codeOf(h.service.accept(reviewed.id, { path: 'other.md' }))).toBe(
      'destination_changed',
    );
    h.files.outside = true;
    expect(await codeOf(h.service.accept(reviewed.id, {}))).toBe('invalid_path');
    h.files.outside = false;
    h.files.existing.add('D:\\repos\\shop\\notes.md');
    h.files.existing.add('D:/repos/shop/notes.md');
    expect(await codeOf(h.service.accept(reviewed.id, {}))).toBe('file_exists');
    expect((await h.service.get(reviewed.id)).task.stage).toBe('review');
  });

  it('keeps an edit of the draft, but not while a run is going', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(h, {
      title: 'Notes',
      type: 'document',
      documentPath: 'notes.md',
      finishLine: 'accept_document',
    });
    const edited = await h.service.putDeliverable(reviewed.id, {
      deliverable: { kind: 'document', path: 'docs/final.md', content: '# Final' },
    });
    expect(edited.deliverable).toEqual({
      kind: 'document',
      path: 'docs/final.md',
      content: '# Final',
    });
    expect(
      await codeOf(
        h.service.putDeliverable(reviewed.id, {
          deliverable: { kind: 'email', to: [], cc: [], subject: 'x', body: 'y' },
        }),
      ),
    ).toBe('validation_failed');

    await h.service.review(reviewed.id, { decision: 'changes_requested', note: 'Shorter.' });
    expect(
      await codeOf(
        h.service.putDeliverable(reviewed.id, {
          deliverable: { kind: 'document', path: 'docs/final.md', content: 'x' },
        }),
      ),
    ).toBe('invalid_task_state');
    // The follow-up run is shown the current draft to revise.
    await h.settle();
    expect(JSON.stringify(h.runs.get(h.lastRunId())?.request.inputs)).toContain('# Final');
  });
});

describe('D275 Email tasks', () => {
  it('takes a proposed subject, accepts the draft and never pretends to send', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(
      h,
      {
        title: 'Reply to Ann',
        type: 'email',
        emailTo: ['ann@example.com'],
        finishLine: 'accept_draft',
      },
      'Subject: About your order\n\nHi Ann,\nIt ships today.',
    );
    expect(reviewed.deliverable).toEqual({
      kind: 'email',
      to: ['ann@example.com'],
      cc: [],
      subject: 'About your order',
      body: 'Hi Ann,\nIt ships today.',
    });
    const accepted = await h.service.accept(reviewed.id, {});
    expect(accepted).toMatchObject({ stage: 'done', outcome: 'accepted' });
    expect(h.repos.deliveryRows.at(-1)).toMatchObject({
      kind: 'email_accept',
      destination: 'ann@example.com',
    });

    const sending = await toReview(h, {
      title: 'Send it',
      type: 'email',
      emailTo: ['bo@example.com'],
      finishLine: 'send_email',
    });
    expect(sending.allowedActions).toContain('send');
    expect(await codeOf(h.service.send(sending.id))).toBe('not_connected');
    expect((await h.service.get(sending.id)).task.stage).toBe('review');
    // What the refusal says to do is possible: accept the draft and send it by hand.
    expect(sending.allowedActions).toContain('accept');
    expect(await h.service.accept(sending.id, {})).toMatchObject({
      stage: 'done',
      outcome: 'accepted',
    });
  });
});

describe('D276 GitHub delivery', () => {
  const remote = (h: TaskHarness): void => {
    h.git.status = { ...h.git.status, remoteUrl: 'https://github.com/acme/shop.git' };
  };

  it('opens a pull request, then merges it only into the confirmed destination', async () => {
    const h = await createTaskHarness();
    remote(h);
    const reviewed = await toReview(h, { title: 'Search', finishLine: 'github_merge' });
    expect(reviewed.allowedActions).toContain('open_pr');
    expect(reviewed.allowedActions).not.toContain('apply');

    const opened = await h.service.openPullRequest(reviewed.id, {});
    expect(opened).toMatchObject({ stage: 'review', state: 'idle' });
    expect(opened.stateReason).toContain('#7');
    expect(opened.allowedActions).toContain('merge_pr');
    const workspace = (await h.service.get(reviewed.id)).workspace;
    expect(workspace?.pullRequest).toMatchObject({
      number: 7,
      state: 'open',
      base: 'main',
      repo: 'acme/shop',
    });
    expect(h.github.calls[0]).toBe(`push:${workspace?.branch}`);
    expect(h.repos.deliveryRows.at(-1)).toMatchObject({ kind: 'github_pr', status: 'succeeded' });

    expect(
      await codeOf(
        h.service.mergePullRequest(reviewed.id, {
          method: 'squash',
          confirm: { repo: 'acme/other', base: 'main' },
        }),
      ),
    ).toBe('destination_changed');
    const merged = await h.service.mergePullRequest(reviewed.id, {
      method: 'squash',
      confirm: { repo: 'acme/shop', base: 'main' },
    });
    expect(merged).toMatchObject({ stage: 'done', outcome: 'merged' });
    expect(h.github.calls).toContain('merge:7:squash');
    const after = await h.service.get(reviewed.id);
    expect(after.workspace?.status).toBe('merged');
    expect(h.git.removed).toContain(workspace?.path);
    expect(after.deliveries.at(-1)).toMatchObject({
      kind: 'github_merge',
      status: 'succeeded',
      sha: 'c'.repeat(40),
    });
  });

  it('records an unconfirmed merge as uncertain and stays in review', async () => {
    const h = await createTaskHarness();
    remote(h);
    const reviewed = await toReview(h, { title: 'Search', finishLine: 'github_merge' });
    await h.service.openPullRequest(reviewed.id, {});
    h.github.mergedState = 'open';
    const waiting = await h.service.mergePullRequest(reviewed.id, {
      method: 'merge',
      confirm: { repo: 'acme/shop', base: 'main' },
    });
    expect(waiting).toMatchObject({ stage: 'review', state: 'idle' });
    expect(waiting.stateReason).toContain('not confirmed');
    expect(h.repos.deliveryRows.at(-1)).toMatchObject({
      kind: 'github_merge',
      status: 'uncertain',
    });
  });

  it('says what is missing: a GitHub remote, a signed-in gh, a push that works', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(h, { title: 'Search', finishLine: 'github_merge' });
    expect(await codeOf(h.service.openPullRequest(reviewed.id, {}))).toBe('not_connected');
    remote(h);
    h.github.statusValue = {
      installed: true,
      loggedIn: false,
      detail: 'Run gh auth login in a terminal',
    };
    expect(await codeOf(h.service.openPullRequest(reviewed.id, {}))).toBe('not_connected');
    h.github.statusValue = { installed: true, loggedIn: true };
    h.github.failPush = new Error('rejected: non-fast-forward');
    const failed = await h.service.openPullRequest(reviewed.id, {});
    expect(failed).toMatchObject({ stage: 'review', state: 'failed' });
    expect(failed.stateReason).toContain('non-fast-forward');
  });

  it('clones a GitHub repository into a new project', async () => {
    const h = await createTaskHarness();
    const project = await h.service.cloneProject({ repo: 'acme/storefront' });
    expect(project.name).toBe('storefront');
    expect(project.folderPath.replace(/\\/g, '/')).toBe('D:/repos/storefront');
    expect(h.github.calls).toContain(`clone:acme/storefront->${project.folderPath}`);
  });
});

describe('D278 previews', () => {
  it('runs the project preview command in the worktree on a free port', async () => {
    const h = await createTaskHarness({
      projectPatch: {
        previewCommand: 'pnpm dev --port $PORT',
        previewUrl: 'http://localhost:{port}/app',
      },
    });
    const reviewed = await toReview(h, { title: 'Search' });
    expect(reviewed.allowedActions).toContain('preview');
    const workspace = (await h.service.get(reviewed.id)).workspace;

    await h.service.startPreview(reviewed.id);
    expect(h.preview.started[0]).toMatchObject({
      command: 'pnpm dev --port $PORT',
      cwd: workspace?.path,
    });
    expect(h.preview.started[0]?.env?.['PORT']).toBe('5199');
    const preview = (await h.service.get(reviewed.id)).preview;
    expect(preview).toMatchObject({
      status: 'running',
      port: 5199,
      url: 'http://localhost:5199/app',
    });
    expect(preview?.output).toBe('ready on token [REDACTED]');

    await h.service.stopPreview(reviewed.id);
    await h.settle();
    expect((await h.service.get(reviewed.id)).preview?.status).toBe('stopped');

    await h.service.startPreview(reviewed.id);
    h.preview.processes.at(-1)?.exit(1);
    await h.settle();
    expect((await h.service.get(reviewed.id)).preview).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
  });

  it('is not offered without a preview command', async () => {
    const h = await createTaskHarness();
    const reviewed = await toReview(h, { title: 'Search' });
    expect(reviewed.allowedActions).not.toContain('preview');
    expect(await codeOf(h.service.startPreview(reviewed.id))).toBe('invalid_task_state');
  });
});

describe('D277 schedules', () => {
  it('starts a task once at its time', async () => {
    const h = await createTaskHarness({ clock: '2026-10-07T08:00:00.000Z' });
    const task = await h.service.create(h.project.id, {
      title: 'Nightly',
      workflowId: h.team.id,
      trigger: { kind: 'once', at: '2026-10-07T09:00:00.000Z' },
    });
    expect(task).toMatchObject({ stage: 'inbox', state: 'idle' });
    expect(task.stateReason).toContain('Scheduled for');
    expect((await h.service.get(task.id)).schedule).toMatchObject({
      enabled: true,
      nextRunAt: '2026-10-07T09:00:00.000Z',
    });

    await h.service.tickSchedules();
    expect((await h.service.get(task.id)).task.stage).toBe('inbox');
    h.clock.now = '2026-10-07T09:00:10.000Z';
    await h.service.tickSchedules();
    await h.settle();
    const started = await h.service.get(task.id);
    expect(started.task).toMatchObject({ stage: 'work', state: 'running' });
    expect(started.schedule?.enabled).toBe(false);
  });

  it('makes a new task per recurring occurrence and skips one while the last is not done', async () => {
    const h = await createTaskHarness({ clock: '2026-10-07T08:00:00.000Z' });
    const template = await h.service.create(h.project.id, {
      title: 'Daily triage',
      workflowId: h.team.id,
      trigger: { kind: 'recurring', cron: '0 9 * * *', timezone: 'UTC' },
    });
    expect((await h.service.get(template.id)).schedule?.nextRunAt).toBe('2026-10-07T09:00:00.000Z');

    h.clock.now = '2026-10-07T09:00:30.000Z';
    await h.service.tickSchedules();
    await h.settle();
    const tasks = await h.service.list(h.project.id, {});
    const occurrence = tasks.find((task) => task.id !== template.id);
    expect(occurrence).toMatchObject({ title: 'Daily triage · 2026-10-07', stage: 'work' });
    expect(occurrence?.source).toEqual({
      kind: 'schedule',
      refId: template.id,
      label: 'Daily triage',
    });
    expect((await h.service.get(template.id)).task.stage).toBe('inbox');
    expect((await h.service.get(template.id)).schedule?.nextRunAt).toBe('2026-10-08T09:00:00.000Z');

    h.clock.now = '2026-10-08T09:00:30.000Z';
    await h.service.tickSchedules();
    const after = await h.service.get(template.id);
    expect(after.schedule?.skipped).toBe(1);
    expect(after.task.stateReason).toContain('not Done');
    expect((await h.service.list(h.project.id, {})).length).toBe(2);
  });

  it('starts a task when the task it waits on reaches its finish line', async () => {
    const h = await createTaskHarness();
    const first = await toReview(h, { title: 'First' });
    const second = await h.service.create(h.project.id, {
      title: 'Second',
      workflowId: h.team.id,
      trigger: { kind: 'after_task', taskId: first.id },
    });
    expect(second.stateReason).toContain('waits on');
    await h.service.review(first.id, { decision: 'approved' });
    await h.settle();
    expect((await h.service.get(second.id)).task).toMatchObject({
      stage: 'work',
      state: 'running',
    });
  });

  it('skips what it missed while the engine was stopped', async () => {
    const h = await createTaskHarness({ clock: '2026-10-07T08:00:00.000Z' });
    const task = await h.service.create(h.project.id, {
      title: 'Once',
      workflowId: h.team.id,
      trigger: { kind: 'once', at: '2026-10-07T09:00:00.000Z' },
    });
    h.detach();
    h.clock.now = '2026-10-07T12:00:00.000Z';
    const detach = await h.service.attach();
    await h.settle();
    const missed = await h.service.get(task.id);
    expect(missed.schedule).toMatchObject({ enabled: false, skipped: 1 });
    expect(missed.task).toMatchObject({ stage: 'inbox', state: 'idle' });
    expect(missed.task.stateReason).toContain('Missed');
    detach();
  });

  it('refuses a schedule that cannot fire', async () => {
    const h = await createTaskHarness({ clock: '2026-10-07T08:00:00.000Z' });
    const task = await h.service.create(h.project.id, { title: 'x', workflowId: h.team.id });
    expect(
      await codeOf(
        h.service.putSchedule(task.id, {
          trigger: { kind: 'once', at: '2026-10-07T07:00:00.000Z' },
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await codeOf(
        h.service.putSchedule(task.id, {
          trigger: { kind: 'recurring', cron: '0 9 31 2 *', timezone: 'UTC' },
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await codeOf(
        h.service.putSchedule(task.id, {
          trigger: { kind: 'recurring', cron: '0 9 * * *', timezone: 'Mars/Base' },
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await codeOf(
        h.service.putSchedule(task.id, { trigger: { kind: 'after_task', taskId: task.id } }),
      ),
    ).toBe('validation_failed');
    await h.service.putSchedule(task.id, {
      trigger: { kind: 'once', at: '2026-10-07T10:00:00.000Z' },
    });
    await h.service.removeSchedule(task.id);
    expect((await h.service.get(task.id)).schedule).toBeUndefined();
  });

  it('creates no task when the trigger it was created with is refused', async () => {
    const h = await createTaskHarness({ clock: '2026-10-07T08:00:00.000Z' });
    const before = (await h.service.list(h.project.id, {})).length;
    expect(
      await codeOf(
        h.service.create(h.project.id, {
          title: 'Yesterday',
          workflowId: h.team.id,
          trigger: { kind: 'once', at: '2026-10-06T08:00:00.000Z' },
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await codeOf(
        h.service.create(h.project.id, {
          title: 'After nothing',
          workflowId: h.team.id,
          trigger: { kind: 'after_task', taskId: '01J0000000000000000000NONE' },
        }),
      ),
    ).toBe('validation_failed');
    expect(await h.service.list(h.project.id, {})).toHaveLength(before);
  });
});

describe('Send to Build — a task from a chat reports back', () => {
  it('posts its outcome on the source workflow’s timeline', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h, {
      title: 'From chat',
      source: { kind: 'chat', workflowId: h.team.id, label: 'Builder' },
    });
    expect(task.source).toMatchObject({ kind: 'chat', workflowId: h.team.id });
    expect(h.repos.activityRows.find((row) => row.taskId === task.id)?.message).toBe(
      'Task created from a chat message.',
    );
    await h.service.review(task.id, { decision: 'approved' });
    await h.settle();
    expect(h.notes).toEqual([
      { workflowId: h.team.id, text: 'Task #1 "From chat" reached Done: reviewed.' },
    ]);
  });
});
