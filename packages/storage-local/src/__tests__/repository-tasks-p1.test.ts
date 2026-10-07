import type { TaskDeliverable, TaskSchedule, TaskSource, TaskWorkspace } from '@ace/contracts';
import { newId, SecretWriteRejectedError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeProject, makeTask, makeWorkflow, NOW, scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * The ACE parity P1 storage (D275–D278) on a real SQLite file: a task's deliverable and source, a
 * workspace's pull request, a project's preview command and URL, and task schedules.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const LATER = '2026-09-21T11:00:00.000Z';
const LATEST = '2026-09-21T12:00:00.000Z';
const other = { workspaceId: 'other' };
/** Key-shaped, and assembled at runtime so no key literal is in the repository (CLAUDE.md §2). */
const KEY = ['sk', '-', 'a1B2'.repeat(8)].join('');

const DOCUMENT: TaskDeliverable = {
  kind: 'document',
  path: 'docs/release-notes.md',
  content: '# Release notes\n\n- Health check added.\n',
};

const EMAIL: TaskDeliverable = {
  kind: 'email',
  to: ['ada@example.com', 'grace@example.com'],
  cc: [],
  subject: 'Release 1.2',
  body: 'Hello,\n\nRelease 1.2 is out.\n',
};

async function seedProject(name = 'Board') {
  const project = makeProject({ name });
  await db.repository.projects.create(scope, project);
  const workflow = makeWorkflow(project.id);
  await db.repository.workflows.create(scope, workflow);
  return { project, workflow };
}

async function seedTask(projectId: string, number = 1) {
  const task = makeTask(projectId, { number });
  await db.repository.tasks.create(scope, task);
  return task;
}

function makeWorkspace(taskId: string, overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: newId(),
    taskId,
    repoPath: 'D:/projects/demo',
    path: 'D:/ace-data/workspaces/task',
    branch: 'ace/task-1-add-a-health-check',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSchedule(taskId: string, overrides: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: newId(),
    taskId,
    trigger: { kind: 'once', at: LATER },
    enabled: true,
    nextRunAt: LATER,
    skipped: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rawColumns(table: string, id: string): Record<string, unknown> {
  return db.sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

describe('D275 a task keeps its deliverable and its source', () => {
  it('round-trips a document deliverable and a chat source', async () => {
    const { project, workflow } = await seedProject();
    const source: TaskSource = {
      kind: 'chat',
      workflowId: workflow.id,
      threadId: newId(),
      messageId: newId(),
      label: 'From the planning chat',
    };
    const task = makeTask(project.id, { type: 'document', deliverable: DOCUMENT, source });

    await db.repository.tasks.create(scope, task);

    expect(await db.repository.tasks.get(scope, task.id)).toEqual(task);
    expect(JSON.parse(rawColumns('tasks', task.id)['deliverable'] as string)).toEqual(DOCUMENT);
  });

  it('round-trips an email deliverable and a schedule source through save', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    const saved = {
      ...task,
      type: 'email' as const,
      deliverable: EMAIL,
      source: { kind: 'schedule' as const, refId: newId() },
      updatedAt: LATER,
    };

    await db.repository.tasks.save(scope, saved);

    expect(await db.repository.tasks.get(scope, task.id)).toEqual(saved);
    expect(
      (await db.repository.tasks.listByProject(scope, project.id)).map((t) => t.deliverable),
    ).toEqual([EMAIL]);
  });

  it('stores none as NULL, reads it absent, and a save that leaves them out clears them', async () => {
    const { project } = await seedProject();
    const plain = await seedTask(project.id);
    expect(rawColumns('tasks', plain.id)).toMatchObject({ deliverable: null, source: null });
    const read = await db.repository.tasks.get(scope, plain.id);
    expect(read).not.toHaveProperty('deliverable');
    expect(read).not.toHaveProperty('source');

    const full = { ...plain, deliverable: DOCUMENT, source: { kind: 'suggestion' as const } };
    await db.repository.tasks.save(scope, full);
    await db.repository.tasks.save(scope, plain);
    expect(rawColumns('tasks', plain.id)).toMatchObject({ deliverable: null, source: null });
    expect(await db.repository.tasks.get(scope, plain.id)).toEqual(plain);
  });

  it('checks a stored deliverable against the contract on read', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    // Drifted behind the repository's back: a path outside the project folder.
    db.sqlite
      .prepare('UPDATE tasks SET deliverable = ? WHERE id = ?')
      .run(JSON.stringify({ ...DOCUMENT, path: '../outside.md' }), task.id);

    await expect(db.repository.tasks.get(scope, task.id)).rejects.toThrow(/project folder/);
  });

  it('refuses a credential in a deliverable (BR-07)', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id, {
      type: 'email',
      deliverable: { ...EMAIL, body: `The key is ${KEY}.` },
    });

    await expect(db.repository.tasks.create(scope, task)).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
  });
});

