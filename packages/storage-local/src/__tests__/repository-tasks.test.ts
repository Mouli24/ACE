import type {
  TaskCheck,
  TaskDelivery,
  TaskExecution,
  TaskReview,
  TaskWorkspace,
} from '@ace/contracts';
import { newId, SecretWriteRejectedError, type TaskRecord } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeProject, makeTask, makeTaskActivity, makeWorkflow, NOW, scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * The ACE parity P0 repositories (D267–D271) on a real SQLite file: tasks and the workspace,
 * executions, checks, reviews, deliveries and activity that belong to each — and the project Build
 * settings and approval mode the task service reads beside them.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const SHA_BASE = 'a'.repeat(40);
const SHA_HEAD = 'b'.repeat(40);
const SHA_MERGE = 'c'.repeat(40);
const LATER = '2026-09-21T11:00:00.000Z';
const LATEST = '2026-09-21T12:00:00.000Z';
const other = { workspaceId: 'other' };
/** Key-shaped, and assembled at runtime so no key literal is in the repository (CLAUDE.md §2). */
const KEY = ['sk', '-', 'a1B2'.repeat(8)].join('');

/** A project with one workflow, both stored — what every task here belongs to. */
async function seedProject(name = 'Board') {
  const project = makeProject({ name });
  await db.repository.projects.create(scope, project);
  const workflow = makeWorkflow(project.id);
  await db.repository.workflows.create(scope, workflow);
  return { project, workflow };
}

/** A task with every optional field set, so a round-trip proves each column. */
function fullTask(projectId: string, workflowId: string, number = 1): TaskRecord {
  return makeTask(projectId, {
    number,
    stage: 'done',
    state: 'done',
    stateReason: 'Applied to main.',
    outcome: 'applied',
    finishLine: 'apply_local',
    automation: 'autopilot',
    priority: 'urgent',
    labels: ['backend', 'health'],
    workflowId,
    plannerWorkflowId: workflowId,
    plan: '1. Add the route.\n2. Test it.',
    acceptance: 'curl /health answers 200.',
    runChecks: false,
    paused: true,
    pendingRequest: 'Also log the request.',
    startedAt: LATER,
    completedAt: LATEST,
    updatedAt: LATEST,
  });
}

