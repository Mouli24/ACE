import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskDetailSchema, TaskListResponseSchema, type TaskDetail } from '@ace/contracts';
import { expect, test } from '@playwright/test';

/**
 * ACE parity P0 end to end (docs/ACE_FEATURE_PARITY.md §5, D267–D271): the Build loop through the
 * **real UI** against the **real engine** and **real Git** — a brief becomes a task, the team runs in
 * the task's own worktree, the change is committed and shown on Changes, and Apply merges it into the
 * project's branch only after the destination is confirmed.
 *
 * The team is the _Single builder_ template on the mock coder (D279), whose `ace-mock:write`
 * directives edit files in the run's working folder, so no model key is needed. Every "did it really
 * happen?" is asked of the engine over REST or of the repository with `git`, never of the page alone.
 */

interface EngineHandle {
  url: string;
  token: string;
}

function engine(): EngineHandle {
  const handleFile = fileURLToPath(new URL('../.playwright-engine.json', import.meta.url));
  return JSON.parse(readFileSync(handleFile, 'utf8')) as EngineHandle;
}

async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}) {
  const { url, token } = engine();
  const response = await fetch(`${url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

let root: string;
/** What this test added to the suite's shared engine, removed afterwards so later rows see none of it. */
let created: { projectId?: string; providerId?: string };

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-parity-e2e-'));
  created = {};
});

test.afterEach(async () => {
  // The project first, its workflows before it: deleting a project leaves its workflows (and their
  // nodes, which name the provider) in place, so they go explicitly. Its task worktrees go with it.
  if (created.projectId !== undefined) {
    const workflows = await api<{ items: { id: string }[] }>(
      `/projects/${created.projectId}/workflows`,
    );
    for (const workflow of workflows.items) {
      await api(`/workflows/${workflow.id}`, { method: 'DELETE' });
    }
    await api(`/projects/${created.projectId}`, { method: 'DELETE' });
  }
  if (created.providerId !== undefined) {
    await api(`/providers/${created.providerId}`, { method: 'DELETE' });
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // a worktree the engine still holds on Windows; the OS reclaims the temp folder
  }
});

test('a brief becomes a task, runs in its worktree, and Apply merges it into main', async ({
  page,
}) => {
  // A repository with one commit on main, a project on it, the mock provider and a team.
  const repo = join(root, 'shop');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Demo shop\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    body: { name: `Shop ${Date.now()}`, folderPath: repo },
  });
  created.projectId = project.id;
  const providers = await api<{ items: { id: string; type: string }[] }>('/providers');
  let mock = providers.items.find((provider) => provider.type === 'mock');
  if (mock === undefined) {
    mock = await api<{ id: string; type: string }>('/providers', {
      method: 'POST',
      body: { type: 'mock', name: 'Mock' },
    });
    created.providerId = mock.id;
  }
  await api(`/providers/${mock.id}/refresh-models`, { method: 'POST' });
  await api('/templates/single-builder/instantiate', {
    method: 'POST',
    body: { projectId: project.id },
  });

  // The brief, through the New task dialog.
  const { token } = engine();
  await page.goto(`/?token=${token}`);
  await page.goto(`/projects/${project.id}/tasks`);
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Document the search feature');
  await page
    .getByLabel('Brief')
    .fill(
      [
        'Add a Search section to the README.',
        'ace-mock:write README.md',
        '# Demo shop',
        '',
        '## Search',
        '',
        'Type in the box to filter the list.',
        'ace-mock:end',
      ].join('\n'),
    );
  await page.locator('#task-team').selectOption({ label: 'Single builder' });
  await page.locator('#task-finish-line').selectOption('apply_local');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Start now' }).check();
  await dialog.getByRole('button', { name: 'Start now' }).click();

  // The engine says it reached Review, in its own worktree on its own branch.
  let detail: TaskDetail | undefined;
  await expect
    .poll(
      async () => {
        const list = TaskListResponseSchema.parse(await api(`/projects/${project.id}/tasks`));
        const task = list.items[0];
        if (task === undefined) return 'none';
        detail = TaskDetailSchema.parse(await api(`/tasks/${task.id}`));
        return detail.task.state === 'failed'
          ? `failed: ${detail.task.stateReason ?? ''}`
          : detail.task.stage;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe('review');
  const workspace = detail?.workspace;
  expect(workspace?.branch).toMatch(/^ace\/task-1-/);
  expect(workspace?.path).not.toBe(repo);
  // Nothing has touched main yet.
  expect(git(repo, 'rev-parse', 'main')).toBe(baseSha);

  // The page shows it: open the task from the board, and the change on Changes.
  await page.getByText('Document the search feature').first().click();
  const taskPage = page.getByTestId('task-page');
  await expect(taskPage).toBeVisible();
  await taskPage.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(taskPage.getByRole('button', { name: /README\.md/ }).first()).toBeVisible();

  // Apply asks to confirm the destination, then merges.
  await page.getByTestId('review-panel').getByRole('button', { name: 'Apply' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('main');
  await confirm.getByRole('button', { name: 'Apply' }).click();

  const taskId = detail?.task.id ?? '';
  await expect
    .poll(async () => TaskDetailSchema.parse(await api(`/tasks/${taskId}`)).task.outcome, {
      timeout: 30_000,
    })
    .toBe('applied');

  // Git agrees: main moved, by a merge of the task branch, and carries the change.
  expect(git(repo, 'rev-parse', 'main')).not.toBe(baseSha);
  expect(git(repo, 'log', '-1', '--format=%s', 'main')).toContain('ACE task #1');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('## Search');
  await expect(page.getByTestId('task-page')).toContainText(/Done|Applied/);
});
