import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProjectNoteListResponseSchema,
  TaskDetailSchema,
  TaskListResponseSchema,
} from '@ace/contracts';
import { expect, test } from '@playwright/test';

import {
  api,
  engine,
  makeRepository,
  mockProvider,
  projectWithTeam,
  removeCreated,
  type Created,
} from './support.js';

/**
 * ACE parity P2 end to end (D280–D283) through the **real UI** against the **real engine**: a
 * _Software health_ responsibility scans a failing check into a suggestion, which _Add to Inbox_
 * turns into an Inbox task that is not started; a team note is written; an email is imported as an
 * Inbox task; and the Ace Assistant proposes a project from a sentence and creates it on confirm.
 *
 * Every outcome is read back from the engine over REST, never from the page alone.
 */

let root: string;
let created: Created;

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-parity-p2-'));
  created = { projectIds: [] };
});

test.afterEach(async () => {
  await removeCreated(created);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // a worktree the engine still holds on Windows; the OS reclaims the temp folder
  }
});

test('a failing check becomes a suggestion, and Add to Inbox makes a task that waits', async ({
  page,
}) => {
  const { repo } = makeRepository(root, 'shop');
  const { projectId, teamId } = await projectWithTeam(created, repo);
  await api(`/projects/${projectId}`, {
    method: 'PATCH',
    body: { checkCommands: [{ name: 'always fails', command: 'node -e "process.exit(3)"' }] },
  });
  // A task whose check fails: what a Software health scan reads.
  const failing = await api<{ id: string }>(`/projects/${projectId}/tasks`, {
    method: 'POST',
    body: { title: 'Break it', workflowId: teamId, start: 'now' },
  });
  await expect
    .poll(async () => TaskDetailSchema.parse(await api(`/tasks/${failing.id}`)).task.stage, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe('review');

  await page.goto(`/?token=${engine().token}`);
  await page.goto(`/projects/${projectId}/suggestions`);
  await expect(page.getByRole('heading', { name: 'Suggestions', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New responsibility' }).click();
  const dialog = page.getByRole('dialog', { name: 'New responsibility' });
  await dialog.getByLabel('What to watch').fill('Keep checks green');
  await dialog.getByLabel('Why it matters').fill('Red checks block delivery.');
  await dialog.getByLabel('What useful work looks like').fill('Every check passes.');
  await dialog.getByRole('button', { name: 'Add responsibility' }).click();

  const responsibility = page.getByRole('article', { name: 'Keep checks green' });
  await responsibility.getByRole('button', { name: 'Scan now' }).click();

  const suggestion = page.getByRole('article', {
    name: 'Fix the failing "always fails" check on task #1',
  });
  await expect(suggestion).toBeVisible({ timeout: 60_000 });
  await suggestion.getByRole('button', { name: 'Add to Inbox' }).click();
  await expect(suggestion.getByRole('link', { name: 'Open the task' })).toBeVisible();

  // The engine has a new Inbox task for it, and nothing was started.
  const tasks = TaskListResponseSchema.parse(await api(`/projects/${projectId}/tasks`)).items;
  const added = tasks.find((task) => task.title.includes('always fails'));
  expect(added).toMatchObject({ stage: 'inbox', state: 'idle' });
  const detail = TaskDetailSchema.parse(await api(`/tasks/${added?.id ?? ''}`));
  expect(detail.executions).toEqual([]);
});

test('a team note is written, and an imported email becomes an Inbox task', async ({ page }) => {
  const { repo } = makeRepository(root, 'shop');
  const { projectId } = await projectWithTeam(created, repo);
  await page.goto(`/?token=${engine().token}`);

  await page.goto(`/projects/${projectId}/notes`);
  const form = page.getByRole('form', { name: 'Add a note' });
  await form.getByLabel('New note').fill('Search lives in src/search.ts.');
  await form.getByRole('button', { name: 'Add note' }).click();
  await expect
    .poll(async () =>
      ProjectNoteListResponseSchema.parse(await api(`/projects/${projectId}/notes`)).items.map(
        (note) => [note.text, note.status],
      ),
    )
    .toEqual([['Search lives in src/search.ts.', 'verified']]);

  await page.goto(`/projects/${projectId}/tasks`);
  await page.getByRole('button', { name: 'Import email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import an email' });
  await dialog
    .getByLabel('Message')
    .fill('From: Ann <ann@example.com>\nSubject: Search is slow\n\nIt takes 3 s.');
  await dialog.getByLabel('Team').selectOption({ label: 'Single builder' });
  await dialog.getByRole('button', { name: 'Add to Inbox' }).click();
  await expect(dialog).toBeHidden();

  const tasks = TaskListResponseSchema.parse(await api(`/projects/${projectId}/tasks`)).items;
  expect(tasks.find((task) => task.title === 'Search is slow')).toMatchObject({
    stage: 'inbox',
    state: 'idle',
  });
  await expect(page.getByTestId('column-inbox')).toContainText('Search is slow');
});

test('the Assistant proposes a project from a sentence and creates it on confirm', async ({
  page,
}) => {
  // The team's agents start on the no-key mock models (D283).
  await api(`/providers/${await mockProvider(created)}/refresh-models`, { method: 'POST' });
  await page.goto(`/?token=${engine().token}`);
  await page.goto('/projects');
  const panel = page.getByTestId('assistant-panel');
  await panel
    .getByLabel('What do you want to build?')
    .fill('Build a booking app. Have one agent plan it and another review it, $2 per run.');
  await panel.getByRole('button', { name: 'Propose' }).click();

  const proposal = panel.getByTestId('assistant-proposal');
  await expect(proposal).toBeVisible();
  // No model was chosen, so the rules drafted it — and the page says so.
  await expect(proposal.getByTestId('proposal-source')).toHaveAttribute('data-source', 'rules');
  await expect(proposal.getByLabel('Project name')).toHaveValue('Booking app');
  const folder = join(root, 'booking');
  await proposal.getByLabel('Folder (optional)').fill(folder);
  await panel.getByTestId('assistant-apply').click();

  await expect(page).toHaveURL(/\/projects\/[0-9A-Z]{26}\/workflows\/[0-9A-Z]{26}/);
  const [, projectId] = /\/projects\/([0-9A-Z]{26})\//.exec(page.url()) ?? [];
  if (projectId !== undefined) created.projectIds.push(projectId);
  const project = await api<{ name: string; maxCostPerRunUsd?: number; folderPath: string }>(
    `/projects/${projectId ?? ''}`,
  );
  expect(project).toMatchObject({ name: 'Booking app', maxCostPerRunUsd: 2 });
  expect(existsSync(folder)).toBe(true);
});