describe('D276 a workspace keeps the pull request opened from it', () => {
  it('round-trips the pull request, and clears it when a save leaves it out', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    const workspace = makeWorkspace(task.id);
    await db.repository.taskWorkspaces.create(scope, workspace);
    expect(rawColumns('task_workspaces', workspace.id)['pull_request']).toBeNull();
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).not.toHaveProperty(
      'pullRequest',
    );

    const opened: TaskWorkspace = {
      ...workspace,
      pullRequest: {
        number: 12,
        url: 'https://github.com/octo/demo/pull/12',
        state: 'open',
        base: 'main',
        repo: 'octo/demo',
      },
      updatedAt: LATER,
    };
    await db.repository.taskWorkspaces.save(scope, opened);
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(opened);

    const merged: TaskWorkspace = {
      ...opened,
      status: 'merged',
      pullRequest: { ...opened.pullRequest!, state: 'merged' },
      updatedAt: LATEST,
    };
    await db.repository.taskWorkspaces.save(scope, merged);
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(merged);

    await db.repository.taskWorkspaces.save(scope, workspace);
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(workspace);
  });

  it('creates a workspace with its pull request already set', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    const workspace = makeWorkspace(task.id, {
      pullRequest: {
        number: 3,
        url: 'https://github.com/octo/demo/pull/3',
        state: 'closed',
        base: 'develop',
        repo: 'octo/demo',
      },
    });

    await db.repository.taskWorkspaces.create(scope, workspace);

    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(workspace);
  });
});

