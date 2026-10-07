import {
  RepositoryInfoSchema,
  TaskActivityListResponseSchema,
  TaskChangesSchema,
  TaskDetailSchema,
  TaskFileDiffSchema,
  TaskListResponseSchema,
  TaskSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createTaskRoutes } from '../routes.js';
import { createTaskHarness, file } from './harness.js';

describe('ACE parity P0 — task routes', () => {
  it('answers 501 when the engine was built without tasks', async () => {
    const app = routeApp(createTaskRoutes(undefined));
    const response = await send(app, 'GET', '/projects/01JBXQ8Z9KQ4R7N2VWXYZ0PRJC/tasks');
    expect(response.status).toBe(501);
  });

  it('creates, lists, reads and edits a task in the contract shapes', async () => {
    const h = await createTaskHarness();
    const app = routeApp(createTaskRoutes(h.service));

    const created = await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
      title: 'Add search',
      workflowId: h.team.id,
      labels: ['ui'],
    });
    expect(created.status).toBe(201);
    const task = TaskSchema.parse(await created.json());

    const list = await send(app, 'GET', `/projects/${h.project.id}/tasks?label=ui&attention=false`);
    expect(TaskListResponseSchema.parse(await list.json()).items.map((t) => t.id)).toEqual([
      task.id,
    ]);

    const detail = await send(app, 'GET', `/tasks/${task.id}`);
    expect(TaskDetailSchema.parse(await detail.json()).task.id).toBe(task.id);

    const patched = await send(app, 'PATCH', `/tasks/${task.id}`, { priority: 'high' });
    expect(TaskSchema.parse(await patched.json()).priority).toBe('high');

    const activity = await send(app, 'GET', `/tasks/${task.id}/activity`);
    expect(
      TaskActivityListResponseSchema.parse(await activity.json()).items.length,
    ).toBeGreaterThan(0);
  });

  it('refuses a body the contract refuses', async () => {
    const h = await createTaskHarness();
    const app = routeApp(createTaskRoutes(h.service));
    const response = await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
      title: 'x',
      type: 'email',
      finishLine: 'apply_local',
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('validation_failed');
    const stray = await send(app, 'POST', `/projects/${h.project.id}/tasks/nope`, {});
    expect(stray.status).toBe(404);
  });

  it('runs the whole flow over HTTP: start, changes, diff, review, apply', async () => {
    const h = await createTaskHarness();
    const app = routeApp(createTaskRoutes(h.service));
    const created = TaskSchema.parse(
      await (
        await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
          title: 'Add search',
          workflowId: h.team.id,
          finishLine: 'apply_local',
        })
      ).json(),
    );

    const started = await send(app, 'POST', `/tasks/${created.id}/start`);
    expect(TaskSchema.parse(await started.json()).state).toBe('running');
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'ok', changes: [file('a.ts')] });

    const changes = TaskChangesSchema.parse(
      await (await send(app, 'GET', `/tasks/${created.id}/changes`)).json(),
    );
    expect(changes.files.map((f) => f.path)).toEqual(['a.ts']);
    const diff = await send(app, 'GET', `/tasks/${created.id}/changes/diff?path=a.ts`);
    expect(TaskFileDiffSchema.parse(await diff.json()).path).toBe('a.ts');
    expect((await send(app, 'GET', `/tasks/${created.id}/changes/diff`)).status).toBe(400);

    const approved = await send(app, 'POST', `/tasks/${created.id}/review`, {
      decision: 'approved',
      headSha: changes.headSha,
    });
    expect(TaskSchema.parse(await approved.json()).stage).toBe('review');

    const repo = RepositoryInfoSchema.parse(
      await (await send(app, 'GET', `/projects/${h.project.id}/repository`)).json(),
    );
    const applied = await send(app, 'POST', `/tasks/${created.id}/apply`, {
      destination: { folderPath: repo.folderPath, branch: repo.branch },
    });
    expect(TaskSchema.parse(await applied.json())).toMatchObject({
      stage: 'done',
      outcome: 'applied',
    });

    const conflict = await send(app, 'POST', `/tasks/${created.id}/apply`, {
      destination: { folderPath: repo.folderPath, branch: 'main' },
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('invalid_task_state');
  });

  it('closes, pauses, stops a queued task and deletes over HTTP', async () => {
    const h = await createTaskHarness();
    const app = routeApp(createTaskRoutes(h.service));
    const task = TaskSchema.parse(
      await (await send(app, 'POST', `/projects/${h.project.id}/tasks`, { title: 'x' })).json(),
    );
    const paused = await send(app, 'POST', `/tasks/${task.id}/pause`, { paused: true });
    expect(TaskSchema.parse(await paused.json()).paused).toBe(true);
    expect((await send(app, 'POST', `/tasks/${task.id}/pause`, {})).status).toBe(400);
    const closed = await send(app, 'POST', `/tasks/${task.id}/close`);
    expect(TaskSchema.parse(await closed.json()).outcome).toBe('closed_unverified');
    expect((await send(app, 'POST', `/tasks/${task.id}/start`, { extra: 1 })).status).toBe(400);
    expect((await send(app, 'DELETE', `/tasks/${task.id}`)).status).toBe(204);
    expect((await send(app, 'GET', `/tasks/${task.id}`)).status).toBe(404);
  });

  it('initializes a repository and refuses a second time', async () => {
    const h = await createTaskHarness();
    h.git.status = { gitAvailable: true, isRepo: false };
    const app = routeApp(createTaskRoutes(h.service));
    const first = await send(app, 'POST', `/projects/${h.project.id}/repository/init`);
    expect(RepositoryInfoSchema.parse(await first.json()).isRepo).toBe(true);
    const second = await send(app, 'POST', `/projects/${h.project.id}/repository/init`);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('already_repository');
  });
});

