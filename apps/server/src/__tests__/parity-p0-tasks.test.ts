import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  RepositoryInfoSchema,
  TaskChangesSchema,
  TaskDetailSchema,
  TaskFileDiffSchema,
  TaskSchema,
  type Task,
  type TaskDetail,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/*
 * ACE parity P0, end to end on the real engine (p0-tasks-build-design.md §1): a project that is a
 * real Git repository, a task assigned to the Single builder team on the mock coder, its work in an
 * isolated worktree, the changes recorded and checked, the review, and Apply merging into the
 * project folder — plus the conflict path, which must leave the user's repository untouched.
 */

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let engine: RunningEngine;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test User',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

async function until(
  what: string,
  read: () => Promise<TaskDetail>,
  done: (detail: TaskDetail) => boolean,
  timeoutMs = 60_000,
): Promise<TaskDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskDetail | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last?.task)}`);
}

const detailOf = async (id: string): Promise<TaskDetail> =>
  TaskDetailSchema.parse((await api(`/tasks/${id}`)).body);

/** A project on a fresh repository, with the Single builder team on the mock provider. */
async function setUp(): Promise<{ projectId: string; repo: string; teamId: string }> {
  const repo = join(root, 'shop');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Shop\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');

  const project = (
    await api('/projects', { method: 'POST', body: { name: 'Shop', folderPath: repo } })
  ).body as { id: string };
  const provider = (
    await api('/providers', { method: 'POST', body: { type: 'mock', name: 'Mock' } })
  ).body as { id: string };
  await api(`/providers/${provider.id}/refresh-models`, { method: 'POST' });
  const team = (
    await api('/templates/single-builder/instantiate', {
      method: 'POST',
      body: { projectId: project.id },
    })
  ).body as { workflow: { id: string } };
  return { projectId: project.id, repo, teamId: team.workflow.id };
}

/** A file's text with CRLF read as LF. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

const directive = (path: string, content: string) =>
  `ace-mock:write ${path}\n${content}\nace-mock:end`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ace-p0-tasks-'));
  engine = await startEngine({ dataDir: join(root, 'data'), port: 0, env: {} });
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

describe.skipIf(!gitAvailable)(
  'ACE parity P0 — a task from brief to applied change, on the real engine',
  () => {
    it('works in a worktree, records and checks the change, and applies it after review', async () => {
      const { projectId, repo, teamId } = await setUp();
      const checked = await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: {
          checkCommands: [
            {
              name: 'hello exists',
              command: `node -e "process.exit(require('fs').existsSync('docs/hello.md') ? 0 : 1)"`,
            },
          ],
        },
      });
      expect(checked.status).toBe(200);

      const created = await api(`/projects/${projectId}/tasks`, {
        method: 'POST',
        body: {
          title: 'Add a hello document',
          brief: `Write docs/hello.md.\n${directive('docs/hello.md', '# Hello\nWritten by the mock coder.')}`,
          workflowId: teamId,
          finishLine: 'apply_local',
          start: 'now',
        },
      });
      expect(created.status).toBe(201);
      const task = TaskSchema.parse(created.body);
      // No planner: Start goes straight to work.
      expect(task).toMatchObject({ number: 1, stage: 'work', state: 'running' });

      const reviewed = await until(
        'review',
        () => detailOf(task.id),
        (d) => d.task.stage === 'review' || d.task.state === 'failed',
      );
      expect(reviewed.task, reviewed.task.stateReason).toMatchObject({
        stage: 'review',
        state: 'idle',
      });

      // The run worked in the worktree under the data folder — never in the project folder.
      const workspace = reviewed.workspace!;
      expect(resolve(workspace.path).startsWith(resolve(join(root, 'data', 'workspaces')))).toBe(
        true,
      );
      expect(workspace.branch).toBe('ace/task-1-add-a-hello-document');
      expect(lf(readFileSync(join(workspace.path, 'docs', 'hello.md'), 'utf8'))).toBe(
        '# Hello\nWritten by the mock coder.\n',
      );
      expect(existsSync(join(repo, 'docs', 'hello.md'))).toBe(false);

      // Recorded on the task branch and checked against that commit.
      const execution = reviewed.executions.at(-1)!;
      expect(execution).toMatchObject({ kind: 'work', status: 'completed', changedFiles: 1 });
      expect(execution.commitSha).toBe(workspace.headSha);
      expect(sh(workspace.path, 'log', '-1', '--format=%s')).toBe(
        'ACE task #1: Add a hello document (run 1)',
      );
      expect(reviewed.checks.map((c) => [c.name, c.status, c.headSha])).toEqual([
        ['hello exists', 'passed', workspace.headSha],
      ]);

      const changes = TaskChangesSchema.parse((await api(`/tasks/${task.id}/changes`)).body);
      expect(changes.files).toEqual([
        { path: 'docs/hello.md', status: 'added', additions: 2, deletions: 0, binary: false },
      ]);
      const diff = TaskFileDiffSchema.parse(
        (await api(`/tasks/${task.id}/changes/diff?path=docs/hello.md`)).body,
      );
      expect(diff.patch).toContain('+# Hello');

      // Review, then Apply to the destination the client shows.
      const approved = await api(`/tasks/${task.id}/review`, {
        method: 'POST',
        body: { decision: 'approved', headSha: workspace.headSha },
      });
      expect(TaskSchema.parse(approved.body)).toMatchObject({ stage: 'review', state: 'idle' });
      const repoInfo = RepositoryInfoSchema.parse(
        (await api(`/projects/${projectId}/repository`)).body,
      );
      expect(repoInfo).toMatchObject({ isRepo: true, branch: 'main', clean: true });

      const wrong = await api(`/tasks/${task.id}/apply`, {
        method: 'POST',
        body: { destination: { folderPath: repo, branch: 'release' } },
      });
      expect(wrong.status).toBe(409);

      const applied = await api(`/tasks/${task.id}/apply`, {
        method: 'POST',
        body: { destination: { folderPath: repoInfo.folderPath, branch: 'main' } },
      });
      expect(applied.status).toBe(200);
      expect(TaskSchema.parse(applied.body)).toMatchObject({ stage: 'done', outcome: 'applied' });
      expect(readFileSync(join(repo, 'docs', 'hello.md'), 'utf8')).toContain('# Hello');
      expect(sh(repo, 'log', '-1', '--format=%s')).toBe('ACE task #1: Add a hello document');
      expect(existsSync(workspace.path)).toBe(false);

      const done = await detailOf(task.id);
      expect(done.workspace?.status).toBe('applied');
      expect(done.deliveries.map((d) => [d.kind, d.status])).toEqual([
        ['apply_local', 'succeeded'],
      ]);
      // The changes stay readable from the source repository once the worktree is gone.
      expect(
        TaskChangesSchema.parse((await api(`/tasks/${task.id}/changes`)).body).files,
      ).toHaveLength(1);
    }, 120_000);

    it('keeps a conflicting change in review and leaves the repository untouched', async () => {
      const { projectId, repo, teamId } = await setUp();
      const created = TaskSchema.parse(
        (
          await api(`/projects/${projectId}/tasks`, {
            method: 'POST',
            body: {
              title: 'Retitle the readme',
              brief: directive('README.md', '# Shop by ACE'),
              workflowId: teamId,
              finishLine: 'apply_local',
              start: 'now',
            },
          })
        ).body,
      );
      const reviewed = await until(
        'review',
        () => detailOf(created.id),
        (d) => d.task.stage === 'review' || d.task.state === 'failed',
      );
      expect(reviewed.task.stage).toBe('review');

      // Meanwhile the user changes the same line on main.
      writeFileSync(join(repo, 'README.md'), '# Shop (by hand)\n');
      sh(repo, 'commit', '-qam', 'by hand');
      const before = sh(repo, 'rev-parse', 'HEAD');

      const applied = await api(`/tasks/${created.id}/apply`, {
        method: 'POST',
        body: { destination: { folderPath: repo, branch: 'main' } },
      });
      const task: Task = TaskSchema.parse(applied.body);
      expect(task).toMatchObject({ stage: 'review', state: 'failed' });
      expect(task.stateReason).toContain('README.md');
      expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(sh(repo, 'status', '--porcelain')).toBe('');
      // Line endings follow the machine's core.autocrlf.
      expect(lf(readFileSync(join(repo, 'README.md'), 'utf8'))).toBe('# Shop (by hand)\n');

      const retried = TaskSchema.parse(
        (await api(`/tasks/${created.id}/retry`, { method: 'POST' })).body,
      );
      expect(retried).toMatchObject({ stage: 'review', state: 'idle' });
    }, 120_000);

    it('initializes a folder that is not a repository, and refuses work until it is one', async () => {
      const folder = join(root, 'plain');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'notes.txt'), 'hi\n');
      const project = (
        await api('/projects', { method: 'POST', body: { name: 'Plain', folderPath: folder } })
      ).body as { id: string };
      const before = RepositoryInfoSchema.parse(
        (await api(`/projects/${project.id}/repository`)).body,
      );
      expect(before.isRepo).toBe(false);

      const init = await api(`/projects/${project.id}/repository/init`, { method: 'POST' });
      expect(init.status).toBe(200);
      const after = RepositoryInfoSchema.parse(init.body);
      expect(after).toMatchObject({ isRepo: true, branch: 'main', clean: true });
      expect(sh(folder, 'ls-files')).toBe('notes.txt');
      expect(
        (await api(`/projects/${project.id}/repository/init`, { method: 'POST' })).status,
      ).toBe(409);
    }, 60_000);
  },
);
