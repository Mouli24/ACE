import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { checkpoints, db, installMockServer, queryClient } from '../../test/app';
import { ChangesCard } from './ChangesCard';
import { useReviewStore } from './review-store';

installMockServer();

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

/** The card as the chat column renders it: inside a workflow's route. */
function renderCard(projectId: string, checkpointId: string, workflowId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/workflows/${workflowId}`]}>
        <Routes>
          <Route
            path="/projects/:projectId/workflows/:workflowId/*"
            element={
              <>
                <ChangesCard projectId={projectId} checkpointId={checkpointId} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Revert all, then the confirm's own Revert all (fix A-M9). */
async function revertAll(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Revert all' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revert all changes?' });
  await user.click(within(dialog).getByRole('button', { name: 'Revert all' }));
}

function seed() {
  const projectId = db.createProject({ name: 'Shop' }).id;
  const workflowId = db.createWorkflow(projectId, 'Flow').id;
  return { projectId, workflowId };
}

describe('D300 the Changes card under a chat turn', () => {
  it('shows the files with +/−, Review, Keep all and Revert all, and says what is not covered', async () => {
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [
      { path: 'src/a.ts', before: 'one\n', after: 'one\ntwo\n' },
      { path: 'gone.ts', before: 'x\n' },
    ]);
    renderCard(projectId, seeded.id, workflowId);
    const card = await screen.findByRole('region', { name: 'Changes' });
    expect(card).toHaveTextContent('2 files');
    expect(within(card).getByLabelText('1 added, 0 removed')).toHaveTextContent('+1 −0');
    expect(within(card).getByLabelText('0 added, 1 removed')).toBeInTheDocument();
    for (const name of ['Review', 'Keep all', 'Revert all']) {
      expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(card).toHaveTextContent('Ignored folders and files over 5 MB are not checkpointed.');
    expect(card).toHaveClass('rounded-[12px]', 'border-[var(--line)]', 'bg-[var(--surface)]');
  });

  it('Review opens the first file’s diff in Forge, switching there from Ideate', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'src/a.ts', before: 'a\n', after: 'b\n' }]);
    renderCard(projectId, seeded.id, workflowId);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(useReviewStore.getState().projects[projectId]?.active).toBe(`${seeded.id}:src/a.ts`);
    expect(screen.getByTestId('where')).toHaveTextContent(
      `/projects/${projectId}/workflows/${workflowId}/forge`,
    );
  });

  it('Revert all puts the files back and the card says so', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'a.ts', before: 'a\n', after: 'b\n' }]);
    renderCard(projectId, seeded.id, workflowId);
    await revertAll(user);
    const card = screen.getByRole('region', { name: 'Changes' });
    await waitFor(() => expect(card).toHaveTextContent('Reverted'));
    expect(within(card).queryByRole('button', { name: 'Keep all' })).toBeNull();
    const entry = db.filesOf(projectId)['a.ts'];
    expect(entry?.kind === 'file' ? entry.content : undefined).toBe('a\n');
  });

  it('Revert all asks first, naming the count; Cancel reverts nothing (fix A-M9)', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [
      { path: 'a.ts', before: 'a\n', after: 'b\n' },
      { path: 'gone.ts', before: 'x\n' },
    ]);
    renderCard(projectId, seeded.id, workflowId);
    await user.click(await screen.findByRole('button', { name: 'Revert all' }));

    const dialog = await screen.findByRole('dialog', { name: 'Revert all changes?' });
    expect(dialog).toHaveTextContent('Revert 2 files to how they were before this change.');
    // the agent added nothing, so nothing is deleted
    expect(dialog).not.toHaveTextContent('deleted');
    // the theme's destructive button, as the Explorer's Delete confirm
    expect(within(dialog).getByRole('button', { name: 'Revert all' })).toHaveClass(
      'text-[#c94c27]',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent('To review');
    expect(checkpoints.get(projectId, seeded.id).status).toBe('pending');
    const entry = db.filesOf(projectId)['a.ts'];
    expect(entry?.kind === 'file' ? entry.content : undefined).toBe('b\n');
  });

  it('lists the files a Revert all will delete: the ones the agent added (fix A-M9)', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const added = Array.from({ length: 12 }, (_, index) => ({
      path: `src/new-${String(index + 1).padStart(2, '0')}.ts`,
      after: 'x\n',
    }));
    const seeded = checkpoints.seed(projectId, [
      { path: 'a.ts', before: 'a\n', after: 'b\n' },
      ...added,
    ]);
    renderCard(projectId, seeded.id, workflowId);
    await user.click(await screen.findByRole('button', { name: 'Revert all' }));

    const dialog = await screen.findByRole('dialog', { name: 'Revert all changes?' });
    expect(dialog).toHaveTextContent('Revert 13 files to how they were before this change.');
    expect(dialog).toHaveTextContent('These files will be deleted:');
    const list = within(dialog).getByRole('list', { name: 'Files to be deleted' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(added.slice(0, 10).map((file) => file.path));
    expect(dialog).toHaveTextContent('and 2 more');

    await user.click(within(dialog).getByRole('button', { name: 'Revert all' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent('Reverted'),
    );
    expect(db.filesOf(projectId)['src/new-01.ts']).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says one added file in the singular', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'new.ts', after: 'x\n' }]);
    renderCard(projectId, seeded.id, workflowId);
    await user.click(await screen.findByRole('button', { name: 'Revert all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revert all changes?' });
    expect(dialog).toHaveTextContent('Revert 1 file to how it was before this change.');
    expect(dialog).toHaveTextContent('This file will be deleted:');
    expect(dialog).not.toHaveTextContent('more');
  });

  it('shows a refused revert on its file', async () => {
    const user = userEvent.setup();
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [{ path: 'a.ts', before: 'a\n', after: 'b\n' }]);
    db.writeFileExternally(projectId, 'a.ts', 'mine\n');
    renderCard(projectId, seeded.id, workflowId);
    await revertAll(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "a.ts changed after the agent's edit; review it before reverting",
    );
  });

  it('says a failed checkpoint’s changes cannot be reverted (design §10)', async () => {
    const { projectId, workflowId } = seed();
    const seeded = checkpoints.seed(projectId, [], { status: 'failed', error: 'no git' });
    renderCard(projectId, seeded.id, workflowId);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Changes were made but can't be reverted: no git",
    );
    expect(screen.queryByRole('button', { name: 'Revert all' })).toBeNull();
  });
});
