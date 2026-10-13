import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getSocket } from '../../app/socket';
import { createNode } from '../../nodes/factory';
import {
  checkpoints,
  db,
  installMockServer,
  installMockSocket,
  renderWithQuery,
} from '../../test/app';
import { useChangesStore } from './changes-store';
import { ChangesView } from './ChangesView';
import { useReviewStore } from './review-store';

installMockServer();
installMockSocket();

const RUN = '01JBXQ8Z9KQ4R7N2VWXYZ0RNAB';

function seed() {
  const projectId = db.createProject({ name: 'Shop' }).id;
  const workflow = db.createWorkflow(projectId, 'Flow');
  return { projectId, workflowId: workflow.id };
}

const fileOf = (projectId: string, path: string): string | undefined => {
  const entry = db.filesOf(projectId)[path];
  return entry?.kind === 'file' ? entry.content : undefined;
};

async function open(projectId: string, workflowId?: string) {
  renderWithQuery(<ChangesView projectId={projectId} workflowId={workflowId} />);
  return screen.findByRole('region', { name: 'Changes' });
}

describe('D300 Forge’s Changes view', () => {
  it('says when nothing has been changed yet', async () => {
    const { projectId } = seed();
    const view = await open(projectId);
    expect(await within(view).findByText(/No agent changes yet/)).toBeInTheDocument();
  });

  it('lists checkpoints to review first, each with its source, when, and every file’s +/−', async () => {
    const { projectId } = seed();
    const old = checkpoints.seed(projectId, [{ path: 'old.ts', before: 'a\n', after: 'b\n' }], {
      kind: 'run',
      runId: RUN,
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    const fresh = checkpoints.seed(projectId, [
      { path: 'src/a.ts', before: 'one\ntwo\n', after: 'one\nTWO\nthree\n' },
      { path: 'src/new.ts', after: 'fresh\n' },
    ]);
    // the older one is decided: it lists after the one waiting for review
    checkpoints.act(projectId, old.id, { action: 'keep' });

    const view = await open(projectId);
    const entries = await within(view).findAllByRole('article');
    expect(entries.map((entry) => entry.getAttribute('data-testid'))).toEqual([
      `checkpoint-${fresh.id}`,
      `checkpoint-${old.id}`,
    ]);
    const first = entries[0]!;
    expect(first).toHaveAccessibleName('Chat with an agent, To review');
    expect(within(first).getByText('Just now')).toBeInTheDocument();
    const a = within(first).getByTestId(`change-${fresh.id}-src/a.ts`);
    expect(a).toHaveTextContent('a.ts');
    expect(within(a).getByLabelText('2 added, 1 removed')).toHaveTextContent('+2 −1');
    expect(entries[1]).toHaveAccessibleName(`Run ${RUN.slice(-6)}, Kept`);
    expect(within(entries[1]!).queryByRole('button', { name: 'Keep all' })).toBeNull();
  });

  it('names a chat checkpoint by its node, from the workflow', async () => {
    const { projectId, workflowId } = seed();
    const writer = { ...createNode('agent', workflowId, { x: 0, y: 0 }), name: 'Writer' };
    db.commitGraph(workflowId, [writer], [], { silent: true });
    checkpoints.seed(projectId, [{ path: 'a.ts', before: 'a\n', after: 'b\n' }], {
      nodeId: writer.id,
    });
    const view = await open(projectId, workflowId);
    await within(view).findByRole('article', { name: 'Chat with Writer, To review' });
  });

  it('keeps all, and the checkpoint closes as kept', async () => {
    const user = userEvent.setup();
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'a.ts', before: 'a\n', after: 'b\n' }]);
    const view = await open(projectId);
    await user.click(await within(view).findByRole('button', { name: 'Keep all' }));
    await waitFor(() =>
      expect(within(view).getByTestId(`checkpoint-status-${seeded.id}`)).toHaveTextContent('Kept'),
    );
    expect(fileOf(projectId, 'a.ts')).toBe('b\n');
    expect(within(view).getByTestId(`change-${seeded.id}-a.ts`)).toHaveTextContent('kept');
  });

  it('reverts one file: its before text comes back, the rest still wait', async () => {
    const user = userEvent.setup();
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [
      { path: 'a.ts', before: 'a0\n', after: 'a1\n' },
      { path: 'b.ts', before: 'b0\n', after: 'b1\n' },
    ]);
    const view = await open(projectId);
    await user.click(await within(view).findByRole('button', { name: 'Revert a.ts' }));
    await waitFor(() =>
      expect(within(view).getByTestId(`change-${seeded.id}-a.ts`)).toHaveTextContent('reverted'),
    );
    expect(fileOf(projectId, 'a.ts')).toBe('a0\n');
    expect(within(view).getByRole('button', { name: 'Revert b.ts' })).toBeEnabled();
  });

  it('shows a refused revert’s reason on that file, and reverts the others', async () => {
    const user = userEvent.setup();
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [
      { path: 'a.ts', before: 'a0\n', after: 'a1\n' },
      { path: 'b.ts', before: 'b0\n', after: 'b1\n' },
    ]);
    db.writeFileExternally(projectId, 'a.ts', 'mine\n');
    const view = await open(projectId);
    await user.click(await within(view).findByRole('button', { name: 'Revert all' }));

    const a = within(view).getByTestId(`change-${seeded.id}-a.ts`);
    expect(await within(a).findByRole('alert')).toHaveTextContent(
      "a.ts changed after the agent's edit; review it before reverting",
    );
    expect(fileOf(projectId, 'a.ts')).toBe('mine\n');
    await waitFor(() =>
      expect(within(view).getByTestId(`change-${seeded.id}-b.ts`)).toHaveTextContent('reverted'),
    );
  });

  it('opens a file’s review from its name', async () => {
    const user = userEvent.setup();
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'src/a.ts', before: 'a\n', after: 'b\n' }]);
    const view = await open(projectId);
    await user.click(await within(view).findByRole('button', { name: 'Review src/a.ts' }));
    expect(useReviewStore.getState().projects[projectId]).toEqual({
      reviews: [{ key: `${seeded.id}:src/a.ts`, checkpointId: seeded.id, path: 'src/a.ts' }],
      active: `${seeded.id}:src/a.ts`,
    });
  });

  it('follows checkpoint.updated live: a new one appears while it is still recording', async () => {
    const { projectId } = seed();
    const view = await open(projectId);
    await within(view).findByText(/No agent changes yet/);
    await vi.waitFor(() => expect(getSocket()?.status).toBe('open'));
    const recording = checkpoints.seed(projectId, [], { status: 'recording' });
    expect(
      await within(view).findByRole('article', { name: 'Chat with an agent, Recording…' }),
    ).toHaveAttribute('data-testid', `checkpoint-${recording.id}`);
  });

  it('says a failed checkpoint’s changes cannot be reverted (design §10)', async () => {
    const { projectId } = seed();
    checkpoints.seed(projectId, [], {
      status: 'failed',
      error: 'git is not installed or not on PATH.',
    });
    const view = await open(projectId);
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      "Changes were made but can't be reverted: git is not installed or not on PATH.",
    );
  });

  it('lists the person’s own files and uncaptured ones without Revert, and Revert all leaves them', async () => {
    const user = userEvent.setup();
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [
      { path: 'agent.ts', before: 'a0\n', after: 'a1\n' },
      { path: 'mine.ts', before: 'm0\n', after: 'm1\n', state: 'person' },
      { path: 'big.json', after: '{}', state: 'not_revertible', reason: 'too_large' },
    ]);
    const view = await open(projectId);

    const mine = await within(view).findByTestId(`change-${seeded.id}-mine.ts`);
    expect(mine).toHaveTextContent('You edited this during the session');
    expect(within(mine).queryByRole('button', { name: 'Revert mine.ts' })).toBeNull();
    const big = within(view).getByTestId(`change-${seeded.id}-big.json`);
    expect(big).toHaveTextContent(
      "ACE could not capture this file (over 5 MB), so it can't be reverted",
    );
    expect(within(big).queryByRole('button', { name: 'Revert big.json' })).toBeNull();

    await user.click(within(view).getByRole('button', { name: 'Revert all' }));
    await waitFor(() =>
      expect(within(view).getByTestId(`checkpoint-status-${seeded.id}`)).toHaveTextContent(
        'Reverted',
      ),
    );
    expect(fileOf(projectId, 'agent.ts')).toBe('a0\n');
    expect(fileOf(projectId, 'mine.ts')).toBe('m1\n');
    expect(fileOf(projectId, 'big.json')).toBe('{}');
  });

  it('outlines the checkpoint an Explorer marker asked for', async () => {
    const { projectId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'a.ts', before: 'a\n', after: 'b\n' }]);
    useChangesStore.getState().show(projectId, seeded.id);
    const view = await open(projectId);
    expect(await within(view).findByTestId(`checkpoint-${seeded.id}`)).toHaveClass(
      'shadow-[0_0_0_1.5px_#ef6b3f]',
    );
  });
});
