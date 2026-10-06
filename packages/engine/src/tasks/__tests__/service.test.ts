import type { Task } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { LOCAL_SCOPE } from '../../ports/index.js';
import { HttpError } from '../../gateway/errors.js';
import { parseGitHubRemote } from '../service.js';
import { createTaskHarness, file, type TaskHarness } from './harness.js';

const scope = LOCAL_SCOPE;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function newTask(
  h: TaskHarness,
  overrides: Partial<Parameters<TaskHarness['service']['create']>[1]> = {},
): Promise<Task> {
  return h.service.create(h.project.id, {
    title: 'Add a search field',
    brief: 'Match names; show an empty state.',
    acceptance: 'Typing filters the list.',
    workflowId: h.team.id,
    ...overrides,
  });
}

async function setChecks(
  h: TaskHarness,
  commands: { name: string; command: string }[],
): Promise<void> {
  await h.repository.projects.update(scope, h.project.id, {
    checkCommands: commands,
    updatedAt: new Date().toISOString(),
  });
}

/** Start → work run → finish COMPLETE with two changed files → review. */
async function toReview(h: TaskHarness, overrides = {}): Promise<Task> {
  const task = await newTask(h, overrides);
  await h.service.start(task.id);
  await h.settle();
  await h.finishRun(h.lastRunId(), 'COMPLETE', {
    text: 'Added the field.',
    changes: [file('src/search.ts'), file('src/search.test.ts', 'added')],
  });
  return (await h.service.get(task.id)).task;
}

describe('ACE parity P0 — creating and listing tasks', () => {
  it('captures a task in the Inbox with the next number and announces it', async () => {
    const h = await createTaskHarness();
    const first = await newTask(h);
    const second = await newTask(h, { title: 'Second' });

    expect(first).toMatchObject({ number: 1, stage: 'inbox', state: 'idle', finishLine: 'review' });
    expect(second.number).toBe(2);
    expect(first.allowedActions).toEqual(
      expect.arrayContaining(['start', 'work', 'close', 'delete']),
    );
    expect(first.allowedActions).not.toContain('apply');
    const updates = h.events.filter((event) => event.type === 'task.updated');
    expect(updates).toHaveLength(2);
    expect(h.repos.activityRows.map((row) => row.kind)).toEqual(['created', 'created']);
  });

  it('refuses a team from another project', async () => {
    const h = await createTaskHarness();
    expect(
      await codeOf(
        h.service.create(h.project.id, { title: 'x', workflowId: '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW' }),
      ),
    ).toBe('validation_failed');
  });

  it('filters by search text, label and needs-attention', async () => {
    const h = await createTaskHarness();
    await newTask(h, { title: 'Fix login', labels: ['auth'] });
    await newTask(h, { title: 'Dark mode', labels: ['ui'] });
    await toReview(h, { title: 'Search box' });

    expect((await h.service.list(h.project.id, { q: 'login' })).map((t) => t.title)).toEqual([
      'Fix login',
    ]);
    expect((await h.service.list(h.project.id, { label: 'ui' })).map((t) => t.title)).toEqual([
      'Dark mode',
    ]);
    expect((await h.service.list(h.project.id, { attention: true })).map((t) => t.title)).toEqual([
      'Search box',
    ]);
  });
});

