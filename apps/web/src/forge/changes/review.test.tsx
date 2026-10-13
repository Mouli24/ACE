import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { checkpoints, db, installMockServer, queryClient, renderWithQuery } from '../../test/app';
import { openFile } from '../editor/actions';
import { EditorArea } from '../editor/EditorArea';
import { useEditorStore } from '../editor/editor-store';
import { FileTree } from '../explorer/FileTree';
import { ProblemsView } from '../panel/ProblemsView';
import { useProblemsStore } from '../panel/problems-store';
import { useChangesStore } from './changes-store';
import { openReview } from './review-actions';
import { useReviewStore } from './review-store';

installMockServer();

function seed() {
  const projectId = db.createProject({ name: 'Shop' }).id;
  db.seedFiles(projectId, { 'README.md': '# Shop\n' });
  const seeded = checkpoints.seed(projectId, [
    { path: 'src/a.ts', before: 'one\n', after: 'one\ntwo\n' },
    { path: 'logo.png', before: 'x', after: 'y', binary: true },
  ]);
  return { projectId, checkpointId: seeded.id };
}

describe('D300 reviewing an agent change in the editor area', () => {
  it('opens a read-only "<file> (agent change)" tab: before on the left, after on the right', async () => {
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));

    expect(await screen.findByRole('tab', { name: 'a.ts (agent change)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const view = screen.getByRole('region', { name: 'a.ts (agent change)' });
    expect(await within(view).findByTestId('review-before')).toHaveTextContent('one');
    expect(within(view).getByTestId('review-after').textContent).toBe('one\ntwo\n');
    expect(within(view).getByText('agent changed')).toBeInTheDocument();
    expect(within(view).getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });

  it('keeps or reverts the one file from the review bar', async () => {
    const user = userEvent.setup();
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await user.click(await screen.findByRole('button', { name: 'Revert' }));
    const view = screen.getByRole('region', { name: 'a.ts (agent change)' });
    await waitFor(() => expect(within(view).getByText('reverted')).toBeInTheDocument());
    const entry = db.filesOf(projectId)['src/a.ts'];
    expect(entry?.kind === 'file' ? entry.content : undefined).toBe('one\n');
  });

  it('says a binary file has no text diff', async () => {
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openReview(projectId, checkpointId, 'logo.png'));
    expect(await screen.findByText(/there is no text diff/)).toBeInTheDocument();
  });

  it('gives the area back to a file tab, and back to the review from its tab; × closes it', async () => {
    const user = userEvent.setup();
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await screen.findByRole('tab', { name: /README\.md/ });
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await screen.findByTestId('review-view');

    await user.click(screen.getByRole('tab', { name: /README\.md/ }));
    expect(screen.queryByTestId('review-view')).toBeNull();
    expect(screen.getByRole('tab', { name: /README\.md/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('tab', { name: 'a.ts (agent change)' }));
    expect(await screen.findByTestId('review-view')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /README\.md/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    await user.click(screen.getByRole('button', { name: 'Close a.ts (agent change)' }));
    expect(screen.queryByRole('tab', { name: 'a.ts (agent change)' })).toBeNull();
    expect(useReviewStore.getState().projects[projectId]?.reviews).toEqual([]);
  });

  it('a file opened while reviewing takes the area', async () => {
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await screen.findByTestId('review-view');
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await waitFor(() => expect(screen.queryByTestId('review-view')).toBeNull());
  });

  it('choosing the file already active (Quick Open, the Explorer, a Search result) takes the area back (fix A-M12)', async () => {
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await screen.findByLabelText('Editing README.md');
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await screen.findByTestId('review-view');

    act(() => openFile(projectId, 'README.md', { preview: true }));
    await waitFor(() => expect(screen.queryByTestId('review-view')).toBeNull());
    expect(screen.getByLabelText('Editing README.md')).toBeInTheDocument();
    // the review stays open behind it
    expect(screen.getByRole('tab', { name: 'a.ts (agent change)' })).toBeInTheDocument();
  });

  it('revealing a line takes the area back from the review, and the editor goes to it (fix F-M2)', async () => {
    const { projectId, checkpointId } = seed();
    renderWithQuery(<EditorArea projectId={projectId} />);
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await screen.findByLabelText('Editing README.md');
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await screen.findByTestId('review-view');

    act(() =>
      useEditorStore.getState().revealAt(projectId, { path: 'README.md', line: 1, column: 3 }),
    );
    await waitFor(() => expect(screen.queryByTestId('review-view')).toBeNull());
    // the editor is back to take the line (the real host reveals it; the stand-in only shows)
    expect(screen.getByLabelText('Editing README.md')).toBeInTheDocument();
    expect(useEditorStore.getState().projects[projectId]?.reveal).toEqual({
      path: 'README.md',
      line: 1,
      column: 3,
    });
  });

  it('a Problems row for the active file shows the editor at the problem while a review shows (fix F-M2)', async () => {
    const user = userEvent.setup();
    const { projectId, checkpointId } = seed();
    act(() =>
      useProblemsStore.setState({
        byProject: {
          [projectId]: [
            {
              path: 'README.md',
              line: 1,
              column: 2,
              severity: 'warning',
              message: 'heading style',
              source: 'md',
            },
          ],
        },
      }),
    );
    renderWithQuery(
      <>
        <EditorArea projectId={projectId} />
        <ProblemsView projectId={projectId} />
      </>,
    );
    act(() => openFile(projectId, 'README.md', { preview: false }));
    await screen.findByLabelText('Editing README.md');
    act(() => openReview(projectId, checkpointId, 'src/a.ts'));
    await screen.findByTestId('review-view');

    await user.click(screen.getByRole('button', { name: /heading style/ }));
    await waitFor(() => expect(screen.queryByTestId('review-view')).toBeNull());
    expect(screen.getByLabelText('Editing README.md')).toBeInTheDocument();
    expect(useEditorStore.getState().projects[projectId]?.reveal).toEqual({
      path: 'README.md',
      line: 1,
      column: 2,
    });
    expect(useReviewStore.getState().projects[projectId]?.active).toBeUndefined();
  });
});

describe('D300 agent-change markers in the Explorer', () => {
  it('marks a file waiting for review, apart from git letters; the marker opens Changes on it', async () => {
    const user = userEvent.setup();
    const projectId = db.createProject({ name: 'Shop' }).id;
    const seeded = checkpoints.seed(projectId, [{ path: 'notes.md', before: 'a\n', after: 'b\n' }]);
    const onOpen = vi.fn();
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={onOpen} />);

    const marker = await screen.findByTestId('tree-change-notes.md');
    expect(marker).toHaveAttribute('data-glyph', '±');
    expect(marker).toHaveClass('bg-[#ef6b3f]', 'rounded-full');
    // the glyph is CSS content: the row's text is still its name
    expect(screen.getByTestId('tree-item-notes.md')).toHaveTextContent(/^notes\.md$/);

    await user.click(marker);
    expect(useChangesStore.getState().projects[projectId]).toEqual({
      requested: true,
      focus: seeded.id,
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops the marker once the change is kept', async () => {
    const projectId = db.createProject({ name: 'Shop' }).id;
    const seeded = checkpoints.seed(projectId, [{ path: 'notes.md', before: 'a\n', after: 'b\n' }]);
    renderWithQuery(<FileTree projectId={projectId} label="Files" onOpen={vi.fn()} />);
    await screen.findByTestId('tree-change-notes.md');
    checkpoints.act(projectId, seeded.id, { action: 'keep' });
    // no socket here: a refetch stands in for the frame
    await act(() => queryClient.invalidateQueries({ queryKey: ['checkpoints', projectId] }));
    await waitFor(() => expect(screen.queryByTestId('tree-change-notes.md')).toBeNull());
  });
});