describe('D278 a project carries its preview command and URL', () => {
  it('round-trips both, and a project without them reads them absent', async () => {
    const plain = makeProject();
    const previewed = makeProject({
      previewCommand: 'pnpm dev --port %PORT%',
      previewUrl: 'http://127.0.0.1:{port}/',
    });
    const cleared = makeProject({ previewCommand: null, previewUrl: null });
    for (const project of [plain, previewed, cleared]) {
      await db.repository.projects.create(scope, project);
    }

    expect(await db.repository.projects.get(scope, plain.id)).toEqual(plain);
    expect(await db.repository.projects.get(scope, previewed.id)).toEqual(previewed);
    // `null` on create is none, stored NULL and read absent, as the contract's optional allows.
    const { previewCommand: _c, previewUrl: _u, ...withoutPreview } = cleared;
    expect(await db.repository.projects.get(scope, cleared.id)).toEqual(withoutPreview);
    expect(rawColumns('projects', cleared.id)).toMatchObject({
      preview_command: null,
      preview_url: null,
    });
  });

  it('patches each; undefined leaves it, null clears it', async () => {
    const project = makeProject({ setupCommand: 'pnpm install' });
    await db.repository.projects.create(scope, project);

    const set = await db.repository.projects.update(scope, project.id, {
      previewCommand: 'npm run dev',
      previewUrl: 'http://localhost:{port}',
      updatedAt: LATER,
    });
    expect(set).toEqual({
      ...project,
      previewCommand: 'npm run dev',
      previewUrl: 'http://localhost:{port}',
      updatedAt: LATER,
    });

    const urlOnly = await db.repository.projects.update(scope, project.id, {
      previewUrl: null,
      updatedAt: LATEST,
    });
    expect(urlOnly).toEqual({ ...project, previewCommand: 'npm run dev', updatedAt: LATEST });

    const none = await db.repository.projects.update(scope, project.id, {
      previewCommand: null,
      updatedAt: LATEST,
    });
    expect(none).toEqual({ ...project, updatedAt: LATEST });
    expect(await db.repository.projects.get(scope, project.id)).toEqual(none);
  });

  it('refuses a credential in a preview command or URL (BR-07)', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);

    await expect(
      db.repository.projects.update(scope, project.id, {
        previewCommand: `API_KEY=${KEY} pnpm dev`,
        updatedAt: LATER,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    await expect(
      db.repository.projects.update(scope, project.id, {
        previewUrl: `http://127.0.0.1:{port}/?key=${KEY}`,
        updatedAt: LATER,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    await expect(
      db.repository.projects.create(scope, makeProject({ previewCommand: `use ${KEY}` })),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.projects.get(scope, project.id)).toEqual(project);
  });
});

describe('D277 task schedules repository', () => {
  it('creates and reads one schedule per task, for every trigger kind', async () => {
    const { project } = await seedProject();
    const once = await seedTask(project.id, 1);
    const recurring = await seedTask(project.id, 2);
    const after = await seedTask(project.id, 3);
    const schedules = [
      makeSchedule(once.id),
      makeSchedule(recurring.id, {
        trigger: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'Europe/Paris' },
        lastRunAt: NOW,
        lastTaskId: newId(),
        skipped: 2,
      }),
      makeSchedule(after.id, {
        trigger: { kind: 'after_task', taskId: once.id },
        enabled: false,
      }),
    ];
    delete schedules[2]!.nextRunAt;

    for (const schedule of schedules) {
      expect(await db.repository.taskSchedules.create(scope, schedule)).toEqual(schedule);
    }

    for (const schedule of schedules) {
      expect(await db.repository.taskSchedules.getByTask(scope, schedule.taskId)).toEqual(schedule);
    }
    expect(await db.repository.taskSchedules.getByTask(scope, newId())).toBeNull();
    expect(await db.repository.taskSchedules.getByTask(other, once.id)).toBeNull();
    const read = await db.repository.taskSchedules.getByTask(scope, after.id);
    for (const field of ['nextRunAt', 'lastRunAt', 'lastTaskId']) {
      expect(read).not.toHaveProperty(field);
    }
  });

  it('repeats the trigger kind and the awaited task as columns', async () => {
    const { project } = await seedProject();
    const first = await seedTask(project.id, 1);
    const second = await seedTask(project.id, 2);
    const waiting = makeSchedule(second.id, { trigger: { kind: 'after_task', taskId: first.id } });
    const timed = makeSchedule(first.id);
    await db.repository.taskSchedules.create(scope, waiting);
    await db.repository.taskSchedules.create(scope, timed);

    expect(rawColumns('task_schedules', waiting.id)).toMatchObject({
      kind: 'after_task',
      after_task_id: first.id,
      enabled: 1,
    });
    expect(rawColumns('task_schedules', timed.id)).toMatchObject({
      kind: 'once',
      after_task_id: null,
    });
  });

  it('lists the enabled schedules of every project, oldest first, and no other workspace', async () => {
    const { project } = await seedProject();
    const { project: second } = await seedProject('Second');
    const a = await seedTask(project.id, 1);
    const b = await seedTask(second.id, 1);
    const c = await seedTask(project.id, 2);
    const first = makeSchedule(a.id);
    const disabled = makeSchedule(b.id, { enabled: false });
    const third = makeSchedule(c.id, {
      trigger: { kind: 'recurring', cron: '*/5 * * * *', timezone: 'UTC' },
    });
    for (const schedule of [first, disabled, third]) {
      await db.repository.taskSchedules.create(scope, schedule);
    }

    expect(await db.repository.taskSchedules.listEnabled(scope)).toEqual([first, third]);
    expect(await db.repository.taskSchedules.listEnabled(other)).toEqual([]);
  });

  it('lists the after_task schedules waiting on a task, enabled or not', async () => {
    const { project } = await seedProject();
    const awaited = await seedTask(project.id, 1);
    const elsewhere = await seedTask(project.id, 2);
    const one = await seedTask(project.id, 3);
    const two = await seedTask(project.id, 4);
    const three = await seedTask(project.id, 5);
    const waitingOne = makeSchedule(one.id, {
      trigger: { kind: 'after_task', taskId: awaited.id },
    });
    const waitingTwo = makeSchedule(two.id, {
      trigger: { kind: 'after_task', taskId: awaited.id },
      enabled: false,
    });
    const waitingElsewhere = makeSchedule(three.id, {
      trigger: { kind: 'after_task', taskId: elsewhere.id },
    });
    for (const schedule of [waitingOne, waitingTwo, waitingElsewhere]) {
      await db.repository.taskSchedules.create(scope, schedule);
    }
    await db.repository.taskSchedules.create(scope, makeSchedule(awaited.id));

    expect(await db.repository.taskSchedules.listAfterTask(scope, awaited.id)).toEqual([
      waitingOne,
      waitingTwo,
    ]);
    expect(await db.repository.taskSchedules.listAfterTask(scope, elsewhere.id)).toEqual([
      waitingElsewhere,
    ]);
    expect(await db.repository.taskSchedules.listAfterTask(scope, one.id)).toEqual([]);
    expect(await db.repository.taskSchedules.listAfterTask(other, awaited.id)).toEqual([]);
  });

  it('save replaces every column, the repeated ones too, and clears what it leaves out', async () => {
    const { project } = await seedProject();
    const awaited = await seedTask(project.id, 1);
    const task = await seedTask(project.id, 2);
    const schedule = makeSchedule(task.id, {
      trigger: { kind: 'recurring', cron: '0 9 * * *', timezone: 'UTC' },
      lastRunAt: NOW,
      lastTaskId: newId(),
      skipped: 1,
    });
    await db.repository.taskSchedules.create(scope, schedule);

    const waiting: TaskSchedule = {
      id: schedule.id,
      taskId: task.id,
      trigger: { kind: 'after_task', taskId: awaited.id },
      enabled: false,
      skipped: 3,
      createdAt: schedule.createdAt,
      updatedAt: LATEST,
    };
    expect(await db.repository.taskSchedules.save(scope, waiting)).toEqual(waiting);

    expect(await db.repository.taskSchedules.getByTask(scope, task.id)).toEqual(waiting);
    expect(rawColumns('task_schedules', schedule.id)).toMatchObject({
      kind: 'after_task',
      after_task_id: awaited.id,
      next_run_at: null,
      last_run_at: null,
      last_task_id: null,
    });
    expect(await db.repository.taskSchedules.listEnabled(scope)).toEqual([]);
    expect(await db.repository.taskSchedules.listAfterTask(scope, awaited.id)).toEqual([waiting]);
  });

  it('save throws for a schedule that is not stored, and delete reports what it removed', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    const ghost = makeSchedule(task.id);

    await expect(db.repository.taskSchedules.save(scope, ghost)).rejects.toThrow(/not stored/);
    expect(await db.repository.taskSchedules.getByTask(scope, task.id)).toBeNull();

    await db.repository.taskSchedules.create(scope, ghost);
    await expect(db.repository.taskSchedules.save(other, ghost)).rejects.toThrow(/not stored/);
    expect(await db.repository.taskSchedules.delete(other, ghost.id)).toBe(false);
    expect(await db.repository.taskSchedules.delete(scope, ghost.id)).toBe(true);
    expect(await db.repository.taskSchedules.delete(scope, ghost.id)).toBe(false);
    expect(await db.repository.taskSchedules.getByTask(scope, task.id)).toBeNull();
  });

  it('refuses a second schedule for one task, and one for a task that does not exist', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    await db.repository.taskSchedules.create(scope, makeSchedule(task.id));

    await expect(db.repository.taskSchedules.create(scope, makeSchedule(task.id))).rejects.toThrow(
      /UNIQUE/,
    );
    await expect(db.repository.taskSchedules.create(scope, makeSchedule(newId()))).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it('checks a stored trigger against the contract on read', async () => {
    const { project } = await seedProject();
    const task = await seedTask(project.id);
    const schedule = makeSchedule(task.id);
    await db.repository.taskSchedules.create(scope, schedule);
    db.sqlite
      .prepare('UPDATE task_schedules SET "trigger" = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'recurring', cron: 'every day', timezone: 'UTC' }), schedule.id);

    await expect(db.repository.taskSchedules.getByTask(scope, task.id)).rejects.toThrow(
      /five cron fields/,
    );
  });
});

describe('D277 a schedule goes with its task', () => {
  it('deleting a task removes its schedule, not the ones waiting on it', async () => {
    const { project } = await seedProject();
    const awaited = await seedTask(project.id, 1);
    const waiter = await seedTask(project.id, 2);
    const own = makeSchedule(awaited.id);
    const waiting = makeSchedule(waiter.id, {
      trigger: { kind: 'after_task', taskId: awaited.id },
    });
    await db.repository.taskSchedules.create(scope, own);
    await db.repository.taskSchedules.create(scope, waiting);

    expect(await db.repository.tasks.delete(scope, awaited.id)).toBe(true);

    expect(rawColumns('task_schedules', own.id)).toBeUndefined();
    // Still there, naming a task that is gone: the scheduler's to resolve (no foreign key).
    expect(await db.repository.taskSchedules.listAfterTask(scope, awaited.id)).toEqual([waiting]);
  });

  it('deleting a project removes its tasks and their schedules', async () => {
    const { project } = await seedProject();
    const { project: kept } = await seedProject('Kept');
    const task = await seedTask(project.id);
    const survivor = await seedTask(kept.id);
    await db.repository.taskSchedules.create(scope, makeSchedule(task.id));
    const keptSchedule = makeSchedule(survivor.id);
    await db.repository.taskSchedules.create(scope, keptSchedule);

    await db.repository.projects.delete(scope, project.id);

    expect(await db.repository.taskSchedules.listEnabled(scope)).toEqual([keptSchedule]);
  });

  it('rolls a schedule back with the batch it was written in', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);

    await expect(
      db.repository.transaction(async (tx) => {
        await tx.tasks!.create(scope, task);
        await tx.taskSchedules!.create(scope, makeSchedule(task.id));
        throw new Error('the schedule was refused');
      }),
    ).rejects.toThrow('the schedule was refused');

    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
    expect(await db.repository.taskSchedules.getByTask(scope, task.id)).toBeNull();

    const schedule = makeSchedule(task.id);
    await db.repository.transaction(async (tx) => {
      await tx.tasks!.create(scope, task);
      await tx.taskSchedules!.create(scope, schedule);
    });
    expect(await db.repository.taskSchedules.getByTask(scope, task.id)).toEqual(schedule);
  });
});