describe('ACE parity P1 — deliverable, GitHub, preview, schedule and clone routes', () => {
  it('edits and accepts a document, refuses send for it, and answers the P1 shapes', async () => {
    const h = await createTaskHarness();
    const app = routeApp(createTaskRoutes(h.service));
    const created = TaskSchema.parse(
      await (
        await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
          title: 'Notes',
          type: 'document',
          documentPath: 'docs/notes.md',
          finishLine: 'accept_document',
          workflowId: h.team.id,
          start: 'now',
        })
      ).json(),
    );
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: '# Notes' });

    const edited = await send(app, 'PUT', `/tasks/${created.id}/deliverable`, {
      deliverable: { kind: 'document', path: 'docs/notes.md', content: '# Notes, edited' },
    });
    expect(TaskSchema.parse(await edited.json()).deliverable).toMatchObject({
      content: '# Notes, edited',
    });
    expect((await send(app, 'POST', `/tasks/${created.id}/send`)).status).toBe(409);
    const accepted = await send(app, 'POST', `/tasks/${created.id}/accept`, {
      path: 'docs/notes.md',
    });
    expect(TaskSchema.parse(await accepted.json()).outcome).toBe('accepted');
  });

  it('opens and merges a pull request over HTTP and validates the merge body', async () => {
    const h = await createTaskHarness();
    h.git.status = { ...h.git.status, remoteUrl: 'git@github.com:acme/shop.git' };
    const app = routeApp(createTaskRoutes(h.service));
    const created = TaskSchema.parse(
      await (
        await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
          title: 'Search',
          finishLine: 'github_merge',
          workflowId: h.team.id,
          start: 'now',
        })
      ).json(),
    );
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'ok', changes: [file('a.ts')] });
    expect(
      TaskSchema.parse(await (await send(app, 'POST', `/tasks/${created.id}/open-pr`)).json())
        .allowedActions,
    ).toContain('merge_pr');
    expect(
      (await send(app, 'POST', `/tasks/${created.id}/merge-pr`, { method: 'squash' })).status,
    ).toBe(400);
    const merged = await send(app, 'POST', `/tasks/${created.id}/merge-pr`, {
      method: 'merge',
      confirm: { repo: 'acme/shop', base: 'main' },
    });
    expect(TaskSchema.parse(await merged.json()).outcome).toBe('merged');
  });

  it('starts and stops a preview, schedules and unschedules a task, and clones a project', async () => {
    const h = await createTaskHarness({ projectPatch: { previewCommand: 'pnpm dev' } });
    const app = routeApp(createTaskRoutes(h.service));
    const created = TaskSchema.parse(
      await (
        await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
          title: 'Search',
          workflowId: h.team.id,
          start: 'now',
        })
      ).json(),
    );
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'ok', changes: [file('a.ts')] });
    expect((await send(app, 'POST', `/tasks/${created.id}/preview/start`)).status).toBe(200);
    expect(
      TaskDetailSchema.parse(await (await send(app, 'GET', `/tasks/${created.id}`)).json()).preview
        ?.status,
    ).toBe('running');
    expect((await send(app, 'POST', `/tasks/${created.id}/preview/stop`)).status).toBe(200);

    const inbox = TaskSchema.parse(
      await (
        await send(app, 'POST', `/projects/${h.project.id}/tasks`, {
          title: 'Later',
          workflowId: h.team.id,
        })
      ).json(),
    );
    const scheduled = await send(app, 'PUT', `/tasks/${inbox.id}/schedule`, {
      trigger: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'UTC' },
    });
    expect(scheduled.status).toBe(200);
    expect(((await scheduled.json()) as { enabled: boolean }).enabled).toBe(true);
    expect((await send(app, 'DELETE', `/tasks/${inbox.id}/schedule`)).status).toBe(204);

    const cloned = await send(app, 'POST', '/projects/clone', { repo: 'acme/storefront' });
    expect(cloned.status).toBe(201);
    expect((await send(app, 'POST', '/projects/clone', {})).status).toBe(400);
  });
});
