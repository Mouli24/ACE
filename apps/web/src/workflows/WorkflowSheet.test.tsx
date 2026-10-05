import type { Node } from '@ace/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { db, installMockServer, queryClient, renderWithQuery } from '../test/app';
import { WorkflowSheet } from './WorkflowSheet';
import { getGraphSync } from './sync-registry';

installMockServer();

vi.mock('../config-panel/monaco-loader', () => ({
  MonacoEditor: ({ 'aria-label': label }: { 'aria-label'?: string }) => (
    <textarea aria-label={label ?? 'JSON schema'} data-testid="monaco" />
  ),
}));

beforeEach(() => usePanelsStore.setState({ sheetOpen: false, sheetTab: 'configure' }));

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

describe('FR-NODE-002 / FR-EXE-010 the floating sheet over the Canvas', () => {
  it('renders nothing while closed', () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('openSheet("inspect") opens it on the Inspector tab; its tabs are Configure · Inspector · Runs · Memory', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('inspect');

    const sheet = await screen.findByTestId('workflow-sheet');
    expect(sheet).toHaveClass('absolute', 'right-3', 'top-3', 'bottom-3', 'z-20', 'bg-panel');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Configure',
      'Inspector',
      'Runs',
      'Memory',
    ]);
    expect(screen.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();
  });

  it('a tab click moves sheetTab', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('configure');
    await userEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(usePanelsStore.getState().sheetTab).toBe('runs');
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
  });

  it('follows the selection: selecting node B while open shows B’s config', async () => {
    const { project, workflow, a, b } = seed();
    renderSheet(project.id, workflow.id);
    select([a.id]);
    open('configure');
    expect(await screen.findByLabelText('Name')).toHaveValue('Brief');

    select([b.id]);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Shape'));
  });

  it('sheet survives its node being deleted (Review Focus 2)', async () => {
    const { project, workflow, a } = seed();
    renderSheet(project.id, workflow.id);
    select([a.id]);
    open('configure');
    expect(await screen.findByLabelText('Name')).toHaveValue('Brief');

    // the node goes from the graph while the selection still points at it
    act(() =>
      getGraphSync(workflow.id, queryClient).enqueue([{ op: 'delete_node', nodeId: a.id }]),
    );

    expect(await screen.findByText(/Select a node to configure it\./)).toBeInTheDocument();
    expect(screen.getByTestId('workflow-sheet')).toBeInTheDocument();
    // and the other tabs render their own empty state for it rather than throwing
    await userEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(screen.getByRole('region', { name: 'Node run inspector' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the close button (“Close panel”) calls closeSheet', async () => {
    const { project, workflow } = seed();
    renderSheet(project.id, workflow.id);
    open('runs');
    await userEvent.click(await screen.findByRole('button', { name: 'Close panel' }));
    expect(usePanelsStore.getState().sheetOpen).toBe(false);
    expect(screen.queryByTestId('workflow-sheet')).toBeNull();
  });
});