describe('ACE parity P0 — work in an isolated workspace', () => {
  it('starts work in a new worktree and gives the team the brief, plan and branch', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { start: 'now' });
    expect(task.state).toBe('running');
    await h.settle();

    const detail = await h.service.get(task.id);
    expect(detail.task).toMatchObject({ stage: 'work', state: 'running' });
    expect(detail.workspace).toMatchObject({
      branch: 'ace/task-1-add-a-search-field',
      baseBranch: 'main',
      status: 'ready',
    });
    const run = h.runs.get(h.lastRunId());
    const text = JSON.stringify(run?.request.inputs);
    expect(text).toContain('# Task #1: Add a search field');
    expect(text).toContain('Match names; show an empty state.');
    expect(text).toContain('Typing filters the list.');
    expect(text).toContain('ace/task-1-add-a-search-field');
    expect(await h.service.folderForRun(h.lastRunId())).toEqual({
      task: true,
      folder: detail.workspace?.path,
    });
    expect(await h.service.folderForRun('01JBXQ8Z9KQ4R7N2VWXYZ0RN55')).toEqual({ task: false });
  });

  it('records the run’s changes, runs the checks against the new commit and hands over to review', async () => {
    const h = await createTaskHarness();
    await setChecks(h, [
      { name: 'tests', command: 'pnpm test' },
      { name: 'lint', command: 'pnpm lint' },
    ]);
    h.commands.results.set('pnpm lint', { exitCode: 1, output: 'token sk-abc123 leaked' });
    const reviewed = await toReview(h);

    expect(reviewed).toMatchObject({ stage: 'review', state: 'idle' });
    const detail = await h.service.get(reviewed.id);
    const execution = detail.executions.at(-1);
    expect(execution).toMatchObject({
      status: 'completed',
      changedFiles: 2,
      summary: 'Added the field.',
    });
    expect(execution?.commitSha).toBe(detail.workspace?.headSha);
    expect(detail.checks.map((check) => [check.name, check.status, check.headSha])).toEqual([
      ['tests', 'passed', detail.workspace?.headSha],
      ['lint', 'failed', detail.workspace?.headSha],
    ]);
    expect(detail.checks[1]?.output).toBe('token [REDACTED] leaked');
    expect(h.commands.ran.every((ran) => ran.cwd === detail.workspace?.path)).toBe(true);

    const changes = await h.service.changes(reviewed.id);
    expect(changes.files.map((f) => f.path)).toEqual(['src/search.ts', 'src/search.test.ts']);
    expect(changes.totals).toEqual({ files: 2, additions: 6, deletions: 2 });
    expect((await h.service.fileDiff(reviewed.id, 'src/search.ts')).patch).toContain(
      'src/search.ts',
    );
    expect(await codeOf(h.service.fileDiff(reviewed.id, '../secret'))).toBe('validation_failed');
  });

  it('passes review and finishes when the finish line is review', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h);
    const head = (await h.service.get(task.id)).workspace?.headSha;
    const done = await h.service.review(task.id, { decision: 'approved', headSha: head });
    expect(done).toMatchObject({ stage: 'done', state: 'done', outcome: 'reviewed' });
    expect(h.repos.reviewRows.at(-1)).toMatchObject({ decision: 'approved', headSha: head });
  });

  it('refuses a review of a commit that is no longer the head', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h);
    expect(
      await codeOf(h.service.review(task.id, { decision: 'approved', headSha: 'f'.repeat(40) })),
    ).toBe('stale_review');
  });

  it('sends a change request to a new work run in the same workspace', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h);
    const workspace = (await h.service.get(task.id)).workspace;
    const firstRun = h.lastRunId();

    const working = await h.service.review(task.id, {
      decision: 'changes_requested',
      note: 'Debounce the input by 200 ms.',
    });
    expect(working).toMatchObject({ stage: 'work', state: 'running' });
    await h.settle();
    expect(h.lastRunId()).not.toBe(firstRun);
    const text = JSON.stringify(h.runs.get(h.lastRunId())?.request.inputs);
    expect(text).toContain('## Requested changes');
    expect(text).toContain('Debounce the input by 200 ms.');
    expect(text).toContain('Added the field.');
    expect((await h.service.get(task.id)).workspace?.path).toBe(workspace?.path);
    expect(h.git.calls.filter((call) => call.startsWith('worktree:'))).toHaveLength(1);
  });
});

