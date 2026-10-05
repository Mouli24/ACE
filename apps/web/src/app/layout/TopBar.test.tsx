import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../../test/app';
import { usePanelsStore } from '../stores/panels';

installMockServer();

vi.mock('../../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

afterEach(() => {
  usePanelsStore.setState({ sheetOpen: false, newNodeOpen: false });
});

describe('TopBar (V2)', () => {
  it('New node opens the dialog through the panels store on a Canvas', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    await user.click(await screen.findByTestId('new-node-button'));
    expect(usePanelsStore.getState().newNodeOpen).toBe(true);
  });

  it('has no New node or panel toggle off a Canvas', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    await screen.findByTestId('project-name');
    expect(screen.queryByTestId('new-node-button')).toBeNull();
    expect(screen.queryByTestId('sheet-toggle')).toBeNull();
  });

  it('the panel toggle opens and closes the sheet', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    const toggle = await screen.findByTestId('sheet-toggle');
    expect(toggle).toHaveAccessibleName('Workflow panel');
    await user.click(toggle);
    await waitFor(() => expect(usePanelsStore.getState().sheetOpen).toBe(true));
    await user.click(toggle);
    await waitFor(() => expect(usePanelsStore.getState().sheetOpen).toBe(false));
  });

  it('keeps Usage, Guardrail policies, Settings and Help reachable by name', async () => {
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    for (const name of ['Usage', 'Guardrail policies', 'Settings', 'Help']) {
      expect(await screen.findByRole('link', { name })).toBeInTheDocument();
    }
  });
});
