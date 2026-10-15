import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, type Page } from '@playwright/test';

import {
  NOT_BUILT,
  api,
  card,
  engine,
  expect,
  mockProvider,
  newProject,
  openCanvas,
  openChat,
  seedAgents,
  sendChat,
  startRunFromMenu,
  type Seeded,
} from './helpers.js';

/**
 * PG-2.4 No silent loss of undo (product-gaps prompt, Phase 2). Today a checkpoint that cannot
 * begin is only logged (`runs/index.ts` beginRunCheckpoint, and the same in chat) and the writing
 * run or turn goes on with nothing to revert to. Red until PG-2.4 lands.
 *
 * The checkpoint store keeps one bare git repository per project at
 * `<dataDir>/checkpoints/<projectId>.git` (`tools/src/checkpoints/git-store.ts`). A plain file in
 * that place makes the store's first `mkdir` fail, so every checkpoint of the project fails to begin
 * while the project folder itself stays healthy — the condition PG-2.4 is about.
 */

async function writingProject(label: string): Promise<Seeded> {
  const folder = mkdtempSync(join(tmpdir(), `ace-pg-${label}-`));
  writeFileSync(join(folder, 'README.md'), '# PG-2.4\n');
  const projectId = await newProject(label, folder);
  const checkpoints = join(engine().dataDir, 'checkpoints');
  mkdirSync(checkpoints, { recursive: true });
  writeFileSync(join(checkpoints, `${projectId}.git`), 'not a git store');

  const providerId = await mockProvider();
  return seedAgents(
    label,
    [
      {
        name: 'Coder',
        providerId,
        modelId: 'mock-chat',
        config: { tools: { enabled: ['write_file'], maxToolCalls: 5, allowedDomains: [] } },
      },
    ],
    { projectId },
  );
}

/** Setup proof: a checkpoint of this kind failed to begin (the condition, not yet the symptom). */
async function hasFailedCheckpoint(projectId: string, kind: 'run' | 'chat'): Promise<boolean> {
  type Row = { kind: string; status: string };
  const list = await api<Row[] | { items: Row[] }>(`/projects/${projectId}/checkpoints`);
  const items = Array.isArray(list) ? list : list.items;
  return items.some((checkpoint) => checkpoint.kind === kind && checkpoint.status === 'failed');
}

async function expectUndoChoice(page: Page): Promise<void> {
  await expect(page.getByText("Can't record changes for undo")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Run without undo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
}

test.describe('PG-2.4 no silent loss of undo', () => {
  test('a writing run whose checkpoint cannot begin stops and asks: Run without undo / Cancel', async ({
    page,
  }) => {
    test.fail(NOT_BUILT, 'PG-2.4: the run goes on without a checkpoint, silently');
    const flow = await writingProject('undo-run');
    await openCanvas(page, flow.projectId, flow.workflowId);
    await expect(card(page, flow.byName('Coder').id)).toBeVisible({ timeout: 15_000 });
    await startRunFromMenu(page);
    await expect
      .poll(() => hasFailedCheckpoint(flow.projectId, 'run'), {
        timeout: 30_000,
        message: "the run's checkpoint failed to begin",
      })
      .toBe(true);
    await expectUndoChoice(page);
  });

  test('a writing chat turn whose checkpoint cannot begin asks the same', async ({ page }) => {
    test.fail(NOT_BUILT, 'PG-2.4: the chat turn goes on without a checkpoint, silently');
    const flow = await writingProject('undo-chat');
    await openCanvas(page, flow.projectId, flow.workflowId);
    const panel = await openChat(page, flow.byName('Coder').id);
    await sendChat(panel, 'Edit the README');
    await expect
      .poll(() => hasFailedCheckpoint(flow.projectId, 'chat'), {
        timeout: 30_000,
        message: "the turn's checkpoint failed to begin",
      })
      .toBe(true);
    await expectUndoChoice(page);
  });
});