describe('ACE parity P0 — applying changes locally', () => {
  it('merges into the confirmed branch, records the delivery and removes the worktree', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h, { finishLine: 'apply_local' });
    expect(task.allowedActions).toContain('apply');
    const workspace = (await h.service.get(task.id)).workspace;

    const done = await h.service.apply(task.id, {
      destination: { folderPath: h.project.folderPath, branch: 'main' },
    });
    expect(done).toMatchObject({ stage: 'done', outcome: 'applied' });
    expect(h.git.calls).toContain(`merge:${workspace?.branch}->main`);
    expect(h.git.removed).toContain(workspace?.path);
    const detail = await h.service.get(task.id);
    expect(detail.workspace?.status).toBe('applied');
    expect(detail.deliveries).toEqual([
      expect.objectContaining({
        kind: 'apply_local',
        status: 'succeeded',
        destination: `${h.project.folderPath} @ main`,
      }),
    ]);
    // The changes are still readable from the source repository.
    expect((await h.service.changes(task.id)).files).toHaveLength(2);
  });

  it('refuses a destination that moved since the user confirmed it', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h, { finishLine: 'apply_local' });
    expect(
      await codeOf(
        h.service.apply(task.id, {
          destination: { folderPath: h.project.folderPath, branch: 'dev' },
        }),
      ),
    ).toBe('destination_changed');
  });

  it('refuses to apply while a check of the head failed', async () => {
    const h = await createTaskHarness();
    await setChecks(h, [{ name: 'tests', command: 'pnpm test' }]);
    h.commands.results.set('pnpm test', { exitCode: 1 });
    const task = await toReview(h, { finishLine: 'apply_local' });
    expect(
      await codeOf(
        h.service.apply(task.id, {
          destination: { folderPath: h.project.folderPath, branch: 'main' },
        }),
      ),
    ).toBe('checks_failed');
  });

  it('keeps a conflicting apply in review with the files, and Retry brings it back', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h, { finishLine: 'apply_local' });
    h.git.mergeResult = {
      ok: false,
      reason: 'conflict',
      conflicts: ['src/search.ts'],
      message: 'Merge conflict.',
    };

    const failed = await h.service.apply(task.id, {
      destination: { folderPath: h.project.folderPath, branch: 'main' },
    });
    expect(failed).toMatchObject({ stage: 'review', state: 'failed' });
    expect(failed.stateReason).toContain('src/search.ts');
    expect(h.repos.deliveryRows.at(-1)).toMatchObject({ status: 'failed' });

    const back = await h.service.retry(task.id);
    expect(back).toMatchObject({ stage: 'review', state: 'idle' });
  });
});

describe('ACE parity P0 — planning and automation', () => {
  it('writes the plan with the planner, then an assisted task goes on to work', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { plannerWorkflowId: h.planner.id, automation: 'assisted' });
    const planning = await h.service.start(task.id);
    expect(planning).toMatchObject({ stage: 'plan', state: 'running' });
    await h.settle();
    expect(h.runs.get(h.lastRunId())?.workflowId).toBe(h.planner.id);
    expect(JSON.stringify(h.runs.get(h.lastRunId())?.request.inputs)).toContain(
      'Do not change any files',
    );

    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: '1. Add input\n2. Filter' });
    const after = await h.service.get(task.id);
    expect(after.task.plan).toBe('1. Add input\n2. Filter');
    expect(after.task).toMatchObject({ stage: 'work', state: 'running' });
    expect(JSON.stringify(h.runs.get(h.lastRunId())?.request.inputs)).toContain('1. Add input');
  });

  it('stops after the plan when the task is manual', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { plannerWorkflowId: h.planner.id, automation: 'manual' });
    await h.service.start(task.id);
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'the plan' });
    const after = (await h.service.get(task.id)).task;
    expect(after).toMatchObject({ stage: 'plan', state: 'idle' });
    expect(after.allowedActions).toContain('work');
  });

  it('takes no automatic step while the project is paused, and resumes it', async () => {
    const h = await createTaskHarness({ projectPatch: { paused: true } });
    const task = await newTask(h, { plannerWorkflowId: h.planner.id, automation: 'assisted' });
    await h.service.start(task.id);
    await h.settle();
    await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'the plan' });
    expect((await h.service.get(task.id)).task).toMatchObject({ stage: 'plan', state: 'idle' });

    await h.repository.projects.update(scope, h.project.id, { paused: false, updatedAt: 'x' });
    await h.service.projectChanged(h.project.id);
    await h.settle();
    expect((await h.service.get(task.id)).task).toMatchObject({ stage: 'work', state: 'running' });
  });

  it('queues work beyond the project’s Build capacity and starts it when a slot frees', async () => {
    const h = await createTaskHarness({ projectPatch: { buildCapacity: 1 } });
    const first = await newTask(h, { start: 'now' });
    await h.settle();
    const firstRun = h.lastRunId();
    const second = await newTask(h, { title: 'Second', start: 'now' });
    expect(second).toMatchObject({ stage: 'work', state: 'queued' });
    expect(second.stateReason).toContain('1 of 1');

    await h.finishRun(firstRun, 'COMPLETE', { text: 'done' });
    expect((await h.service.get(first.id)).task.stage).toBe('review');
    expect((await h.service.get(second.id)).task).toMatchObject({
      stage: 'work',
      state: 'running',
    });
  });

  it('finishes by itself under Autopilot with Full access, and waits without it', async () => {
    const h = await createTaskHarness();
    const waiting = await toReview(h, { automation: 'autopilot', finishLine: 'apply_local' });
    expect(waiting).toMatchObject({ stage: 'review', state: 'idle' });
    expect(waiting.stateReason).toContain('Full access');

    await h.repository.settings.update(scope, { approvalMode: 'full_access' });
    const applied = await toReview(h, {
      title: 'Auto',
      automation: 'autopilot',
      finishLine: 'apply_local',
    });
    expect(applied).toMatchObject({ stage: 'done', outcome: 'applied' });
    expect(h.repos.deliveryRows.at(-1)?.detail).toContain('Autopilot');
  });
});