function makeWorkspace(taskId: string, overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: newId(),
    taskId,
    repoPath: 'D:/projects/demo',
    path: 'D:/ace-data/workspaces/task',
    branch: 'ace/task-1-add-a-health-check',
    baseBranch: 'main',
    baseSha: SHA_BASE,
    headSha: SHA_BASE,
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeExecution(
  taskId: string,
  workflowId: string,
  overrides: Partial<TaskExecution> = {},
): TaskExecution {
  return {
    id: newId(),
    taskId,
    kind: 'work',
    sequence: 1,
    workflowId,
    status: 'running',
    request: 'Expose GET /health answering 200.',
    startedAt: NOW,
    ...overrides,
  };
}

function makeCheck(taskId: string, overrides: Partial<TaskCheck> = {}): TaskCheck {
  return {
    id: newId(),
    taskId,
    name: 'test',
    command: 'pnpm test',
    status: 'passed',
    output: 'ok',
    durationMs: 1200,
    headSha: SHA_HEAD,
    at: NOW,
    ...overrides,
  };
}

function makeReview(taskId: string, overrides: Partial<TaskReview> = {}): TaskReview {
  return { id: newId(), taskId, decision: 'approved', at: NOW, ...overrides };
}

function makeDelivery(taskId: string, overrides: Partial<TaskDelivery> = {}): TaskDelivery {
  return {
    id: newId(),
    taskId,
    kind: 'apply_local',
    status: 'succeeded',
    destination: 'D:/projects/demo @ main',
    at: NOW,
    ...overrides,
  };
}

/** Rows of a table that belong to one task, read past the repositories. */
function countFor(table: string, taskId: string): number {
  return (
    db.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE task_id = ?`).get(taskId) as {
      n: number;
    }
  ).n;
}

const CHILD_TABLES = [
  'task_workspaces',
  'task_executions',
  'task_checks',
  'task_reviews',
  'task_deliveries',
  'task_activity',
];

/** One row in every child table, so a cascade has something to take. */
async function seedChildren(taskId: string, workflowId: string): Promise<void> {
  await db.repository.taskWorkspaces.create(scope, makeWorkspace(taskId));
  await db.repository.taskExecutions.create(scope, makeExecution(taskId, workflowId));
  await db.repository.taskChecks.create(scope, makeCheck(taskId));
  await db.repository.taskReviews.create(scope, makeReview(taskId));
  await db.repository.taskDeliveries.create(scope, makeDelivery(taskId));
  await db.repository.taskActivity.append(scope, makeTaskActivity(taskId));
}

describe('D268 tasks repository: create, get, save, delete', () => {
  it('round-trips a task with every optional field absent, and they stay absent', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);

    expect(await db.repository.tasks.create(scope, task)).toEqual(task);
    const read = await db.repository.tasks.get(scope, task.id);

    expect(read).toEqual(task);
    for (const field of [
      'stateReason',
      'outcome',
      'workflowId',
      'plannerWorkflowId',
      'pendingRequest',
      'startedAt',
      'completedAt',
    ]) {
      expect(read).not.toHaveProperty(field);
    }
  });

  it('round-trips a task with every optional field set', async () => {
    const { project, workflow } = await seedProject();
    const task = fullTask(project.id, workflow.id);

    await db.repository.tasks.create(scope, task);

    expect(await db.repository.tasks.get(scope, task.id)).toEqual(task);
  });

  it('answers null for an unknown task and for another workspace', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);

    expect(await db.repository.tasks.get(scope, newId())).toBeNull();
    expect(await db.repository.tasks.get(other, task.id)).toBeNull();
    expect(await db.repository.tasks.listByProject(other, project.id)).toEqual([]);
    expect(await db.repository.tasks.listByStates(other, ['idle'])).toEqual([]);
    expect(await db.repository.tasks.delete(other, task.id)).toBe(false);
  });

  it('save replaces every column, and an optional field left out is cleared', async () => {
    const { project, workflow } = await seedProject();
    const full = fullTask(project.id, workflow.id);
    await db.repository.tasks.create(scope, full);

    const replaced = makeTask(project.id, {
      id: full.id,
      number: full.number,
      title: 'Renamed',
      stage: 'work',
      state: 'queued',
      labels: ['one'],
      createdAt: full.createdAt,
      updatedAt: LATEST,
    });
    expect(await db.repository.tasks.save(scope, replaced)).toEqual(replaced);

    expect(await db.repository.tasks.get(scope, full.id)).toEqual(replaced);
  });

  it('save throws for a task that is not stored, and writes nothing', async () => {
    const { project } = await seedProject();
    const ghost = makeTask(project.id);

    await expect(db.repository.tasks.save(scope, ghost)).rejects.toThrow(/not stored/);
    await expect(db.repository.tasks.save(other, ghost)).rejects.toThrow(/not stored/);
    expect(await db.repository.tasks.get(scope, ghost.id)).toBeNull();
  });

  it('delete reports whether anything was removed', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);

    expect(await db.repository.tasks.delete(scope, task.id)).toBe(true);
    expect(await db.repository.tasks.delete(scope, task.id)).toBe(false);
    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
  });

  it('refuses a second task with the same number in one project, but not in another', async () => {
    const { project } = await seedProject();
    const { project: second } = await seedProject('Second');
    await db.repository.tasks.create(scope, makeTask(project.id, { number: 1 }));

    await expect(
      db.repository.tasks.create(scope, makeTask(project.id, { number: 1 })),
    ).rejects.toThrow(/UNIQUE/);
    await db.repository.tasks.create(scope, makeTask(second.id, { number: 1 }));
  });

  it('refuses a task whose project does not exist (foreign key)', async () => {
    await expect(db.repository.tasks.create(scope, makeTask(newId()))).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it('refuses a credential in a task, as every write of the store does (BR-07)', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id, { brief: `Use ${KEY} for it.` });

    await expect(db.repository.tasks.create(scope, task)).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
  });
});

describe('D268 tasks repository: lists and numbers', () => {
  it('lists one project newest number first, filtered by stage and states in SQL', async () => {
    const { project } = await seedProject();
    const { project: elsewhere } = await seedProject('Elsewhere');
    const one = makeTask(project.id, { number: 1, stage: 'inbox', state: 'idle' });
    const two = makeTask(project.id, { number: 2, stage: 'work', state: 'running' });
    const three = makeTask(project.id, { number: 3, stage: 'work', state: 'queued' });
    const four = makeTask(project.id, { number: 4, stage: 'review', state: 'idle' });
    // Stored out of number order, so the order comes from the query.
    for (const task of [three, one, four, two]) await db.repository.tasks.create(scope, task);
    await db.repository.tasks.create(scope, makeTask(elsewhere.id, { number: 9 }));

    const numbers = (tasks: TaskRecord[]) => tasks.map((task) => task.number);
    const list = db.repository.tasks.listByProject;
    expect(numbers(await list(scope, project.id))).toEqual([4, 3, 2, 1]);
    expect(numbers(await list(scope, project.id, {}))).toEqual([4, 3, 2, 1]);
    expect(numbers(await list(scope, project.id, { stage: 'work' }))).toEqual([3, 2]);
    expect(numbers(await list(scope, project.id, { states: ['idle'] }))).toEqual([4, 1]);
    expect(
      numbers(await list(scope, project.id, { stage: 'work', states: ['queued', 'idle'] })),
    ).toEqual([3]);
    expect(await list(scope, project.id, { states: [] })).toEqual([]);
    expect(await list(scope, newId())).toEqual([]);
  });

  it('lists every project tasks in the given states, oldest task first', async () => {
    const { project } = await seedProject();
    const { project: second } = await seedProject('Second');
    const running = makeTask(project.id, { number: 1, stage: 'work', state: 'running' });
    const waiting = makeTask(second.id, { number: 1, stage: 'plan', state: 'waiting' });
    const queued = makeTask(project.id, { number: 2, stage: 'work', state: 'queued' });
    const idle = makeTask(second.id, { number: 2 });
    for (const task of [running, waiting, queued, idle]) {
      await db.repository.tasks.create(scope, task);
    }

    expect(
      (await db.repository.tasks.listByStates(scope, ['running', 'waiting'])).map((t) => t.id),
    ).toEqual([running.id, waiting.id]);
    expect(await db.repository.tasks.listByStates(scope, ['queued'])).toEqual([queued]);
    expect(await db.repository.tasks.listByStates(scope, [])).toEqual([]);
  });

  it('numbers from 1, then one more than the highest so far, per project', async () => {
    const { project } = await seedProject();
    const { project: second } = await seedProject('Second');

    expect(await db.repository.tasks.nextNumber(scope, project.id)).toBe(1);
    await db.repository.tasks.create(scope, makeTask(project.id, { number: 1 }));
    await db.repository.tasks.create(scope, makeTask(project.id, { number: 5 }));
    await db.repository.tasks.create(scope, makeTask(project.id, { number: 2 }));

    expect(await db.repository.tasks.nextNumber(scope, project.id)).toBe(6);
    expect(await db.repository.tasks.nextNumber(scope, second.id)).toBe(1);
    expect(await db.repository.tasks.nextNumber(other, project.id)).toBe(1);
  });
});

describe('D268 a task row goes with its owner, and a deleted team leaves it without one', () => {
  it('deleting a task removes its workspace, executions, checks, reviews, deliveries and activity', async () => {
    const { project, workflow } = await seedProject();
    const task = makeTask(project.id);
    const kept = makeTask(project.id, { number: 2 });
    await db.repository.tasks.create(scope, task);
    await db.repository.tasks.create(scope, kept);
    await seedChildren(task.id, workflow.id);
    await seedChildren(kept.id, workflow.id);

    expect(await db.repository.tasks.delete(scope, task.id)).toBe(true);

    for (const table of CHILD_TABLES) {
      expect(countFor(table, task.id), table).toBe(0);
      expect(countFor(table, kept.id), table).toBe(1);
    }
  });

  it('deleting a project removes its tasks and every row below them', async () => {
    const { project, workflow } = await seedProject();
    const { project: kept } = await seedProject('Kept');
    const task = makeTask(project.id);
    const survivor = makeTask(kept.id);
    await db.repository.tasks.create(scope, task);
    await db.repository.tasks.create(scope, survivor);
    await seedChildren(task.id, workflow.id);

    expect(await db.repository.projects.delete(scope, project.id)).toBe(true);

    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
    for (const table of CHILD_TABLES) expect(countFor(table, task.id), table).toBe(0);
    expect(await db.repository.tasks.get(scope, survivor.id)).toEqual(survivor);
  });

  it('deleting a workflow clears it as the team and planner; the task and its history stay', async () => {
    const { project, workflow } = await seedProject();
    const planner = makeWorkflow(project.id, { name: 'Planner' });
    await db.repository.workflows.create(scope, planner);
    const task = makeTask(project.id, { workflowId: workflow.id, plannerWorkflowId: planner.id });
    await db.repository.tasks.create(scope, task);
    const execution = makeExecution(task.id, workflow.id);
    await db.repository.taskExecutions.create(scope, execution);

    await db.repository.workflows.delete(scope, workflow.id);
    const { workflowId: _team, ...withoutTeam } = task;
    expect(await db.repository.tasks.get(scope, task.id)).toEqual(withoutTeam);

    await db.repository.workflows.delete(scope, planner.id);
    const { plannerWorkflowId: _planner, ...withoutEither } = withoutTeam;
    expect(await db.repository.tasks.get(scope, task.id)).toEqual(withoutEither);
    // An execution's workflow id is history, so it still names the workflow that ran.
    expect(await db.repository.taskExecutions.get(scope, execution.id)).toEqual(execution);
  });
});

describe('D269 task workspaces repository', () => {
  it('creates, reads by task, and saves one workspace per task', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    const workspace = makeWorkspace(task.id);

    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toBeNull();
    expect(await db.repository.taskWorkspaces.create(scope, workspace)).toEqual(workspace);
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(workspace);
    expect(await db.repository.taskWorkspaces.getByTask(other, task.id)).toBeNull();

    const failed = { ...workspace, status: 'error' as const, error: 'branch exists' };
    await db.repository.taskWorkspaces.save(scope, failed);
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(failed);

    const applied = { ...workspace, headSha: SHA_HEAD, status: 'applied' as const };
    expect(await db.repository.taskWorkspaces.save(scope, applied)).toEqual(applied);
    // The error was left out, so it is cleared.
    expect(await db.repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(applied);

    await expect(
      db.repository.taskWorkspaces.create(scope, makeWorkspace(task.id)),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('save throws for a workspace that is not stored', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);

    await expect(db.repository.taskWorkspaces.save(scope, makeWorkspace(task.id))).rejects.toThrow(
      /not stored/,
    );
  });
});

describe('D268 task executions repository', () => {
  it('reads by id and by run, lists in sequence order, and saves the end of a run', async () => {
    const { project, workflow } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    const runId = newId();
    const plan = makeExecution(task.id, workflow.id, { kind: 'plan', sequence: 1 });
    const work = makeExecution(task.id, workflow.id, { sequence: 2, runId });
    const followUp = makeExecution(task.id, workflow.id, { sequence: 3, request: 'Log it too.' });
    // Stored out of sequence order, so the order comes from the query.
    for (const execution of [followUp, plan, work]) {
      await db.repository.taskExecutions.create(scope, execution);
    }

    expect(await db.repository.taskExecutions.get(scope, plan.id)).toEqual(plan);
    expect(await db.repository.taskExecutions.get(scope, newId())).toBeNull();
    expect(await db.repository.taskExecutions.getByRun(scope, runId)).toEqual(work);
    expect(await db.repository.taskExecutions.getByRun(scope, newId())).toBeNull();
    expect(await db.repository.taskExecutions.getByRun(other, runId)).toBeNull();
    expect(
      (await db.repository.taskExecutions.listByTask(scope, task.id)).map((e) => e.sequence),
    ).toEqual([1, 2, 3]);

    const completed: TaskExecution = {
      ...work,
      status: 'completed',
      summary: 'Added GET /health.',
      commitSha: SHA_HEAD,
      changedFiles: 2,
      endedAt: LATER,
    };
    expect(await db.repository.taskExecutions.save(scope, completed)).toEqual(completed);
    expect(await db.repository.taskExecutions.getByRun(scope, runId)).toEqual(completed);

    const failed: TaskExecution = {
      ...followUp,
      status: 'failed',
      error: 'no run',
      endedAt: LATER,
    };
    await db.repository.taskExecutions.save(scope, failed);
    expect(await db.repository.taskExecutions.get(scope, followUp.id)).toEqual(failed);
  });

  it('refuses a repeated sequence in one task, and throws on saving an unknown execution', async () => {
    const { project, workflow } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    await db.repository.taskExecutions.create(scope, makeExecution(task.id, workflow.id));

    await expect(
      db.repository.taskExecutions.create(scope, makeExecution(task.id, workflow.id)),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      db.repository.taskExecutions.save(scope, makeExecution(task.id, workflow.id)),
    ).rejects.toThrow(/not stored/);
  });
});

describe('D271 checks, reviews and deliveries list oldest first', () => {
  it('lists checks by when they ran, with every optional field round-tripped', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    const latest = makeCheck(task.id, { name: 'lint', at: LATEST });
    const earliest = makeCheck(task.id, {
      executionId: newId(),
      status: 'failed',
      exitCode: 1,
      output: 'FAIL src/a.test.ts',
      at: NOW,
    });
    const middle = makeCheck(task.id, { name: 'build', status: 'timeout', at: LATER });
    for (const check of [latest, earliest, middle]) {
      expect(await db.repository.taskChecks.create(scope, check)).toEqual(check);
    }

    expect(await db.repository.taskChecks.listByTask(scope, task.id)).toEqual([
      earliest,
      middle,
      latest,
    ]);
    expect(await db.repository.taskChecks.listByTask(other, task.id)).toEqual([]);
  });

  it('lists reviews and deliveries oldest first, optional fields round-tripped', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);

    const approved = makeReview(task.id, { headSha: SHA_HEAD, at: LATER });
    const changes = makeReview(task.id, {
      decision: 'changes_requested',
      note: 'Log the request.',
      at: NOW,
    });
    await db.repository.taskReviews.create(scope, approved);
    await db.repository.taskReviews.create(scope, changes);
    expect(await db.repository.taskReviews.listByTask(scope, task.id)).toEqual([changes, approved]);

    const failed = makeDelivery(task.id, { status: 'failed', detail: 'Merge conflict', at: NOW });
    const pr = makeDelivery(task.id, {
      kind: 'github_pr',
      status: 'succeeded',
      destination: 'octo/demo',
      sha: SHA_MERGE,
      url: 'https://github.com/octo/demo/pull/1',
      at: LATER,
    });
    await db.repository.taskDeliveries.create(scope, pr);
    await db.repository.taskDeliveries.create(scope, failed);
    expect(await db.repository.taskDeliveries.listByTask(scope, task.id)).toEqual([failed, pr]);
  });

  it('refuses a credential in check output that the masker missed (BR-07)', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);

    await expect(
      db.repository.taskChecks.create(
        scope,
        makeCheck(task.id, { output: `export OPENAI_API_KEY=${KEY}` }),
      ),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.taskChecks.listByTask(scope, task.id)).toEqual([]);
  });
});

describe('D268 task activity: append-only, in the order it happened', () => {
  it('lists oldest first by insertion, and the last `limit` rows when a limit is given', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    // Same instant for all, and ids not in insertion order: only the append order can sort them.
    const ids = [newId(), newId(), newId(), newId()].reverse();
    const entries = ids.map((id, index) =>
      makeTaskActivity(task.id, { id, kind: 'edited', message: `Edit ${index + 1}.` }),
    );
    for (const entry of entries) {
      expect(await db.repository.taskActivity.append(scope, entry)).toEqual(entry);
    }
    const withRun = makeTaskActivity(task.id, {
      kind: 'run_started',
      message: 'Work started.',
      executionId: newId(),
      runId: newId(),
    });
    await db.repository.taskActivity.append(scope, withRun);
    const all = [...entries, withRun];

    expect(await db.repository.taskActivity.listByTask(scope, task.id)).toEqual(all);
    expect(await db.repository.taskActivity.listByTask(scope, task.id, 2)).toEqual(all.slice(-2));
    expect(await db.repository.taskActivity.listByTask(scope, task.id, 50)).toEqual(all);
    expect(await db.repository.taskActivity.listByTask(scope, task.id, 0)).toEqual([]);
    expect(await db.repository.taskActivity.listByTask(other, task.id)).toEqual([]);
  });

  it('refuses a repeated activity id', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);
    await db.repository.tasks.create(scope, task);
    const entry = makeTaskActivity(task.id);
    await db.repository.taskActivity.append(scope, entry);

    await expect(db.repository.taskActivity.append(scope, entry)).rejects.toThrow(/UNIQUE/);
  });
});

describe('NFR-REL-02 task writes commit or roll back with the batch they are in', () => {
  it('rolls a task and its rows back together when the batch throws', async () => {
    const { project, workflow } = await seedProject();
    const task = makeTask(project.id);

    await expect(
      db.repository.transaction(async (tx) => {
        await tx.tasks!.create(scope, task);
        await tx.taskExecutions!.create(scope, makeExecution(task.id, workflow.id));
        await tx.taskActivity!.append(scope, makeTaskActivity(task.id));
        throw new Error('the run could not start');
      }),
    ).rejects.toThrow('the run could not start');

    expect(await db.repository.tasks.get(scope, task.id)).toBeNull();
    expect(countFor('task_executions', task.id)).toBe(0);
    expect(countFor('task_activity', task.id)).toBe(0);
    expect(await db.repository.tasks.nextNumber(scope, project.id)).toBe(1);
  });

  it('commits them together when the batch succeeds', async () => {
    const { project } = await seedProject();
    const task = makeTask(project.id);

    await db.repository.transaction(async (tx) => {
      await tx.tasks!.create(scope, task);
      await tx.taskActivity!.append(scope, makeTaskActivity(task.id));
    });

    expect(await db.repository.tasks.get(scope, task.id)).toEqual(task);
    expect(countFor('task_activity', task.id)).toBe(1);
  });
});

describe('D269 D271 a project carries its Build settings', () => {
  it('round-trips the settings, and a project without them reads them absent', async () => {
    const plain = makeProject();
    const built = makeProject({
      paused: true,
      buildCapacity: 4,
      checkCommands: [
        { name: 'test', command: 'pnpm test' },
        { name: 'lint', command: 'pnpm lint' },
      ],
      setupCommand: 'pnpm install',
    });
    await db.repository.projects.create(scope, plain);
    await db.repository.projects.create(scope, built);

    expect(await db.repository.projects.get(scope, plain.id)).toEqual(plain);
    expect(await db.repository.projects.get(scope, built.id)).toEqual(built);
  });

  it('patches each setting; undefined leaves it, null clears the setup command', async () => {
    const project = makeProject({ setupCommand: 'pnpm install', buildCapacity: 3 });
    await db.repository.projects.create(scope, project);

    const paused = await db.repository.projects.update(scope, project.id, {
      paused: true,
      checkCommands: [{ name: 'test', command: 'pnpm test' }],
      updatedAt: LATER,
    });
    expect(paused).toEqual({
      ...project,
      paused: true,
      checkCommands: [{ name: 'test', command: 'pnpm test' }],
      updatedAt: LATER,
    });

    const resumed = await db.repository.projects.update(scope, project.id, {
      paused: false,
      buildCapacity: 1,
      checkCommands: [],
      setupCommand: null,
      updatedAt: LATEST,
    });
    // Not paused is the default, so it reads absent, as the setup command does once cleared.
    const { setupCommand: _cleared, ...withoutSetup } = project;
    expect(resumed).toEqual({
      ...withoutSetup,
      buildCapacity: 1,
      checkCommands: [],
      updatedAt: LATEST,
    });
    expect(await db.repository.projects.get(scope, project.id)).toEqual(resumed);
  });

  it('refuses a credential in a setup or check command (BR-07)', async () => {
    const project = makeProject();
    await db.repository.projects.create(scope, project);

    await expect(
      db.repository.projects.update(scope, project.id, {
        setupCommand: `npm config set key ${KEY}`,
        updatedAt: LATER,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    await expect(
      db.repository.projects.update(scope, project.id, {
        checkCommands: [{ name: 'deploy', command: `deploy --key ${KEY}` }],
        updatedAt: LATER,
      }),
    ).rejects.toThrow(SecretWriteRejectedError);
    await expect(
      db.repository.projects.create(scope, makeProject({ setupCommand: `use ${KEY}` })),
    ).rejects.toThrow(SecretWriteRejectedError);
    expect(await db.repository.projects.get(scope, project.id)).toEqual(project);
  });
});

describe('D270 the approval mode is a setting', () => {
  it('round-trips through a settings patch and survives a patch that does not name it', async () => {
    expect((await db.repository.settings.get(scope)).approvalMode).toBeUndefined();

    const updated = await db.repository.settings.update(scope, { approvalMode: 'full_access' });
    expect(updated.approvalMode).toBe('full_access');
    expect((await db.repository.settings.get(scope)).approvalMode).toBe('full_access');

    await db.repository.settings.update(scope, { concurrency: 4 });
    expect((await db.repository.settings.get(scope)).approvalMode).toBe('full_access');

    await db.repository.settings.update(scope, { approvalMode: 'auto_review' });
    expect((await db.repository.settings.get(scope)).approvalMode).toBe('auto_review');
  });
});
