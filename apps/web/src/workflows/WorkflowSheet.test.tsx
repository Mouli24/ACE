import type { Node } from '@ace/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderWithQuery } from '../test/app';
import { SHEET_ID, WorkflowSheet } from './WorkflowSheet';
import { getGraphSync } from './sync-registry';

installMockServer();

beforeEach(() => usePanelsStore.setState({ sheetOpen: false, sheetTab: 'inspect' }));

function seed() {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Launch post');
  const a = createNode('input', workflow.id, { x: 0, y: 0 });
  a.name = 'Brief';
  const b = createNode('transform', workflow.id, { x: 300, y: 0 });
  b.name = 'Shape';
  db.commitGraph(workflow.id, [a, b], []);
  return { project, workflow, a: a as Node, b: b as Node };
}

function renderSheet(projectId: string, workflowId: string) {
  return renderWithQuery(
    <MemoryRouter initialEntries={[`/projects/${projectId}/workflows/${workflowId}`]}>
      <Routes>
        <Route
          path="/projects/:projectId/workflows/:workflowId"
          element={<WorkflowSheet workflowId={workflowId} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const open = (tab?: Parameters<ReturnType<typeof usePanelsStore.getState>['openSheet']>[0]) =>
  act(() => usePanelsStore.getState().openSheet(tab));
const select = (ids: string[]) => act(() => useSelectionStore.getState().setSelection(ids, []));

describe('D332 / FR-EXE-010 the floating sheet over the Canvas', () => {
  it('renders nothing while closed', () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('openSheet("inspect") opens it on the Inspector; its tabs are Inspector · Runs · Memory', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('inspect');

    const sheet = await screen.findByTestId('workflow-sheet');
    // the theme's panel: surface, a --line border, radius 12, the menu shadow
    expect(sheet).toHaveClass(
      'absolute',
      'z-20',
      'rounded-[12px]',
      'border-[var(--line)]',
      'bg-[var(--surface)]',
      'shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]',
    );
    // a landmark named as the control that opens it, with the id that control points at
    expect(screen.getByRole('region', { name: 'Workflow panel' })).toBe(sheet);
    expect(sheet).toHaveAttribute('id', SHEET_ID);
    // D332: the Configure tab gave way to the node settings modal
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Inspector',
      'Runs',
      'Memory',
    ]);
    expect(screen.queryByRole('tab', { name: 'Configure' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();
  });

  it('opened with no tab of its own (or the old Configure) it shows the Inspector', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open();
    expect(await screen.findByRole('tab', { name: 'Inspector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();
  });

  it('a tab click moves sheetTab', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('inspect');
    await userEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(usePanelsStore.getState().sheetTab).toBe('runs');
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
  });

  it('sheet survives its node being deleted (Review Focus 2)', async () => {
    const { project, workflow, a } = seed();
    renderSheet(project.id, workflow.id);
    select([a.id]);
    open('inspect');
    expect(await screen.findByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();

    // the node goes from the graph while the selection still points at it
    act(() =>
      getGraphSync(workflow.id, queryClient).enqueue([{ op: 'delete_node', nodeId: a.id }]),
    );

    await waitFor(() => expect(screen.getByTestId('workflow-sheet')).toBeInTheDocument());
    // every tab renders its own empty state for it rather than throwing
    expect(screen.getByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
  });

  it('insets its content once: the body’s 18 px, none of the contents’ own', async () => {
    const user = userEvent.setup();
    const { project, workflow, a } = seed();
    renderSheet(project.id, workflow.id);
    select([a.id]);
    open('inspect');
    expect(await screen.findByTestId('workflow-sheet-body')).toHaveClass(
      'px-[18px]',
      'pb-[18px]',
      'pt-1.5',
    );

    const unpadded = (element: HTMLElement) => expect(element.className).not.toMatch(/(^|\s)p-\d/);
    unpadded(screen.getByTestId('inspector'));
    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    unpadded(await screen.findByText(/No runs yet/));
    await user.click(screen.getByRole('tab', { name: 'Memory' }));
    unpadded(await screen.findByTestId('memory-tab-not-agent'));
  });

  it('the 28px close (“Close panel”) calls closeSheet', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('runs');
    const close = await screen.findByRole('button', { name: 'Close panel' });
    expect(close).toHaveClass('h-7', 'w-7');
    // PG-1.2 (D360): an SVG X, not the ✕ glyph
    expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await userEvent.click(close);
    expect(usePanelsStore.getState().sheetOpen).toBe(false);
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
  });
});