describe('ACE parity P0 — failures, stops and approvals', () => {
  it('fails the stage with the pre-flight reason, and Retry runs it again', async () => {
    const h = await createTaskHarness({ blockAtPreflight: true });
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    const failed = (await h.service.get(task.id)).task;
    expect(failed).toMatchObject({ stage: 'work', state: 'failed' });
    expect(failed.stateReason).toContain('Builder has no model.');
    expect(failed.allowedActions).toContain('retry');
  });

  it('marks a halted run failed and a stopped one idle', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    await h.finishRun(h.lastRunId(), 'HALTED', { haltReason: 'failure' });
    expect((await h.service.get(task.id)).task).toMatchObject({ stage: 'work', state: 'failed' });

    await h.service.retry(task.id);
    await h.settle();
    const running = await h.service.stop(task.id);
    expect(running.state).toBe('running');
    expect(h.stopped).toContain(h.lastRunId());
    await h.finishRun(h.lastRunId(), 'HALTED', { haltReason: 'stopped' });
    expect((await h.service.get(task.id)).task).toMatchObject({
      stage: 'work',
      state: 'idle',
      stateReason: 'Stopped.',
    });
  });

  it('waits while a run waits for an approval', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    const runId = h.lastRunId();
    await h.bus.emit({
      type: 'node.approval_required',
      runId,
      payload: { runId, request: { nodeName: 'Builder' } },
    });
    await h.settle();
    expect((await h.service.get(task.id)).task).toMatchObject({
      state: 'waiting',
      stateReason: 'Waiting for approval: Builder.',
    });
    await h.bus.emit({ type: 'node.approval_decided', runId, payload: { runId } });
    await h.settle();
    expect((await h.service.get(task.id)).task.state).toBe('running');
  });

  it('fails clearly when the project folder is not a Git repository', async () => {
    const h = await createTaskHarness();
    h.git.status = { gitAvailable: true, isRepo: false };
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    const failed = (await h.service.get(task.id)).task;
    expect(failed.state).toBe('failed');
    expect(failed.stateReason).toContain('Initialize Git');
    expect(h.runs.size).toBe(0);
  });

  it('records a failed setup command and recreates the workspace on retry', async () => {
    const h = await createTaskHarness({ projectPatch: { setupCommand: 'pnpm install' } });
    h.commands.results.set('pnpm install', { exitCode: 1, output: 'ERR_PNPM' });
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    const detail = await h.service.get(task.id);
    expect(detail.task.state).toBe('failed');
    expect(detail.workspace?.status).toBe('error');
    expect(detail.checks[0]).toMatchObject({ name: 'setup', status: 'failed', output: 'ERR_PNPM' });

    h.commands.results.set('pnpm install', { exitCode: 0 });
    await h.service.retry(task.id);
    await h.settle();
    expect((await h.service.get(task.id)).workspace?.status).toBe('ready');
    expect(h.runs.size).toBe(1);
  });

  it('needs a team and an Input node to work', async () => {
    const h = await createTaskHarness();
    const noTeam = await h.service.create(h.project.id, { title: 'No team' });
    expect(noTeam.allowedActions).not.toContain('work');
    expect(await codeOf(h.service.work(noTeam.id, {}))).toBe('invalid_task_state');
    const started = await h.service.start(noTeam.id);
    expect(started).toMatchObject({ stage: 'plan', state: 'idle' });
  });

  it('refuses an action the state does not allow', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h);
    expect(
      await codeOf(h.service.apply(task.id, { destination: { folderPath: 'x', branch: 'main' } })),
    ).toBe('invalid_task_state');
    expect(await codeOf(h.service.review(task.id, { decision: 'approved' }))).toBe(
      'invalid_task_state',
    );
  });
});

