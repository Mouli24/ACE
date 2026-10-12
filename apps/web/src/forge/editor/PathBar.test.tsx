import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRunStore } from '../../runs/run-store';
import { db, installMockServer, renderWithQuery } from '../../test/app';
import type { FileTouch } from '../attribution';
import { openFile } from './actions';
import { useEditorStore } from './editor-store';
import { ensureModel } from './models';
import { PathBar } from './PathBar';

installMockServer();

let projectId: string;
let workflowId: string;
beforeEach(() => {
  useRunStore.getState().reset();
  const project = db.createProject({ name: 'My Shop' });
  projectId = project.id;
  workflowId = db.createWorkflow(project.id, 'Main').id;
});

/** An open text file with its buffer, as the editor host leaves it. */
function openText(path: string, text: string) {
  openFile(projectId, path);
  const model = ensureModel(projectId, path, text, 'plaintext', () => undefined);
  useEditorStore.getState().loaded(projectId, path, 'v1', false);
  return model;
}

const touch = (edit: string[] | undefined): FileTouch => ({
  agent: { nodeId: 'n1', name: 'Writer', letter: 'W', color: '#7a62d6', index: 1 },
  at: new Date().toISOString(),
  edit,
});

describe('D334 the path bar', () => {
  it('shows the project slug and the path as crumbs, the last one in ink', async () => {
    act(() => void openText('src/lib/app.ts', 'x'));
    renderWithQuery(<PathBar projectId={projectId} path="src/lib/app.ts" />);
    const bar = screen.getByTestId('path-bar');
    expect(bar).toHaveClass('h-[34px]', 'font-machine', 'text-[11px]');
    await within(bar).findByText('my-shop');
    const crumbs = within(bar).getAllByTestId('crumb');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['my-shop', 'src', 'lib', 'app.ts']);
    expect(crumbs.at(-1)).toHaveClass('text-[var(--ink)]');
    expect(crumbs[0]).toHaveClass('text-[var(--muted)]');
    expect(within(bar).getAllByText('›')).toHaveLength(3);
  });

  it('says which agent wrote the file and which lines, from the run', () => {
    act(() => void openText('a.ts', 'one\ntwo\nthree'));
    renderWithQuery(<PathBar projectId={projectId} path="a.ts" touch={touch(undefined)} />);
    expect(screen.getByTestId('path-touch')).toHaveTextContent(
      'WWriter edited lines 1–3 · Just now',
    );
  });

  it('finds an edit’s new text in the buffer and follows it as the buffer changes', () => {
    let model: ReturnType<typeof openText> | undefined;
    act(() => {
      model = openText('a.ts', 'one\ntwo\nthree');
    });
    renderWithQuery(<PathBar projectId={projectId} path="a.ts" touch={touch(['two'])} />);
    expect(screen.getByTestId('path-touch')).toHaveTextContent('edited lines 2–2');
    act(() => model?.setValue('zero\none\ntwo'));
    expect(screen.getByTestId('path-touch')).toHaveTextContent('edited lines 3–3');
    // the edit's text is gone: no claim about any lines
    act(() => model?.setValue('rewritten'));
    expect(screen.queryByTestId('path-touch')).toBeNull();
  });

  it('shows no attribution when no agent wrote the file', () => {
    act(() => void openText('a.ts', 'x'));
    renderWithQuery(<PathBar projectId={projectId} path="a.ts" />);
    expect(screen.queryByTestId('path-touch')).toBeNull();
  });
});

describe('D334 ▶ Run pipeline', () => {
  it('starts the workflow’s run', async () => {
    const user = userEvent.setup();
    act(() => void openText('a.ts', 'x'));
    renderWithQuery(<PathBar projectId={projectId} workflowId={workflowId} path="a.ts" />);
    const run = screen.getByRole('button', { name: 'Run pipeline' });
    expect(run).toHaveClass('h-[24px]', 'rounded-[999px]', 'bg-[var(--chip)]');
    await user.click(run);
    expect(useRunStore.getState().workflowId).toBe(workflowId);
    await waitFor(() => expect(db.listRuns(workflowId)).toHaveLength(1));
  });

  it('is disabled while a run of this workflow is going', () => {
    act(() => {
      openText('a.ts', 'x');
      useRunStore.getState().arm(workflowId);
    });
    renderWithQuery(<PathBar projectId={projectId} workflowId={workflowId} path="a.ts" />);
    expect(screen.getByRole('button', { name: 'Run pipeline' })).toBeDisabled();
    act(() => useRunStore.getState().reset());
    expect(screen.getByRole('button', { name: 'Run pipeline' })).toBeEnabled();
  });

  it('is not there without a workflow to run', () => {
    act(() => void openText('a.ts', 'x'));
    renderWithQuery(<PathBar projectId={projectId} path="a.ts" />);
    expect(screen.queryByRole('button', { name: 'Run pipeline' })).toBeNull();
  });
});