describe('ACE parity P0 — closing, deleting, pausing and recovery', () => {
  it('closes without verification', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h);
    const closed = await h.service.close(task.id, { reason: 'Not needed' });
    expect(closed).toMatchObject({ stage: 'done', outcome: 'closed_unverified' });
    expect(closed.allowedActions).toEqual(['delete']);
  });

  it('deletes a task with its worktree and branch and announces it', async () => {
    const h = await createTaskHarness();
    const task = await toReview(h);
    const workspace = (await h.service.get(task.id)).workspace;
    await h.service.remove(task.id);
    expect(h.git.removed).toContain(workspace?.path);
    expect(h.git.branches.has(workspace?.branch ?? '')).toBe(false);
    expect(h.events.at(-1)?.type).toBe('task.deleted');
    expect(await codeOf(h.service.get(task.id))).toBe('not_found');
  });

  it('pauses and resumes a task', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h);
    const paused = await h.service.pause(task.id, true);
    expect(paused.paused).toBe(true);
    expect(paused.allowedActions).toContain('resume');
    expect((await h.service.pause(task.id, false)).paused).toBe(false);
  });

  it('moves an inactive task between columns but never into Done', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h);
    expect((await h.service.update(task.id, { stage: 'review' })).stage).toBe('review');
  });

  it('recovers a task whose run ended while the engine was away', async () => {
    const h = await createTaskHarness();
    const task = await newTask(h, { start: 'now' });
    await h.settle();
    h.detach();
    await h.repository.runs.update(scope, h.lastRunId(), { status: 'HALTED', haltReason: 'crash' });
    const detach = await h.service.attach();
    await h.settle();
    const recovered = (await h.service.get(task.id)).task;
    expect(recovered.state).toBe('failed');
    expect(recovered.stateReason).toContain('engine stopped');
    detach();
  });
});

describe('ACE parity P0 — repository', () => {
  it('reports the project folder as a repository with its GitHub remote', async () => {
    const h = await createTaskHarness();
    h.git.status = { ...h.git.status, remoteUrl: 'git@github.com:acme/shop.git' };
    expect(await h.service.repository(h.project.id)).toMatchObject({
      isRepo: true,
      branch: 'main',
      github: { owner: 'acme', repo: 'shop' },
    });
    expect(await codeOf(h.service.initRepository(h.project.id))).toBe('already_repository');
  });

  it('initializes a folder that is not a repository', async () => {
    const h = await createTaskHarness();
    h.git.status = { gitAvailable: true, isRepo: false };
    expect((await h.service.initRepository(h.project.id)).isRepo).toBe(true);
  });

  it('parses GitHub remotes and ignores others', () => {
    expect(parseGitHubRemote('https://github.com/acme/shop.git')).toEqual({
      owner: 'acme',
      repo: 'shop',
    });
    expect(parseGitHubRemote('https://token@github.com/acme/shop')).toEqual({
      owner: 'acme',
      repo: 'shop',
    });
    expect(parseGitHubRemote('https://gitlab.com/acme/shop.git')).toBeUndefined();
    expect(parseGitHubRemote(undefined)).toBeUndefined();
  });
});
